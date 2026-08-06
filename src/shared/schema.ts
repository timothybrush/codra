import { z } from 'zod';
import {
  reviewSeverities,
  reviewConcurrencyLevels,
  type ReviewConcurrencyLevel,
  REVIEW_CONCURRENCY_LIMITS,
  reviewMaxCommentsOptions,
  reviewMaxFilesRange,
} from './review-limits';
import {
  reviewTriggers,
  jobStatuses,
  fileStatuses,
  reviewVerdicts,
  reviewCategories,
  llmApiFormats,
} from './schema-enums';
import {
  claimTypes,
  type ClaimType,
  CLAIM_TYPE_CATEGORY,
  toClaimType,
  CLAIM_TYPE_DECIDABILITY,
  DEFAULT_DENIED_CLAIM_TYPES,
  DEFAULT_SHADOW_RULE_IDS,
  findingDispositions,
  type FindingDisposition,
} from './schema-claims';
import {
  reviewConfigSchema,
  repoConfigSchema,
  type RepoConfig,
  KIMI_K2_5_MODEL,
  KIMI_K2_6_MODEL,
  DEPRECATED_MODEL_ALIASES,
  normalizeModelId,
  normalizeRepoModelConfig,
  normalizeRepoConfig,
  defaultRepoConfig,
} from './schema-repo-config';

// Re-exported for server-side consumers that import these from @shared/schema; the client should
// import from @shared/review-limits directly to avoid pulling zod into the browser bundle.
export {
  reviewSeverities,
  reviewConcurrencyLevels,
  type ReviewConcurrencyLevel,
  REVIEW_CONCURRENCY_LIMITS,
  reviewMaxCommentsOptions,
  reviewMaxFilesRange,
};
export {
  reviewTriggers,
  jobStatuses,
  fileStatuses,
  reviewVerdicts,
  reviewCategories,
  llmApiFormats,
};
export {
  claimTypes,
  type ClaimType,
  CLAIM_TYPE_CATEGORY,
  toClaimType,
  CLAIM_TYPE_DECIDABILITY,
  DEFAULT_DENIED_CLAIM_TYPES,
  DEFAULT_SHADOW_RULE_IDS,
  findingDispositions,
  type FindingDisposition,
};
export {
  reviewConfigSchema,
  repoConfigSchema,
  type RepoConfig,
  KIMI_K2_5_MODEL,
  KIMI_K2_6_MODEL,
  DEPRECATED_MODEL_ALIASES,
  normalizeModelId,
  normalizeRepoModelConfig,
  normalizeRepoConfig,
  defaultRepoConfig,
};

const dateStringSchema = z.union([z.string(), z.date()]).transform((d) => (d instanceof Date ? d.toISOString() : d));
const coerceNumberSchema = z.coerce.number();

export const jobStepSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  startedAt: dateStringSchema.nullable(),
  finishedAt: dateStringSchema.nullable(),
  error: z.string().nullable().optional(),
});

export const parsedReviewCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().nullable().optional(),
  position: z.number().int().positive().nullable().optional(),
  severity: z.enum(reviewSeverities),
  category: z.enum(reviewCategories).default('quality'),
  title: z.string().min(1),
  body: z.string().min(1),
  codeSuggestion: z.string().min(1).nullable().optional(),
  confidenceScore: z.number().min(0).max(1).nullable().optional(),
  // The verbatim line of code the finding claims to be about, used to anchor the comment and to
  // verify the claim is grounded in code that actually exists in the diff.
  evidence: z.string().min(1).nullable().optional(),
  // Stable identity of the finding (path + title), so the same issue can be recognized across
  // re-reviews of the same PR.
  fingerprint: z.string().min(1).nullable().optional(),
  // Hash of the anchored line's content. When this changes the underlying code changed, so a
  // previously-posted finding is legitimately raised again.
  anchorHash: z.string().min(1).nullable().optional(),
  // Whether this finding reached the pull request. Without it, 11 generated and 1 posted looks
  // identical to 11 posted.
  posted: z.boolean().nullable().optional(),
  // Never folded into the title: buildFindingFingerprint hashes the title, so a format change would
  // reset cross-run suppression and unmatch every human dismissal in comment_feedback.
  claimType: z.enum(claimTypes).nullable().optional(),
  // Captured at parse time: diff_input is nulled by migration 003 and the KV diff cache expires
  // after 6 hours, so historical findings have no other retrievable context.
  contextSnippet: z.string().nullable().optional(),
  // Which pipeline stage ended this finding's life.
  disposition: z.enum(findingDispositions).nullable().optional(),
  // The verifier's own justification, for kept findings as well as dropped ones. The tuning surface:
  // a subtraction stage nobody can inspect is a subtraction stage nobody can improve.
  verifyReason: z.string().nullable().optional(),
  // A human's verdict from the dashboard, if any. `null` means UNLABELLED, which is not a verdict --
  // precision may only be computed over the labelled subset.
  humanLabel: z.enum(['marked_right', 'marked_wrong']).nullable().optional(),
  // Title-independent identity, OR-matched with `fingerprint` for cross-run suppression.
  fingerprintV2: z.string().min(1).nullable().optional(),
  // Absent means 'llm', so every pre-existing row reads correctly with no backfill. Always test
  // `=== 'rule'` positively, or anything COUNTING findings silently includes deterministic hits.
  source: z.enum(['llm', 'rule']).nullable().optional(),
  // Which rule fired, when source is 'rule'. The retirement signal: a rule with many generated and
  // no posted findings is one the filter always rejects, and should be deleted or fixed.
  ruleId: z.string().min(1).nullable().optional(),
});

export const findingLabelSchema = z.object({ label: z.enum(['right', 'wrong']) });

export const fileReviewModelOutputSchema = z.object({
  findings: z.array(
    z.object({
      title: z.string().max(100),
      body: z.string().min(1),
      confidence_score: z.number().min(0).max(1).optional(),
      // Kept in lockstep with the clamp in normalizeFinding and the JSON grammar: tighter here than
      // there fails the parse for the ENTIRE file, not just one finding.
      priority: z.number().int().min(0).max(4).optional(),
      evidence: z.string().optional(),
      // `unknown`, not `string`: a Zod rejection here discards every finding in the file over one
      // bad label. Validated in toClaimType instead, which coerces to 'other'.
      claim_type: z.unknown().optional(),
      code_location: z.object({
        absolute_file_path: z.string(),
        line_range: z.object({
          start: z.number().int().positive(),
          end: z.number().int().positive(),
        }).optional(),
        line: z.number().int().positive().optional(),
      }),
      code_suggestion: z.string().optional(),
    }),
  ),
  overall_correctness: z.string().optional().default('patch is correct'),
  overall_explanation: z.string().optional().default('Review completed (partial output).'),
  overall_confidence_score: z.number().min(0).max(1).optional(),
});

export const reviewJobMessageSchema = z.object({
  jobId: z.string().uuid().optional(),
  deliveryId: z.string().min(1),
  phase: z.enum(['prepare', 'review', 'finalize']).optional(),
  eventName: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  installationId: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  prNumber: z.number().int().positive().optional(),
  commitSha: z.string().min(1).optional(),
  trigger: z.enum(reviewTriggers).optional(),
  requestId: z.string().optional(),
  // The actual Cloudflare Workflow instance id, injected by the workflow so runReviewJob can bind
  // it to the resolved job row (webhook jobs can't be bound at instance-create time).
  workflowInstanceId: z.string().optional(),
  // Set by lease recovery so the queue consumer creates a FRESH instance (keyed on deliveryId)
  // instead of colliding with the dead instance that is still keyed on jobId.
  forceFreshInstance: z.boolean().optional(),
}).superRefine((message, ctx) => {
  if (message.jobId || message.eventName) {
    return;
  }

  ctx.addIssue({
    code: 'custom',
    message: 'Queue message must include either jobId or eventName.',
    path: ['jobId'],
  });
});

export const jobSummarySchema = z.object({
  id: z.string().uuid(),
  workflowInstanceId: z.string().nullable().optional(),
  owner: z.string(),
  repo: z.string(),
  installationId: z.string(),
  prNumber: z.number().int(),
  prTitle: z.string().nullable(),
  prAuthor: z.string().nullable(),
  commitSha: z.string(),
  trigger: z.enum(reviewTriggers),
  status: z.enum(jobStatuses),
  verdict: z.enum(reviewVerdicts).nullable(),
  fileCount: z.number().int(),
  commentCount: z.number().int(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
  nextRetryAt: dateStringSchema.nullable().optional(),
  startedAt: dateStringSchema.nullable(),
  finishedAt: dateStringSchema.nullable(),
  errorMessage: z.string().nullable(),
  overallConfidenceScore: z.number().nullable().optional(),
  overallCorrectness: z.string().nullable().optional(),
  steps: z.array(jobStepSchema).default([]),
  checkRunId: coerceNumberSchema.nullable().optional(),
  configSnapshot: repoConfigSchema.nullable().optional(),
  retryOfJobId: z.string().uuid().nullable().optional(),
});

export const jobsQuerySchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  prNumber: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().int().positive().optional(),
  ),
  status: z.enum(jobStatuses).optional(),
  verdict: z.enum(reviewVerdicts).optional(),
  search: z.string().optional(),
  limit: z.preprocess((v) => Number(v), z.number().int().min(1).max(100)).default(20),
  offset: z.preprocess((v) => Number(v), z.number().int().min(0)).default(0),
});

export type JobStep = z.infer<typeof jobStepSchema>;

const fileReviewRecordSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  filePath: z.string(),
  fileStatus: z.enum(fileStatuses),
  modelUsed: z.string(),
  modelProvider: z.string().optional(),
  diffLineCount: z.number().int().nullable(),
  diffInput: z.string().nullable(),
  rawAiOutput: z.string().nullable(),
  parsedComments: z.array(parsedReviewCommentSchema),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  verdict: z.enum(reviewVerdicts).nullable(),
  fileSummary: z.string().nullable(),
  overallCorrectness: z.string().nullable().optional(),
  confidenceScore: z.number().nullable().optional(),
  errorMessage: z.string().nullable(),
  createdAt: dateStringSchema,
});

export const jobDetailSchema = jobSummarySchema.extend({
  baseSha: z.string(),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  summaryMarkdown: z.string().nullable(),
  configSnapshot: repoConfigSchema.nullable(),
  reviewId: coerceNumberSchema.nullable(),
  retryOfJobId: z.string().uuid().nullable(),
  summaryModel: z.string().nullable(),
  files: z.array(fileReviewRecordSchema),
});

export const repoConfigRecordSchema = z.object({
  installationId: z.string(),
  owner: z.string(),
  repo: z.string(),
  parsedJson: repoConfigSchema,
  updatedAt: dateStringSchema,
  lastJobCreatedAt: dateStringSchema.nullable(),
  lastJobVerdict: z.enum(reviewVerdicts).nullable(),
  mainModel: z.string().nullable(),
  fallbackModels: z.array(z.string()).nullable(),
  sizeOverrides: z.any().nullable(),
  enabled: z.boolean(),
});

export const statsSchema = z.object({
  totals: z.object({
    jobs: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    comments: z.number().int(),
  }),
  trend: z.array(
    z.object({
      day: z.string(),
      jobs: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      comments: z.number().int(),
    }),
  ),
  verdicts: z.array(
    z.object({
      verdict: z.enum(reviewVerdicts).nullable(),
      count: z.number().int(),
    }),
  ),
  models: z.array(
    z.object({
      modelUsed: z.string(),
      provider: z.string().optional(),
      calls: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
    }),
  ),
  topRepos: z.array(
    z.object({
      owner: z.string(),
      repo: z.string(),
      jobs: z.number().int(),
    }),
  ),
  statuses: z.array(
    z.object({
      status: z.enum(jobStatuses),
      count: z.number().int(),
    }),
  ),
  triggers: z.array(
    z.object({
      trigger: z.enum(reviewTriggers),
      count: z.number().int(),
    }),
  ),
  severities: z.array(
    z.object({
      severity: z.enum(reviewSeverities),
      count: z.number().int(),
    }),
  ),
  categories: z.array(
    z.object({
      category: z.enum(reviewCategories),
      count: z.number().int(),
    }),
  ),
  performance: z.object({
    avgDurationMs: z.number().nullable(),
    p95DurationMs: z.number().nullable(),
    avgConfidence: z.number().nullable(),
  }),
});

export type ParsedReviewComment = z.infer<typeof parsedReviewCommentSchema>;
export type ReviewJobMessage = z.infer<typeof reviewJobMessageSchema>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type FileReviewRecord = z.infer<typeof fileReviewRecordSchema>;
export type JobDetail = z.infer<typeof jobDetailSchema>;
export type RepoConfigRecord = z.infer<typeof repoConfigRecordSchema>;

export const llmProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  apiFormat: z.enum(llmApiFormats),
  baseUrl: z.string().url().nullable(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
});

export const modelConfigSchema = z.object({
  modelId: z.string(),
  providerId: z.string().uuid(),
  providerName: z.string(),
  apiFormat: z.enum(llmApiFormats),
  modelName: z.string(),
  updatedAt: dateStringSchema,
});

export type LlmApiFormat = z.infer<typeof llmProviderSchema>['apiFormat'];
export type LlmProvider = z.infer<typeof llmProviderSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type StatsPayload = z.infer<typeof statsSchema>;

export const reviewSettingsSchema = z.object({
  concurrencyLevel: z.enum(reviewConcurrencyLevels).default('medium'),
  maxComments: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).default(10),
  // Instance-wide, not per-repo: bounds the Workers subrequest budget and provider rate limit,
  // both shared across every repository.
  maxFiles: z
    .number()
    .int()
    .min(reviewMaxFilesRange.min)
    .max(reviewMaxFilesRange.max)
    .default(reviewMaxFilesRange.default),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;
