import {
  fileReviewModelOutputSchema,
  parsedReviewCommentSchema,
  toClaimType,
  CLAIM_TYPE_CATEGORY,
  type ClaimType,
  type ParsedReviewComment,
  reviewSeverities,
} from '@shared/schema';
import { renderDiffSnippet } from '@server/prompts/verify';
import { logger } from '../logger';
import { z } from 'zod';
import { findPositionForLine, getValidPositions, type DiffLine, type FileDiff } from '../diff';
import {
  buildAnchorHash,
  buildFindingFingerprint,
  buildFindingFingerprintV2,
} from '../fingerprint';
import {
  buildPresenceIndex,
  checkAbsenceClaim,
  isVersionClaimRefutedByPin,
  looksLikeExternalVersionClaim,
} from '../claim-checks';
import { parseRawPayload } from './json';
import {
  type BinAmbiguityIndex,
  type EvidenceIndex,
  buildEvidenceIndex,
  foldFirstEvidenceLine,
  resolveEvidence,
} from './evidence';

// Tolerates the prefix noise models add to paths (`./src/a.ts`, `b/src/a.ts`, `/src/a.ts`).
export function samePath(a: string, b: string): boolean {
  const strip = (p: string) => p.trim().replace(/^\.\//, '').replace(/^[ab]\//, '').replace(/^\//, '');
  return strip(a) === strip(b);
}

export type BinAmbiguity = {
  index: BinAmbiguityIndex;
  // Path of the entry enclosing the finding being grounded.
  filePath: string;
  stats: { ambiguousAcrossBin: number };
};

function withSuggestion(body: string, codeSuggestion?: string) {
  if (!codeSuggestion) return body;

  const cleanSuggestion = codeSuggestion.replace(/```suggestion\n?|```/g, '').trim();

  const cleanBody = body.split('```suggestion')[0].trim();

  return `${cleanBody}\n\n\`\`\`suggestion\n${cleanSuggestion}\n\`\`\``;
}

// Relabels an `other` finding when its vocabulary is unmistakable, so the denylist can see it. Deliberately excludes react_missing_cleanup/resource_leak/null_or_undefined_deref: that vocabulary also appears in legitimate `other` findings.
const CLAIM_TYPE_REPAIRS: ReadonlyArray<{ pattern: RegExp; claimType: ClaimType }> = [
  { pattern: /dependenc(?:y|ies)\s+array|exhaustive[- ]deps/i, claimType: 'react_hook_missing_deps' },
  { pattern: /redos|catastrophic backtrack|exponential backtrack/i, claimType: 'redos_regex' },
];

function repairClaimType(claimType: ClaimType, title: string, body: string, onRepair: () => void): ClaimType {
  if (claimType !== 'other') return claimType;
  const text = `${title}\n${body}`;

  // Version claims arrive labelled `other`, and every one in the corpus has been false.
  if (looksLikeExternalVersionClaim(title, body)) {
    onRepair();
    return 'external_version_claim';
  }

  for (const { pattern, claimType: repaired } of CLAIM_TYPE_REPAIRS) {
    if (pattern.test(text)) {
      onRepair();
      return repaired;
    }
  }
  return claimType;
}

type RawFinding = z.infer<typeof fileReviewModelOutputSchema>['findings'][number];

// Dropped finding for the off-diff list. Only the position-validation drop omits `tag`.
type Withheld = { title: string; body: string; tag?: string };

function formatWithheld(w: Withheld): string {
  return w.tag ? `- **[${w.tag}] ${w.title}:** ${w.body}` : `- **${w.title}:** ${w.body}`;
}

// Stage 2: resolve the evidence quote against the diff; only a match passes, on every provider.
// unmatched = discriminating but absent, weak = under 8 normalized chars, absent = no quote.
function groundFindingInEvidence(
  finding: RawFinding,
  evidenceIndex: EvidenceIndex,
  evidenceStats: { total: number; matched: number; unmatched: number; weak: number; absent: number },
  ambiguity?: BinAmbiguity,
): { diffLine: DiffLine } | { withheld: Withheld } {
  const reportedLine = finding.code_location.line || finding.code_location.line_range?.start;

  evidenceStats.total += 1;
  const evidence = resolveEvidence(finding.evidence, evidenceIndex, reportedLine);
  if (evidence.status === 'matched') evidenceStats.matched += 1;
  else if (evidence.status === 'unmatched') evidenceStats.unmatched += 1;
  else if (evidence.status === 'weak') evidenceStats.weak += 1;
  else if (evidence.status === 'absent') evidenceStats.absent += 1;

  if (evidence.status !== 'matched') {
    return { withheld: { title: finding.title, body: finding.body, tag: `unverified:${evidence.status}` } };
  }

  // Batch path only: a quote shared across packed files PLUS a mismatched claimed path means a misfiled finding. Either signal alone is ordinary.
  if (ambiguity) {
    const firstLine = foldFirstEvidenceLine(finding.evidence);
    const claimedPath = finding.code_location.absolute_file_path?.trim();
    const ambiguousAcrossBin = firstLine ? (ambiguity.index.get(firstLine) ?? 0) > 1 : false;
    if (ambiguousAcrossBin && claimedPath && !samePath(claimedPath, ambiguity.filePath)) {
      ambiguity.stats.ambiguousAcrossBin += 1;
      return {
        withheld: {
          title: finding.title,
          body: finding.body,
          tag: 'unverified:ambiguous-across-bin',
        },
      };
    }
  }

  // Anchor comes from the matched quote; `code_location.line` only disambiguates repeated lines.
  return { diffLine: evidence.line };
}

// Stage 3: anchors a grounded evidence line to a concrete, postable diff position.
function anchorToDiffPosition(
  file: FileDiff,
  diffLine: DiffLine,
  validPositions: Set<number>,
  finding: RawFinding,
): { line: number; position: number } | { withheld: Withheld } {
  const line = diffLine.newLineNumber!;
  const position = findPositionForLine(file, line);

  if (position === undefined || !validPositions.has(position)) {
    return { withheld: { title: finding.title, body: finding.body } };
  }

  return { line, position };
}

// Stage 4: normalize raw priority/title/body, independent of evidence and claim-type decisions.
function validateFindingShape(finding: RawFinding): { severity: typeof reviewSeverities[number]; title: string; body: string } {
  const priorityMap: Record<number, typeof reviewSeverities[number]> = {
    0: 'P0',
    1: 'P1',
    2: 'P2',
    3: 'P3',
    4: 'nit',
  };
  // Missing priority falls back to P3 rather than dropping a possible P0.
  const severity = finding.priority !== undefined
    ? priorityMap[finding.priority] || 'P3'
    : 'P3';

  const cleanText = (text: string) => {
    let current = text.trim();
    let prev = '';
    while (current !== prev) {
      prev = current;
      current = current
        .replace(/^(?:[^\w\s]+|(?:QUALITY|SECURITY|BUG|PERFORMANCE|CORRECTNESS|P[0-3]|NIT)\b)+/giu, '')
        .replace(/\n\s*/g, ' ')
        .trim();
    }
    return current;
  };

  const title = cleanText(finding.title);
  let body = cleanText(finding.body);

  const bodyPrefix = cleanText(body.split('\n')[0]);
  if (bodyPrefix.toLowerCase().startsWith(title.toLowerCase()) || title.toLowerCase().startsWith(bodyPrefix.toLowerCase())) {
    body = cleanText(body.slice(body.split('\n')[0].length));
  }

  return { severity, title, body };
}

// Stage 5: resolve the claim type, then enforce the denylist and pinned-SHA refutation. Counts update BEFORE the deny check, or a working denylist would tally identically to an idle one.
function applyClaimGate(
  finding: RawFinding,
  title: string,
  body: string,
  anchorContent: string,
  deniedClaimTypes: Set<ClaimType>,
  claimTypeCounts: Record<string, number>,
  deniedClaimCounts: Record<string, number>,
): { claimType: ClaimType } | { withheld: Withheld } {
  // Coerce to 'other' rather than throw: a Zod rejection discards the whole file over one bad label.
  const claimType = repairClaimType(toClaimType(finding.claim_type), title, body, () => {
    claimTypeCounts.__repaired = (claimTypeCounts.__repaired ?? 0) + 1;
  });

  claimTypeCounts[claimType] = (claimTypeCounts[claimType] ?? 0) + 1;

  if (deniedClaimTypes.has(claimType)) {
    deniedClaimCounts[claimType] = (deniedClaimCounts[claimType] ?? 0) + 1;
    return { withheld: { title, body, tag: `claim-denied:${claimType}` } };
  }

  // A full commit SHA pin refutes a version claim outright.
  if (isVersionClaimRefutedByPin({ title, body, anchorContent })) {
    deniedClaimCounts.version_claim_on_pinned_sha = (deniedClaimCounts.version_claim_on_pinned_sha ?? 0) + 1;
    return { withheld: { title, body, tag: 'refuted:pinned-sha' } };
  }

  return { claimType };
}

// Stage 6: assemble the persisted comment. Absence-check stats are SHADOW: counted, never acted on. Promote to a drop only once `refuted` is non-zero on real claims and the gold set passes.
function buildParsedComment(params: {
  file: FileDiff;
  line: number;
  position: number;
  severity: typeof reviewSeverities[number];
  title: string;
  body: string;
  claimType: ClaimType;
  anchorContent: string;
  finding: RawFinding;
  presenceIndex: ReturnType<typeof buildPresenceIndex>;
  absenceCheckStats: { absenceShaped: number; identifierExtracted: number; refuted: number };
}): ParsedReviewComment {
  const { file, line, position, severity, title, body, claimType, anchorContent, finding, presenceIndex, absenceCheckStats } = params;

  const absence = checkAbsenceClaim({ title, body, anchorLine: line, index: presenceIndex });
  if (absence.status === 'refuted') {
    absenceCheckStats.absenceShaped += 1;
    absenceCheckStats.identifierExtracted += 1;
    absenceCheckStats.refuted += 1;
  } else if (absence.reason !== 'not_absence_shaped') {
    absenceCheckStats.absenceShaped += 1;
    if (absence.reason !== 'no_identifier' && absence.reason !== 'ambiguous_identifier') {
      absenceCheckStats.identifierExtracted += 1;
    }
  }

  // Never `undefined`: the gate fires on typeof==='number', so an omission would sail past it.
  const confidenceScore = typeof finding.confidence_score === 'number'
    ? finding.confidence_score
    : 0;

  return parsedReviewCommentSchema.parse({
    path: file.path,
    line,
    position,
    severity,
    // Derived, never model-emitted: asking produced 'quality' on all 705 rows.
    category: CLAIM_TYPE_CATEGORY[claimType],
    claimType,
    // Unrecoverable later: 003 nulls diff_input and the KV diff cache expires after 6h.
    contextSnippet: renderDiffSnippet(file, line) || undefined,
    title,
    body: withSuggestion(body, finding.code_suggestion),
    codeSuggestion: finding.code_suggestion,
    confidenceScore,
    evidence: typeof finding.evidence === 'string' && finding.evidence.trim() ? finding.evidence.trim() : undefined,
    fingerprint: buildFindingFingerprint(file.path, title),
    anchorHash: anchorContent ? buildAnchorHash(anchorContent) : undefined,
    // Title-independent identity, OR-matched with the first so a reworded repeat is still recognised.
    fingerprintV2: buildFindingFingerprintV2(
      file.path,
      claimType,
      anchorContent ? buildAnchorHash(anchorContent) : undefined,
    ) ?? undefined,
  });
}

// One file's worth of extracted output, so the batch path can hand-build it per file instead of going through the single-file `parseRawPayload`.
export type FileReviewPayload = z.infer<typeof fileReviewModelOutputSchema>;

export type GroundingOptions = {
  // Rejected outright. Enforced here, not in the grammar: only Workers AI and Google AI Studio honor the schema.
  deniedClaimTypes?: readonly ClaimType[];
  // Batch path only.
  ambiguity?: BinAmbiguity;
};

export type GroundedFileReview = {
  comments: ParsedReviewComment[];
  verdict: 'approve' | 'comment';
  fileSummary: string;
  overallCorrectness?: string;
  confidenceScore?: number;
  evidenceStats: { total: number; matched: number; unmatched: number; weak: number; absent: number };
  claimTypeCounts: Record<string, number>;
  // Denied per type; these also appear in `claimTypeCounts`.
  deniedClaimCounts: Record<string, number>;
  // Absence-check funnel, shadow-only; three counters keep refuted:0 distinct from "never fired".
  absenceCheckStats: { absenceShaped: number; identifierExtracted: number; refuted: number };
};

// Grounding is per file, never per response: the indexes come from one `FileDiff`. Split out of `parseFileReviewResponse` so batches can reuse it per file.
export function groundParsedFindings(
  parsed: FileReviewPayload,
  file: FileDiff,
  options?: GroundingOptions,
): GroundedFileReview {
  const validPositions = getValidPositions(file);
  const evidenceIndex = buildEvidenceIndex(file);
  const evidenceStats = { total: 0, matched: 0, unmatched: 0, weak: 0, absent: 0 };
  const claimTypeCounts: Record<string, number> = {};
  const deniedClaimCounts: Record<string, number> = {};
  const deniedClaimTypes = new Set<ClaimType>(options?.deniedClaimTypes ?? []);
  const presenceIndex = buildPresenceIndex(file);
  const absenceCheckStats = { absenceShaped: 0, identifierExtracted: 0, refuted: 0 };
  const orphanedComments: string[] = [];

  const comments = (parsed.findings || [])
    .map((finding): ParsedReviewComment | null => {
      const grounded = groundFindingInEvidence(finding, evidenceIndex, evidenceStats, options?.ambiguity);
      if ('withheld' in grounded) {
        orphanedComments.push(formatWithheld(grounded.withheld));
        return null;
      }

      const anchored = anchorToDiffPosition(file, grounded.diffLine, validPositions, finding);
      if ('withheld' in anchored) {
        orphanedComments.push(formatWithheld(anchored.withheld));
        return null;
      }

      const { severity, title, body } = validateFindingShape(finding);

      // Anchor on content, not line number: an edit above shifts it, an edit TO the line must re-raise.
      const anchorContent = grounded.diffLine.content
        ?? file.hunks.flatMap((h) => h.lines).find((l) => l.newLineNumber === anchored.line)?.content
        ?? '';

      const gated = applyClaimGate(finding, title, body, anchorContent, deniedClaimTypes, claimTypeCounts, deniedClaimCounts);
      if ('withheld' in gated) {
        orphanedComments.push(formatWithheld(gated.withheld));
        return null;
      }

      // Contained per finding: under batching, propagating would discard the rest of the bin.
      try {
        return buildParsedComment({
          file,
          line: anchored.line,
          position: anchored.position,
          severity,
          title,
          body,
          claimType: gated.claimType,
          anchorContent,
          finding,
          presenceIndex,
          absenceCheckStats,
        });
      } catch (error) {
        // ZodError only: a wider catch would swallow systemic failures.
        if (!(error instanceof z.ZodError)) throw error;

        orphanedComments.push(formatWithheld({
          title: finding.title,
          body: finding.body,
          tag: 'unverified:unassemblable',
        }));
        logger.warn('Dropped a finding that could not be assembled', {
          path: file.path,
          title: finding.title,
          error: error.message,
        });
        return null;
      }
    })
    .filter((comment): comment is ParsedReviewComment => Boolean(comment));

  const verdict = parsed.overall_correctness.toLowerCase().includes('patch is correct') ? 'approve' : 'comment';
  let fileSummary = parsed.overall_explanation;

  if (orphanedComments.length > 0) {
    fileSummary += `\n\n### Additional Comments (Off-diff)\n${orphanedComments.join('\n')}`;
  }

  return {
    comments,
    verdict: comments.length > 0 ? 'comment' : verdict,
    fileSummary,
    overallCorrectness: parsed.overall_correctness,
    confidenceScore: parsed.overall_confidence_score,
    evidenceStats,
    claimTypeCounts,
    deniedClaimCounts,
    absenceCheckStats,
  };
}

// Provider-independent by design: gating these on a Cloudflare-only flag once disabled the evidence gate and min_confidence on the Google chain.
export function parseFileReviewResponse(
  raw: string,
  file: FileDiff,
  options?: GroundingOptions,
): GroundedFileReview {
  return groundParsedFindings(parseRawPayload(raw), file, options);
}


export { dedupeFindings } from './dedupe';
export {
  isNonAnswerReview,
  NON_ANSWER_MAX_RESPONSE_CHARS,
  NON_ANSWER_MIN_DIFF_LINES,
} from './non-answer';
export { parseRawBatchPayload, type RawBatchPayload } from './json-batch';
export { parseBatchReviewResponse, type BatchParseStats, type BatchReviewResult } from './batch';
