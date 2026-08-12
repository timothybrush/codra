// SOUNDNESS, binding on every change: `refuted` asserts only that "X does not appear" is FALSE. There is no `confirmed` verdict, since a check that can confirm findings manufactures them. Losing a refutation is free; a wrong one silences a real defect.
import type { DiffLine, FileDiff } from './diff';
import { normalizeDiffText } from './fingerprint';

// Refute only when the identifier turns up in the same hunk, or this close in the new file.
const PROXIMITY_WINDOW_LINES = 25;

// Shorter than this and an identifier is too generic to carry a refutation.
const MIN_IDENTIFIER_LENGTH = 3;

// Anchored on verbs, not bare "missing": that also matches undecidable claims like "missing error handling".
const ABSENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:never|not|no longer)\s+(?:being\s+)?(?:passed|provided|supplied|forwarded|included|used|called|invoked|awaited|checked|set|declared|defined|imported)\b/i,
  /\bdoes not\s+(?:pass|include|call|use|await|check|set|import)\b/i,
  /\bfails to\s+(?:pass|include|call|await|check|import)\b/i,
  /\bwithout\s+(?:passing|including|calling|awaiting|checking|importing)\b/i,
  /\b(?:missing|omitted|absent)\b/i,
  /\bis not defined\b/i,
];

// Never refute on these: finding `await` elsewhere does not refute "`await` is missing".
const IDENTIFIER_STOPLIST = new Set([
  'await', 'async', 'if', 'else', 'try', 'catch', 'finally', 'return', 'throw', 'new', 'const',
  'let', 'var', 'function', 'class', 'this', 'super', 'import', 'export', 'from', 'default',
  'null', 'undefined', 'true', 'false', 'void', 'typeof', 'instanceof', 'delete', 'yield',
  'props', 'state', 'error', 'err', 'data', 'value', 'key', 'id', 'type', 'name', 'index',
  'result', 'response', 'request', 'req', 'res', 'params', 'options', 'config', 'args',
]);

// Wording that marks a claim as about an external version or config key, not the code shown.
const VERSION_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:does not|doesn't|do not|don't)\s+exist\b/i,
  /\b(?:non-?existent|nonexistent)\b/i,
  /\bis not a valid\b/i,
  /\blatest (?:major )?version\b/i,
  /\bno such (?:version|tag|release)\b/i,
  /\bnot a valid (?:configuration )?(?:option|key|property)\b/i,
  // A claim about what an installed library's API offers is the same kind of claim as one about a
  // version: it is settled by node_modules, not by the diff. Added after a P0 on codra's own PR #86
  // asserted that `z.uuid()` "does not expose" a top-level validator and would throw at runtime --
  // Zod 4 has had it since the 4.0 release, and the suggested fix reverted to the deprecated form.
  // "does not exist" was already covered; the miss was purely the verb.
  /\b(?:does not|doesn't|do not|don't)\s+(?:expose|provide|have|support|include|offer)\b/i,
  /\bno such (?:function|method|export|property|api|field)\b/i,
  /\bis not (?:exposed|exported|available) (?:by|from|in)\b/i,
];

// ---- Undecidable-claim refutations ---------------------------------------------------------------
// CLAIM_TYPE_DECIDABILITY answers "can this be settled from a diff hunk?" per claim TYPE, which leaves
// `other` -- the deliberate escape hatch, marked diff_local -- carrying whatever a model wants to
// assert. These answer the same question per CLAIM, for the two families that recur:
//
//   cross-file    the claim's consequence lands in a file that is not in the diff
//   environment   the claim is conditional on a runtime, framework or engine version not shown
//
// Both are already forbidden by the review prompt in prose; on codra's own PR #86 the models ignored
// that instruction four times in one review, and the verification pass confirmed every one of them
// (generator and verifier share a knowledge gap, so verification cannot close it).
//
// Same soundness rule as the absence checker above: a refutation asserts only that the claim cannot be
// settled HERE, never that the code is fine. Losing one is free; a wrong one silences a real defect.

// The claim reaches for consumers it cannot see: "other modules", "downstream callers".
const CROSS_FILE_SUBJECT = /\b(?:other|another|external|downstream|consuming|importing|dependent|calling)\s+(?:module|file|component|caller|package|consumer|import)s?\b/i;
const CROSS_FILE_CONSEQUENCE = /\b(?:break|breaks|breaking|broken|fail|fails|failing|error|errors|cannot import|can't import|unable to|compilation|compile|prevent|prevents|preventing|block|blocks|blocking)\b/i;

// Hedged, and hedged specifically about where the code runs rather than about what it does.
const ENVIRONMENT_HEDGE = /\b(?:depending on|might not|may not|could be undefined|if (?:this|the|it)\b[^.]{0,60}\b(?:is )?(?:rendered|run|executed|used)\b)/i;
const ENVIRONMENT_SUBJECT = /\b(?:older|legacy|earlier|some)\s+(?:node(?:\.js)?|browsers?|runtimes?|environments?|engines?|versions?)\b|\bserver[- ]side\b|\bSSR\b|\bhydration\b|\bpolyfill\b|\bis not defined on the server\b/i;

// "if `loadCooldowns()` fails, the rejection is unhandled" -- a claim about how a function HANDLES ITS
// OWN ERRORS, where that function's body is not in the diff. Posted as a P1 on codra's own PR: the
// callee already wrapped its only failure path in try/catch, in another file, with a comment saying so.
// Requires a call-shaped subject (`name(` or `name()`), a failure condition, and an unhandled-outcome
// word, so an ordinary claim about visible code -- "this catch swallows the error" -- does not match.
// `(?!\.\s)` skips a sentence break but keeps dotted member expressions, so the condition still matches
// "if the `this.persistence.loadCooldowns()` call fails" without spanning two sentences.
const CALLEE_FAILURE_CONDITION = /\b(?:if|when|should|were)\b(?:(?!\.\s)[^;!?]){0,100}\b(?:fails?|failing|rejects?|rejecting|throws?|throwing|errors? out)\b/i;
const CALLEE_CALL_SHAPE = /[\w.$]+\s*\(\s*\)|`[\w.$]+\(/;
const CALLEE_UNHANDLED_OUTCOME = /\bunhandled\b|\bunhandled promise\b|\bnot (?:caught|handled)\b|\bno (?:\.)?catch\b|\bwithout (?:a )?(?:try|catch)\b|\bcrash\b/i;

export type UndecidableClaimReason = 'cross-file' | 'environment' | 'callee-errors';

/**
 * Refutes a claim whose truth lives outside the diff, returning the family it belongs to or null.
 *
 * Deliberately requires TWO independent signals per family -- a subject and a consequence -- because
 * either alone is ordinary review language. "This breaks the build" is a normal thing to say about
 * code in the diff; "other modules import this" is a normal aside. Only together do they describe a
 * consequence in a file nobody showed the model.
 */
export function refuteUndecidableClaim(input: { title: string; body: string }): UndecidableClaimReason | null {
  const text = `${input.title}\n${input.body}`;

  if (CROSS_FILE_SUBJECT.test(text) && CROSS_FILE_CONSEQUENCE.test(text)) return 'cross-file';
  if (ENVIRONMENT_HEDGE.test(text) && ENVIRONMENT_SUBJECT.test(text)) return 'environment';
  if (CALLEE_FAILURE_CONDITION.test(text) && CALLEE_CALL_SHAPE.test(text) && CALLEE_UNHANDLED_OUTCOME.test(text)) {
    return 'callee-errors';
  }

  return null;
}

// A full git object id: `uses: owner/action@<40 hex>` pins, and any version beside it is a comment.
const FULL_SHA_PATTERN = /\b[0-9a-f]{40}\b/;

export function looksLikeExternalVersionClaim(title: string, body: string): boolean {
  const text = `${title}\n${body}`;
  return VERSION_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

// A step pinned to a full SHA resolves by SHA, and the trailing `# v7.0.0` is never read, so "v7.0.0 does not exist" is not a defect there.
export function isVersionClaimRefutedByPin(input: { title: string; body: string; anchorContent: string }): boolean {
  if (!looksLikeExternalVersionClaim(input.title, input.body)) return false;
  return FULL_SHA_PATTERN.test(input.anchorContent);
}

type PresenceEntry = { line: DiffLine; hunkIndex: number; code: string };

export type PresenceIndex = {
  byToken: Map<string, PresenceEntry[]>;
  entries: PresenceEntry[];
  // new-file line number -> hunk index, so "same hunk" is answerable for the anchor line.
  hunkByLine: Map<number, number>;
};

export type AbsenceClaimVerdict =
  | {
      status: 'unknown';
      reason:
        | 'not_absence_shaped'
        | 'no_identifier'
        | 'ambiguous_identifier'
        | 'stoplisted'
        | 'not_present'
        | 'out_of_window';
    }
  | { status: 'refuted'; identifier: string; line: DiffLine };

type CommentSyntax = { line: readonly string[]; block: boolean };

// By extension: `//` is floor division in Python, `#` a private field in JS. Guessing truncates code.
export function commentSyntaxFor(path: string): CommentSyntax {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'py' || ext === 'rb' || ext === 'sh' || ext === 'yaml' || ext === 'yml' || ext === 'toml') {
    return { line: ['#'], block: false };
  }
  if (ext === 'sql') return { line: ['--'], block: true };
  return { line: ['//'], block: true };
}

// Returns `null` when unscannable, biasing to `unknown`. Do NOT add cross-line state without a desync test: dropping real code silently is worse than giving up.
export function stripCommentsAndStrings(input: string, syntax: CommentSyntax): string | null {
  let out = '';
  let i = 0;

  while (i < input.length) {
    const rest = input.slice(i);

    if (syntax.line.some((token) => rest.startsWith(token))) break;

    if (syntax.block && rest.startsWith('/*')) {
      const end = input.indexOf('*/', i + 2);
      if (end === -1) return null;
      out += ' ';
      i = end + 2;
      continue;
    }

    const char = input[i];

    if (char === "'" || char === '"') {
      const close = findStringEnd(input, i + 1, char);
      if (close === -1) return null;
      out += ' ';
      i = close + 1;
      continue;
    }

    if (char === '`') {
      const scanned = scanTemplateLiteral(input, i);
      if (!scanned) return null;
      out += scanned.code;
      i = scanned.next;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

function findStringEnd(input: string, start: number, quote: string): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') {
      i += 1;
      continue;
    }
    if (input[i] === quote) return i;
  }
  return -1;
}

// Keeps `${...}` interiors and discards the literal text around them.
function scanTemplateLiteral(input: string, start: number): { code: string; next: number } | null {
  let code = ' ';
  let i = start + 1;

  while (i < input.length) {
    if (input[i] === '\\') {
      i += 2;
      continue;
    }
    if (input[i] === '`') return { code, next: i + 1 };
    if (input[i] === '$' && input[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < input.length && depth > 0) {
        if (input[j] === '{') depth += 1;
        else if (input[j] === '}') depth -= 1;
        j += 1;
      }
      if (depth !== 0) return null;
      code += ` ${input.slice(i + 2, j - 1)} `;
      i = j;
      continue;
    }
    i += 1;
  }

  return null;
}

const TOKEN_PATTERN = /[A-Za-z_$][\w$]*/g;

export function buildPresenceIndex(file: FileDiff): PresenceIndex {
  const syntax = commentSyntaxFor(file.path);
  const byToken = new Map<string, PresenceEntry[]>();
  const entries: PresenceEntry[] = [];
  const hunkByLine = new Map<number, number>();

  file.hunks.forEach((hunk, hunkIndex) => {
    for (const line of hunk.lines) {
      if (line.newLineNumber !== undefined) hunkByLine.set(line.newLineNumber, hunkIndex);

      // A removed line cannot prove presence: deletion is consistent with the claim.
      if (line.kind === 'del') continue;

      const code = stripCommentsAndStrings(normalizeDiffText(line.content), syntax);
      if (code === null) continue;

      const entry: PresenceEntry = { line, hunkIndex, code };
      entries.push(entry);

      for (const match of code.matchAll(TOKEN_PATTERN)) {
        const token = match[0];
        const existing = byToken.get(token);
        if (existing) existing.push(entry);
        else byToken.set(token, [entry]);
      }
    }
  });

  return { byToken, entries, hunkByLine };
}

const SIMPLE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

// Delimited code spans only: prose would yield `days` and refute against any unrelated use.
function extractIdentifier(sentence: string): { identifier: string } | 'none' | 'ambiguous' {
  const spans = [
    ...sentence.matchAll(/`([^`]+)`/g),
    ...sentence.matchAll(/'([^']+)'/g),
    ...sentence.matchAll(/"([^"]+)"/g),
  ].map((match) => match[1].trim());

  const candidates = new Set(
    spans.filter((span) => SIMPLE_IDENTIFIER.test(span) || DOTTED_IDENTIFIER.test(span)),
  );

  if (candidates.size === 0) return 'none';
  // Two plausible identifiers means we cannot tell which one the claim is about, and refuting the wrong one is unsound.
  if (candidates.size > 1) return 'ambiguous';
  return { identifier: [...candidates][0] };
}

function absenceSentences(text: string): string[] {
  return text.split(/[.;\n]/).filter((sentence) => ABSENCE_PATTERNS.some((pattern) => pattern.test(sentence)));
}

export function checkAbsenceClaim(input: {
  title: string;
  body: string;
  anchorLine: number | undefined;
  index: PresenceIndex;
}): AbsenceClaimVerdict {
  // Bounded so a long body cannot turn this into a CPU problem inside a 10ms-budget Worker.
  const text = `${input.title}\n${input.body.slice(0, 600)}`;

  const sentences = absenceSentences(text);
  if (sentences.length === 0) return { status: 'unknown', reason: 'not_absence_shaped' };

  // Tried per sentence: TITLE usually gives the shape, BODY the identifier; ambiguity short-circuits rather than hunting for a tidier sentence.
  let identifier: string | undefined;
  for (const sentence of sentences) {
    const extracted = extractIdentifier(sentence);
    if (extracted === 'ambiguous') return { status: 'unknown', reason: 'ambiguous_identifier' };
    if (extracted !== 'none') {
      identifier = extracted.identifier;
      break;
    }
  }
  if (!identifier) return { status: 'unknown', reason: 'no_identifier' };

  const head = identifier.split('.')[0];
  if (identifier.length < MIN_IDENTIFIER_LENGTH) return { status: 'unknown', reason: 'stoplisted' };
  if (IDENTIFIER_STOPLIST.has(identifier.toLowerCase()) || IDENTIFIER_STOPLIST.has(head.toLowerCase())) {
    return { status: 'unknown', reason: 'stoplisted' };
  }

  const occurrences = identifier.includes('.')
    ? input.index.entries.filter((entry) => entry.code.replace(/\s*\.\s*/g, '.').includes(identifier))
    : (input.index.byToken.get(identifier) ?? []);

  if (occurrences.length === 0) return { status: 'unknown', reason: 'not_present' };

  // Proximity: without it "X is not passed to f()" is refuted by an unrelated X hundreds of lines away.
  const anchorHunk = input.anchorLine !== undefined ? input.index.hunkByLine.get(input.anchorLine) : undefined;
  const nearby = occurrences.find((entry) => {
    if (anchorHunk !== undefined && entry.hunkIndex === anchorHunk) return true;
    if (input.anchorLine === undefined || entry.line.newLineNumber === undefined) return false;
    return Math.abs(entry.line.newLineNumber - input.anchorLine) <= PROXIMITY_WINDOW_LINES;
  });

  if (!nearby) return { status: 'unknown', reason: 'out_of_window' };
  return { status: 'refuted', identifier, line: nearby.line };
}
