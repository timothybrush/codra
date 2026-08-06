import type { ParsedReviewComment } from '@shared/schema';

// Matches the identity marker appended to every inline comment. Kept next to the writer so the two
// can never drift.
// The third field is OPTIONAL so every comment already on GitHub still parses. Requiring it would
// silently stop recording deletions of every historical comment -- and the failure would be invisible,
// because parseFindingMarker simply returns null and the webhook records zero feedback.
const FINDING_MARKER_PATTERN = /<!--\s*codra-fp:([0-9a-f]+):([0-9a-f]*)(?::([0-9a-f]*))?\s*-->/;

// An HTML comment carrying the finding's identity. Invisible in rendered markdown, echoed back
// verbatim by GitHub in review-comment and review-thread webhooks.
//
// This is how human feedback is matched back to a finding. The obvious alternative -- matching on
// (path, line) -- fails precisely where it matters most: GitHub nulls `line` when a comment goes
// outdated, i.e. when the developer edited the flagged code, which is the strongest signal in the
// dataset. The marker also survives file renames and force-pushes.
export function formatFindingMarker(
  comment: Pick<ParsedReviewComment, 'fingerprint' | 'anchorHash' | 'fingerprintV2'>,
) {
  if (!comment.fingerprint) return '';
  return `\n\n<!-- codra-fp:${comment.fingerprint}:${comment.anchorHash ?? ''}:${comment.fingerprintV2 ?? ''} -->`;
}

export function parseFindingMarker(body: string | null | undefined) {
  if (!body) return null;
  const match = FINDING_MARKER_PATTERN.exec(body);
  if (!match) return null;
  return { fingerprint: match[1], anchorHash: match[2] || null, fingerprintV2: match[3] || null };
}

export class FormatterService {
  constructor(private baseUrl: string) {}

  toReviewEvent(verdict: 'approve' | 'comment') {
    return verdict === 'approve' ? 'APPROVE' as const : 'COMMENT' as const;
  }

  severityIcon(severity: ParsedReviewComment['severity']) {
    const iconBase = `${this.baseUrl}/icons`;
    const img = (name: string, alt: string) =>
      `<img src="${iconBase}/${name}-icon.svg" width="20" height="20" alt="${alt}" style="vertical-align:middle" />`;
    switch (severity) {
      case 'P0':  return img('p0',  'P0');
      case 'P1':  return img('p1',  'P1');
      case 'P2':  return img('p2',  'P2');
      case 'P3':  return img('p3',  'P3');
      case 'nit': return img('nit', 'nit');
      default:    return '⚪';
    }
  }

  // Strip leading emoji / legacy tag prefixes from a string (same logic as model-output cleanText).
  stripLeadingTags(text: string): string {
    let current = text.trim();
    let prev = '';
    while (current !== prev) {
      prev = current;
      current = current
        .replace(/^([\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]|\[QUALITY\]|\[SECURITY\]|\[BUG\]|\[P[0-3]\]|\[NIT\]|QUALITY|SECURITY|BUG|P[0-3]|NIT|[:\-\s\uFE0F]|[^\w\s])+/giu, '')
        .trim();
    }
    return current;
  }

  formatInlineComment(comment: ParsedReviewComment) {
    // Clean the body: strip any residual prefix tags, then remove a leading line
    // that duplicates the title (can happen with stale DB records).
    let body = this.stripLeadingTags(comment.body);
    const firstLine = body.split('\n')[0].trim();
    const cleanFirstLine = this.stripLeadingTags(firstLine);
    if (
      cleanFirstLine.toLowerCase().startsWith(comment.title.toLowerCase()) ||
      comment.title.toLowerCase().startsWith(cleanFirstLine.toLowerCase())
    ) {
      body = body.slice(firstLine.length).replace(/^[\n\r]+/, '');
    }

    return `${this.severityIcon(comment.severity)} <strong>${comment.title}</strong>\n\n${body}${formatFindingMarker(comment)}`;
  }

  summarizeVerdict(comments: ParsedReviewComment[], hasFailures: boolean) {
    const p0 = comments.filter((c) => c.severity === 'P0').length;
    const p1 = comments.filter((c) => c.severity === 'P1').length;
    const p2 = comments.filter((c) => c.severity === 'P2').length;

    if (p0 > 0 || p1 > 0 || hasFailures || p2 > 0) {
      return { verdict: 'comment' as const, errors: p0 + p1, warnings: p2 };
    }

    return { verdict: 'approve' as const, errors: 0, warnings: 0 };
  }

  formatReviewOverview(commitSha: string, botUsername: string) {
    const shortSha = commitSha.slice(0, 10);
    
    return `### Codra Review

Here are some automated review suggestions for this pull request.

**Reviewed commit:** \`${shortSha}\`

<details>
<summary>ℹ️ About Codra in GitHub</summary>

<br/>

[Your team has set up Codra to review pull requests in this repo](${this.baseUrl}/repos). Reviews are triggered when you:

- **Open** a pull request for review
- **Mark** a draft as ready
- **Comment** "@${botUsername} review"

If Codra has suggestions, it will comment; otherwise it will react with 👍.

Codra can also answer questions or update the PR. Try commenting "@${botUsername} address that feedback".

</details>`;
  }
}
