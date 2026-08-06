// Stable identifiers for a finding, so the same issue is recognised across re-reviews.
//
//   fingerprint  "is this the same finding?"       -> path + normalized title
//   anchorHash   "has the code under it changed?"  -> content of the anchored line
//
// Separate because a combined hash answers neither: an out-of-diff line gets re-anchored to the
// current hunk layout, so the same finding on untouched code hashes differently next run.

// FNV-1a 32-bit hex. Synchronous, so not `crypto.subtle`. A dedupe key, not a security boundary.
export function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, via shifts to stay in 32-bit integer math.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Reduces a line of code to a comparable form. The leading gutter strip is load-bearing:
// `renderFileDiff` shows `   12   14 +const x = 1;` and a model told to quote "verbatim" copies part
// of that prefix. Whitespace is collapsed, not removed, so `a + b` and `a+b` stay distinct.
export function normalizeDiffText(input: string): string {
  return input
    .replace(/^\s*\d*\s+\d*\s*[+\- ]?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// `normalizeDiffText` plus typographic folding, for comparing a model's evidence quote against the
// diff. Models retype rather than copy, and a curly quote silently deletes an otherwise good
// finding now that an unmatched quote is fatal.
//
// NEVER fold this into `normalizeDiffText`: `buildAnchorHash` is built on that function, so
// widening it re-hashes every anchor containing one of these characters and re-raises findings that
// suppression had already retired.
export function foldEvidenceText(input: string): string {
  return normalizeDiffText(input)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...');
}

// Normalized finding title, shared with the in-memory dedupe so both agree on identity.
export function normalizeFindingTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The NUL separator must stay written as an ESCAPE, never as a literal control character. It was a
// raw NUL byte until 2026-08-03, which made git and the GitHub API classify this file as *binary*,
// so its diffs were unreadable and codra could never review its own fingerprinting.
//
// Changing this input at all resets every cross-run suppression AND unmatches every stored
// comment_feedback dismissal, so the next review re-posts findings a human already deleted. The
// pinned hashes in test/claim-types.spec.ts exist to catch that; they must not move.
export function buildFindingFingerprint(path: string, title: string): string {
  return fnv1a32Hex(`${path}\u0000${normalizeFindingTitle(title)}`);
}

// A SECOND identity for the same finding, matched with OR alongside the first, because models
// reword titles constantly and v1 therefore missed most repeats.
//
// Every input is machine-derived, so none of it moves when the prose does. The safety property is
// the anchor: it hashes the flagged line's CONTENT, so editing that line re-raises the finding and
// a wrong suppression un-sticks by itself. Returns null when there is no anchor to key on.
//
// Additive on purpose: folding it into v1 would carry the same reset cost described above.
export function buildFindingFingerprintV2(
  path: string,
  claimType: string | null | undefined,
  anchorHash: string | null | undefined,
): string | null {
  if (!anchorHash) return null;
  return fnv1a32Hex(`v2 ${path} ${claimType ?? 'other'} ${anchorHash}`);
}

export function buildAnchorHash(lineContent: string): string {
  return fnv1a32Hex(normalizeDiffText(lineContent));
}
