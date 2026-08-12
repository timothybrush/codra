// A model can decline to review without failing. It returns valid JSON, an empty `findings` array,
// `overall_correctness: "patch is correct"`, and a one-sentence explanation -- and the pipeline records
// that as "this file is clean", which is indistinguishable from a real clean verdict.
//
// Measured on a 221-file job reviewed by a `-flash-lite` primary: 165 files came back under 100 output
// tokens, and `src/server/core/review/index.ts` answered a 751-line diff (15,022 input tokens) with 71
// output tokens. Exactly one file in the job produced a response over 250 tokens, and it was the only
// file that produced a finding. The pipeline was working; the model was not reviewing.
//
// This detects that shape so the chain can escalate, rather than posting a clean review nobody earned.

import type { FileDiff } from '../diff';

// Below this a zero-finding response has not said enough to be a considered judgement about a large
// diff. The real observations clustered at 305-476 chars for eight substantive files; 600 leaves room
// for a genuinely thorough "clean" explanation without admitting a one-liner.
export const NON_ANSWER_MAX_RESPONSE_CHARS = 600;

// Only diffs at least this big. A short diff CAN be honestly dismissed in a sentence -- 162 files in that
// same job were comment-only cleanups whose empty findings arrays were correct -- so applying this to
// small files would manufacture failures out of accurate verdicts.
export const NON_ANSWER_MIN_DIFF_LINES = 200;

/**
 * True when a review response is a non-answer: a substantive diff dismissed in a sentence with no
 * findings. Deliberately conservative -- it must never fire on a small diff, and never when the model
 * actually engaged, because the cost of a false positive is an escalation that spends real quota.
 */
export function isNonAnswerReview(input: {
  rawText: string;
  file: Pick<FileDiff, 'lineCount'>;
  findingCount: number;
  minDiffLines?: number;
}): boolean {
  if (input.findingCount > 0) return false;
  if (input.file.lineCount < (input.minDiffLines ?? NON_ANSWER_MIN_DIFF_LINES)) return false;
  return input.rawText.trim().length < NON_ANSWER_MAX_RESPONSE_CHARS;
}
