// Stable identifiers for a finding: `fingerprint` answers "is this the same finding?" (path + normalized title), `anchorHash` answers "has the code under it changed?" (content of the anchored line). Kept separate: a combined hash answers neither.

// FNV-1a 32-bit hex. A dedupe key, not a security boundary; synchronous, so not `crypto.subtle`.
export function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, via shifts to stay in 32-bit integer math.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// The gutter strip is load-bearing: models quoting "verbatim" copy part of the `  12  14 +` prefix. Whitespace is collapsed, not removed, so `a + b` and `a+b` stay distinct.
export function normalizeDiffText(input: string): string {
  return input
    .replace(/^\s*\d*\s+\d*\s*[+\- ]?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Typographic folding for matching a model's evidence quote: models retype rather than copy, and an unmatched curly quote is fatal.
// NEVER fold this into `normalizeDiffText` -- `buildAnchorHash` builds on that, so widening it re-hashes every affected anchor and re-raises findings suppression had already retired.
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

// Keep the NUL as an ESCAPE, never a literal control character: as a raw byte it made git and the GitHub API classify this file as *binary*.
// Changing this input resets every cross-run suppression and unmatches stored comment_feedback dismissals, re-posting findings a human deleted. Pinned by test/claim-types.spec.ts; must not move.
export function buildFindingFingerprint(path: string, title: string): string {
  return fnv1a32Hex(`${path}\u0000${normalizeFindingTitle(title)}`);
}

// A second identity, OR-matched with v1, because models reword titles and v1 missed most repeats. Inputs are machine-derived, so they don't move when the prose does; hashing the flagged line's CONTENT means editing that line re-raises the finding. Additive on purpose -- folding it into v1 would carry the reset cost described above.
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
