import type { ParsedReviewComment } from '@shared/schema';

/**
 * One definition of the `review_comments` field list, shared by every site that reads or writes it.
 *
 * There were seven hand-maintained copies — three INSERT column lists and two JSON projections — and
 * they drifted exactly as you would expect: `fingerprint_v2` was written on every insert and absent
 * from the dashboard's projection, so `parsedComments[].fingerprintV2` was permanently `undefined`
 * in the UI even though suppression depends on it. Adding a column here now reaches all of them.
 */

/** Column order for INSERT INTO review_comments (...). Must match INSERT_VALUE_CASTS. */
export const REVIEW_COMMENT_INSERT_COLUMNS = [
  'path', 'line', 'position', 'severity', 'category', 'title', 'body', 'code_suggestion',
  'confidence_score', 'evidence', 'fingerprint', 'anchor_hash', 'claim_type', 'context_snippet',
  'disposition', 'fingerprint_v2', 'source', 'rule_id',
] as const;

/**
 * The UNNEST casts, offset so $1 stays free for the file_review_id every caller passes first.
 * Generated rather than written out so the count can never fall out of step with the column list.
 */
export const REVIEW_COMMENT_INSERT_CASTS = REVIEW_COMMENT_INSERT_COLUMNS
  .map((column, index) => {
    const placeholder = `$${index + 2}`;
    if (column === 'line' || column === 'position') return `${placeholder}::int[]`;
    if (column === 'confidence_score') return `${placeholder}::real[]`;
    return `${placeholder}::text[]`;
  })
  .join(', ');

/** The bind values for those casts, in column order. Pass after the file_review_id. */
export function reviewCommentInsertValues(comments: ParsedReviewComment[]) {
  return [
    comments.map((c) => c.path),
    comments.map((c) => c.line ?? null),
    comments.map((c) => c.position ?? null),
    comments.map((c) => c.severity),
    comments.map((c) => c.category),
    comments.map((c) => c.title),
    comments.map((c) => c.body),
    comments.map((c) => c.codeSuggestion ?? null),
    comments.map((c) => c.confidenceScore ?? null),
    comments.map((c) => c.evidence ?? null),
    comments.map((c) => c.fingerprint ?? null),
    comments.map((c) => c.anchorHash ?? null),
    comments.map((c) => c.claimType ?? null),
    comments.map((c) => c.contextSnippet ?? null),
    comments.map((c) => c.disposition ?? null),
    comments.map((c) => c.fingerprintV2 ?? null),
    comments.map((c) => c.source ?? 'llm'),
    comments.map((c) => c.ruleId ?? null),
  ];
}

/**
 * The JSON_BUILD_OBJECT body used to project comments back out, keyed to the `rc` alias.
 *
 * `extraFields` is appended verbatim for projections that need more — the job-detail query adds a
 * correlated `humanLabel` lookup, which the file-review query has no use for.
 */
export function reviewCommentJsonObject(extraFields = '') {
  const fields = [
    `'path', rc.path`,
    `'line', rc.line`,
    `'position', rc.position`,
    `'severity', rc.severity`,
    `'category', rc.category`,
    `'title', rc.title`,
    `'body', rc.body`,
    `'codeSuggestion', rc.code_suggestion`,
    `'confidenceScore', rc.confidence_score`,
    `'evidence', rc.evidence`,
    `'fingerprint', rc.fingerprint`,
    `'fingerprintV2', rc.fingerprint_v2`,
    `'anchorHash', rc.anchor_hash`,
    `'posted', rc.posted`,
    `'claimType', rc.claim_type`,
    `'contextSnippet', rc.context_snippet`,
    `'disposition', rc.disposition`,
    `'verifyReason', rc.verify_reason`,
    `'source', rc.source`,
    `'ruleId', rc.rule_id`,
  ].join(',\n        ');

  return `JSON_BUILD_OBJECT(\n        ${fields}${extraFields ? `,\n        ${extraFields}` : ''}\n      )`;
}

/** The full aggregate, including the empty-array fallback both call sites need. */
export function reviewCommentsAggregate(extraFields = '') {
  return `COALESCE(
        (
          SELECT JSON_AGG(${reviewCommentJsonObject(extraFields)} ORDER BY rc.id ASC)
          FROM review_comments rc WHERE rc.file_review_id = fr.id
        ),
        '[]'::json
      )`;
}
