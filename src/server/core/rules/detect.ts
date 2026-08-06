import type { ClaimType, ParsedReviewComment } from '@shared/schema';
import type { DiffLine, FileDiff } from '../diff';
import { commentSyntaxFor, stripCommentsAndStrings } from '../claim-checks';
import { buildAnchorHash, buildFindingFingerprint, buildFindingFingerprintV2, normalizeDiffText } from '../fingerprint';
import { CLAIM_TYPE_CATEGORY } from '@shared/schema';
import { RULES, type Rule } from './table';

// Hard cap on added lines scanned per file. A 10ms CPU budget is the binding constraint, not memory,
// and a 4,000-line file is exactly where a regex sweep would blow it. Reported as `truncated` rather
// than silently applied.
const MAX_RULE_SCAN_ADDED_LINES = 600;

export type RuleHit = {
  rule: Rule;
  line: DiffLine;
  // Set when the rule is in shadow mode: counted and logged, never turned into a comment.
  shadow: boolean;
};

export type RuleScanStats = {
  addedLinesScanned: number;
  // Lines that passed the cheap substring sieve and were actually stripped + regex-tested.
  sievePassed: number;
  hits: number;
  shadowHits: number;
  // Hits discarded because the identical line already existed as a `del` - the PR only moved it.
  suppressedAsMoved: number;
  // Lines the stripper refused to scan (unterminated quote / unclosed block comment).
  unstrippable: number;
  truncated: boolean;
  byRule: Record<string, number>;
};

export type RuleScanResult = { hits: RuleHit[]; stats: RuleScanStats };

export type RuleScanOptions = {
  disabledRuleIds?: readonly string[];
  shadowRuleIds?: readonly string[];
  deniedClaimTypes?: readonly ClaimType[];
};

function extensionOf(path: string) {
  return path.toLowerCase().split('.').pop() ?? '';
}

function ruleApplies(rule: Rule, ext: string) {
  return !rule.extensions || rule.extensions.includes(ext);
}

// Scans a file's added lines for deterministic rule hits.
//
// Costs zero subrequests and no model call, which is the point: this channel still produces findings
// when the LLM returns nothing, and when the file's review fails outright.
export function scanFileForRuleHits(file: FileDiff, options: RuleScanOptions = {}): RuleScanResult {
  const stats: RuleScanStats = {
    addedLinesScanned: 0,
    sievePassed: 0,
    hits: 0,
    shadowHits: 0,
    suppressedAsMoved: 0,
    unstrippable: 0,
    truncated: false,
    byRule: {},
  };
  const hits: RuleHit[] = [];

  if (file.isDeleted || file.isBinary || !file.path) return { hits, stats };

  const ext = extensionOf(file.path);
  const denied = new Set(options.deniedClaimTypes ?? []);
  const disabled = new Set(options.disabledRuleIds ?? []);
  const shadowIds = new Set(options.shadowRuleIds ?? []);

  const active = RULES.filter((rule) =>
    rule.enabled
    && !disabled.has(rule.id)
    && !denied.has(rule.claimType)
    && ruleApplies(rule, ext));
  if (active.length === 0) return { hits, stats };

  // One flat sieve over every active rule's triggers. `indexOf` on a handful of short substrings is
  // orders of magnitude cheaper than running the regexes, and it rejects >95% of real lines.
  const triggers = [...new Set(active.flatMap((rule) => rule.triggers))];
  const syntax = commentSyntaxFor(file.path);

  for (const hunk of file.hunks) {
    // Same discipline as buildPresenceIndex: a hit on a removed line is a report about code the PR
    // deleted. Collected per hunk so reformat-move suppression can compare within the same window.
    const removed = new Set(
      hunk.lines.filter((l) => l.kind === 'del').map((l) => normalizeDiffText(l.content)),
    );

    for (const line of hunk.lines) {
      if (line.kind !== 'add') continue;
      if (stats.addedLinesScanned >= MAX_RULE_SCAN_ADDED_LINES) {
        stats.truncated = true;
        break;
      }
      stats.addedLinesScanned += 1;

      const raw = line.content;
      if (!triggers.some((trigger) => raw.includes(trigger))) continue;
      stats.sievePassed += 1;

      const stripped = stripCommentsAndStrings(raw, syntax);
      if (stripped === null) {
        stats.unstrippable += 1;
        continue;
      }

      for (const rule of active) {
        if (!rule.triggers.some((trigger) => raw.includes(trigger))) continue;
        if (!rule.pattern.test(stripped)) continue;
        if (rule.rejectRaw?.test(raw)) continue;

        // The "defect" pre-existed and the PR only moved or reindented the line.
        if (removed.has(normalizeDiffText(raw))) {
          stats.suppressedAsMoved += 1;
          continue;
        }

        const shadow = shadowIds.has(rule.id);
        hits.push({ rule, line, shadow });
        stats.byRule[rule.id] = (stats.byRule[rule.id] ?? 0) + 1;
        if (shadow) stats.shadowHits += 1;
        else stats.hits += 1;
        // One hit per line: two rules firing on one line would post two comments at one anchor.
        break;
      }
    }
    if (stats.truncated) break;
  }

  return { hits, stats };
}

// Turns rule hits into the same `ParsedReviewComment` shape the LLM channel produces, so everything
// downstream - suppression, verification, the cap, the dashboard - treats them uniformly.
//
// The fingerprint deliberately includes the anchor hash. `buildFindingFingerprint(path, title)` is
// f(path, title) and a rule's title is a CONSTANT, so two hits of one rule in one file would collide
// on a single identity: one row's disposition would be written for both, and suppression would retire
// both when one posted. Mixing the anchor in keeps them distinct - and this changes no existing hash,
// because no LLM finding takes this path.
export function ruleHitsToComments(file: FileDiff, result: RuleScanResult): ParsedReviewComment[] {
  return result.hits
    .filter((hit) => !hit.shadow)
    .map((hit) => {
      const anchorHash = buildAnchorHash(hit.line.content);
      return {
        path: file.path,
        line: hit.line.newLineNumber ?? null,
        position: hit.line.position ?? null,
        severity: hit.rule.severity,
        category: CLAIM_TYPE_CATEGORY[hit.rule.claimType] ?? 'quality',
        title: hit.rule.title,
        body: hit.rule.body,
        evidence: hit.line.content,
        anchorHash,
        claimType: hit.rule.claimType,
        fingerprint: buildFindingFingerprint(file.path, `${hit.rule.title} @${anchorHash}`),
        fingerprintV2: buildFindingFingerprintV2(file.path, hit.rule.claimType, anchorHash),
        source: 'rule' as const,
        ruleId: hit.rule.id,
      } satisfies ParsedReviewComment;
    });
}
