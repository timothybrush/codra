/**
 * Deterministic refutation of absence-shaped claims.
 *
 * The motivating false positive: a model reported that a parameter was never passed to a query, and
 * the added line `[clampedDays],` sat TWO LINES BELOW the code it cited. A pure reasoning failure
 * with the answer adjacent -- no amount of restricting the model's scope would have caught it, and
 * the prompt already forbids "missing / never-called" claims with nothing enforcing it.
 *
 * SOUNDNESS, stated once and binding on every change to this file:
 *
 *   `refuted` asserts exactly one thing -- that the proposition "identifier X does not appear here"
 *   is FALSE, because X does appear here. That is valid, and valid ONLY against that proposition.
 *
 *   `unknown` asserts NOTHING. The absence of a token never proves a bug and never proves its
 *   absence; the code could live in the 90% of the file the model was never shown.
 *
 *   There is no `confirmed` verdict and there must never be one. A check that can confirm findings
 *   is a check that manufactures them.
 *
 * Fail-open is structural, not advisory: every uncertain branch below returns `unknown`. Skipping a
 * line, failing to extract an identifier, or finding two candidates all cost us a refutation, which
 * is free. Getting one wrong silences a real defect, which is not.
 */
import type { DiffLine, FileDiff } from './diff';
import { normalizeDiffText } from './fingerprint';

/** Refute only when the identifier turns up in the same hunk, or this close in the new file. */
const PROXIMITY_WINDOW_LINES = 25;

/** Shorter than this and an identifier is too generic to carry a refutation. */
const MIN_IDENTIFIER_LENGTH = 3;

/**
 * Wording that makes a claim refutable. Anchored on verbs rather than on the bare word "missing",
 * because "missing" alone matches plenty of claims that are not about textual absence at all
 * ("missing error handling", "missing index"), and those are not decidable this way.
 */
const ABSENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:never|not|no longer)\s+(?:being\s+)?(?:passed|provided|supplied|forwarded|included|used|called|invoked|awaited|checked|set|declared|defined|imported)\b/i,
  /\bdoes not\s+(?:pass|include|call|use|await|check|set|import)\b/i,
  /\bfails to\s+(?:pass|include|call|await|check|import)\b/i,
  /\bwithout\s+(?:passing|including|calling|awaiting|checking|importing)\b/i,
  /\b(?:missing|omitted|absent)\b/i,
  /\bis not defined\b/i,
];

/**
 * Identifiers a refutation may never rest on.
 *
 * The keyword rule is the important half. Refuting "`await` is missing" by finding the token `await`
 * somewhere else in the diff is precisely the unsound inference this module must never make -- the
 * claim is about a specific call site, not about whether the language keyword appears at all. The
 * same goes for names so common that their presence says nothing about the claim.
 */
const IDENTIFIER_STOPLIST = new Set([
  'await', 'async', 'if', 'else', 'try', 'catch', 'finally', 'return', 'throw', 'new', 'const',
  'let', 'var', 'function', 'class', 'this', 'super', 'import', 'export', 'from', 'default',
  'null', 'undefined', 'true', 'false', 'void', 'typeof', 'instanceof', 'delete', 'yield',
  'props', 'state', 'error', 'err', 'data', 'value', 'key', 'id', 'type', 'name', 'index',
  'result', 'response', 'request', 'req', 'res', 'params', 'options', 'config', 'args',
]);

type PresenceEntry = { line: DiffLine; hunkIndex: number; code: string };

export type PresenceIndex = {
  byToken: Map<string, PresenceEntry[]>;
  entries: PresenceEntry[];
  /** new-file line number -> hunk index, so "same hunk" is answerable for the anchor line. */
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

/**
 * Comment syntax by extension, because guessing wrong truncates real code.
 *
 * `//` is floor division in Python and `#` is a private field in modern JS, so neither can be
 * treated as a comment universally. Getting this wrong only ever loses a refutation, but there is no
 * reason to lose one.
 */
function commentSyntaxFor(path: string): CommentSyntax {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'py' || ext === 'rb' || ext === 'sh' || ext === 'yaml' || ext === 'yml' || ext === 'toml') {
    return { line: ['#'], block: false };
  }
  if (ext === 'sql') return { line: ['--'], block: true };
  return { line: ['//'], block: true };
}

/**
 * Strips comments and string literals from one line, so an identifier mentioned in prose or in a
 * message can never refute a claim about code.
 *
 * Returns `null` when the line cannot be scanned confidently -- an unterminated quote or an unclosed
 * block comment. Skipping such a line biases toward `unknown`, which is the safe direction. Do not
 * "improve" this into cross-line state tracking without a test for the case where the tracking
 * desynchronizes; a stripper that silently drops real code is worse than one that gives up.
 *
 * `${...}` interiors inside template literals ARE preserved: an interpolation is real code, and the
 * motivating false positive hinged on exactly that.
 */
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

/** Keeps `${...}` interiors and discards the literal text around them. */
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

      // A removed line proving "presence" is backwards: the identifier being deleted is CONSISTENT
      // with the claim that it is no longer there.
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

/**
 * Pulls the identifier a claim says is absent, from delimited code spans ONLY.
 *
 * Never from bare words. Bare-word heuristics over prose are the main source of false refutations --
 * "the days parameter is never passed" would yield `days` and refute against any unrelated use of
 * it. If the model did not mark the identifier as code, we do not know what it meant.
 */
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
  // Two plausible identifiers means we cannot tell which one the claim is about, and refuting the
  // wrong one is unsound.
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

  // Every absence-shaped sentence is tried, because the TITLE routinely establishes the shape
  // ("Missing await") while the BODY carries the identifier. Extraction stays scoped to one sentence
  // at a time -- an identifier from one sentence is never paired with a claim in another.
  //
  // Ambiguity short-circuits rather than moving on: if a sentence names two plausible identifiers we
  // do not know which the claim is about, and hunting for a tidier sentence elsewhere is how you talk
  // yourself into an unsound refutation.
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

  // Proximity. Without it, "X is not passed to f()" gets refuted because X appears in an unrelated
  // function several hundred lines away. The motivating false positive had its answer two lines
  // below the cited code, so a tight window costs nothing real.
  const anchorHunk = input.anchorLine !== undefined ? input.index.hunkByLine.get(input.anchorLine) : undefined;
  const nearby = occurrences.find((entry) => {
    if (anchorHunk !== undefined && entry.hunkIndex === anchorHunk) return true;
    if (input.anchorLine === undefined || entry.line.newLineNumber === undefined) return false;
    return Math.abs(entry.line.newLineNumber - input.anchorLine) <= PROXIMITY_WINDOW_LINES;
  });

  if (!nearby) return { status: 'unknown', reason: 'out_of_window' };
  return { status: 'refuted', identifier, line: nearby.line };
}
