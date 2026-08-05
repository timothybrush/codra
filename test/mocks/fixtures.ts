import type { FileDiff, DiffLine } from '@server/core/diff';

// Fixture builders shared by the parser, rule and webhook suites.
//
// Most of these existed two or three times over with small gratuitous differences, so a change to a
// parser field had to be chased across files that were all testing the same thing. `fileFromLines`
// has one consumer today and lives here because it is the same builder in a different shape.

// A raw model response wrapping one finding, in the shape the generator grammar produces.
//
// `defaults` are per-suite finding fields (each suite has its own title and body); `finding` is the
// per-test override and wins. Both merge INSIDE the finding, not at the envelope level: spreading
// them over the envelope silently drops the suite's title and injects stray top-level keys.
export function reviewJson(finding: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  return JSON.stringify({
    findings: [{
      title: 'Unvalidated input',
      body: 'The value is never checked.',
      priority: 1,
      confidence_score: 0.9,
      ...defaults,
      ...finding,
    }],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'explanation',
    overall_confidence_score: 0.8,
  });
}

// A single-hunk diff of added lines, numbered from 1.
export function addedLinesFile(path: string, added: string[], removed: string[] = []): FileDiff {
  let n = 0;
  return {
    path,
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: added.length + removed.length,
    hunks: [{
      header: '@@ -1,10 +1,10 @@',
      lines: [
        ...removed.map((content) => ({ kind: 'del' as const, content, oldLineNumber: ++n, position: n })),
        ...added.map((content) => ({ kind: 'add' as const, content, newLineNumber: ++n, position: n })),
      ],
    }],
  };
}

// A diff built from explicit lines, for suites that need `del`/`context` kinds interleaved.
export function fileFromLines(
  lines: Array<Partial<DiffLine> & { content: string }>,
  path = 'src/stats.ts',
): FileDiff {
  let n = 0;
  return {
    path,
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: lines.length,
    hunks: [{
      header: '@@ -1,10 +1,10 @@',
      lines: lines.map((line) => {
        n += 1;
        return { kind: 'add' as const, newLineNumber: n, position: n, ...line };
      }),
    }],
  };
}

// HMAC-SHA256 in GitHub's `sha256=<hex>` webhook signature format.
export async function signPayload(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}
