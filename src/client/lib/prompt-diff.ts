/**
 * Parsing for the rendered review prompt shown in the diff viewer.
 *
 * NOT `parseUnifiedDiff` from `@server/core/diff`: that parses real git output for the review
 * pipeline; this reads the padded, gutter-prefixed form the prompt renders for the model.
 */

// Codra renders each file's diff body as 4-wide padded number columns:
//   "<oldNo> <newNo> <prefix><content>"   e.g. " 615  615  const x = 1"
// We read those embedded line numbers directly and fall back to standard git-diff lines for
// anything else. Only content inside a hunk is parsed, so the prompt preamble is ignored.

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a padded body line ("NNNN MMMM Pcontent"); null if it isn't one. */
function parsePaddedLine(line: string) {
  if (line.length < 11 || line[4] !== ' ' || line[9] !== ' ') return null;
  const prefix = line[10];
  if (prefix !== '+' && prefix !== '-' && prefix !== ' ') return null;
  const oldNo = line.slice(0, 4).trim();
  const newNo = line.slice(5, 9).trim();
  if (oldNo && !/^\d+$/.test(oldNo)) return null;
  if (newNo && !/^\d+$/.test(newNo)) return null;
  return { prefix, oldNo, newNo, content: line.slice(11) };
}

export function parsePromptDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let started = false; // inside a hunk
  let oldNo = 0;
  let newNo = 0;

  for (const line of diff.split('\n')) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      started = true;
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (!started) continue; // skip prompt preamble before the first hunk
    if (line.startsWith('diff --git')) { started = false; continue; }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('[NOTE')) continue; // truncation note

    const padded = parsePaddedLine(line);
    if (padded) {
      if (padded.prefix === '+') {
        rows.push({ kind: 'add', oldNo: null, newNo: padded.newNo ? Number(padded.newNo) : null, text: padded.content });
      } else if (padded.prefix === '-') {
        rows.push({ kind: 'del', oldNo: padded.oldNo ? Number(padded.oldNo) : null, newNo: null, text: padded.content });
      } else {
        rows.push({ kind: 'ctx', oldNo: padded.oldNo ? Number(padded.oldNo) : null, newNo: padded.newNo ? Number(padded.newNo) : null, text: padded.content });
      }
      continue;
    }

    // Standard git-diff fallback.
    const p = line[0];
    if (p === '+') rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    else if (p === '-') rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (p === ' ') rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }

  // Drop a single trailing blank context row left behind by the final newline.
  const last = rows[rows.length - 1];
  if (last && last.kind === 'ctx' && last.text === '') rows.pop();

  return rows;
}

/** Cheap line scan (no row objects) so collapsed panels never pay for a full parse. */
export function diffStats(diff: string | null) {
  if (!diff) return { adds: 0, dels: 0, total: 0 };
  let adds = 0;
  let dels = 0;
  let total = 0;
  let started = false;
  for (const line of diff.split('\n')) {
    if (HUNK_RE.test(line)) { started = true; total++; continue; }
    if (!started) continue;
    if (line.startsWith('diff --git')) { started = false; continue; }
    const padded = parsePaddedLine(line);
    if (padded) {
      total++;
      if (padded.prefix === '+') adds++;
      else if (padded.prefix === '-') dels++;
      continue;
    }
    const p = line[0];
    if (p === '+' && !line.startsWith('+++')) { adds++; total++; }
    else if (p === '-' && !line.startsWith('---')) { dels++; total++; }
    else if (p === ' ') total++;
  }
  return { adds, dels, total };
}
