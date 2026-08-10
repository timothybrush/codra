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

// Re-exported for server use; the client imports @shared/review-limits directly, to keep zod out
// of the browser bundle.
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
  // The verbatim line the finding claims to be about: anchors the comment and proves the claim
  // is grounded in code that exists in the diff.
  evidence: z.string().min(1).nullable().optional(),
  // Stable identity (path + title), recognising the same issue across re-reviews.
  fingerprint: z.string().min(1).nullable().optional(),
  // Hash of the anchored line's content: a change means the code changed, so a previously-posted
  // finding is legitimately raised again.
  anchorHash: z.string().min(1).nullable().optional(),
  // Whether this finding reached the PR: without it, 11 generated / 1 posted looks like 11 posted.
  posted: z.boolean().nullable().optional(),
  // Never fold into the title: buildFindingFingerprint hashes it, so a format change resets
  // cross-run suppression and unmatches every human dismissal in comment_feedback.
  claimType: z.enum(claimTypes).nullable().optional(),
  // Captured at parse time: 003 nulls diff_input and the KV diff cache expires after 6h, so
  // historical findings have no other retrievable context.
  contextSnippet: z.string().nullable().optional(),
  disposition: z.enum(findingDispositions).nullable().optional(),
  // The verifier's justification, for kept findings as well as dropped: the tuning surface.
  verifyReason: z.string().nullable().optional(),
  // A human's dashboard verdict. `null` means UNLABELLED, not "wrong": compute precision over the
  // labelled subset only.
  humanLabel: z.enum(['marked_right', 'marked_wrong']).nullable().optional(),
  // Title-independent identity, OR-matched with `fingerprint` for cross-run suppression.
  fingerprintV2: z.string().min(1).nullable().optional(),
  // Absent means 'llm', so pre-existing rows read correctly with no backfill. Always test
  // `=== 'rule'` positively, or counts silently include deterministic hits.
  source: z.enum(['llm', 'rule']).nullable().optional(),
  // The retirement signal, when source is 'rule': many generated and none posted means the
  // filter always rejects it.
  ruleId: z.string().min(1).nullable().optional(),
});

export const findingLabelSchema = z.object({ label: z.enum(['right', 'wrong']) });

// Shared with the batched schema: divergence would mean a finding that parses on only one path.
const reviewFindingSchema = z.object({
  title: z.string().max(100),
  body: z.string().min(1),
  confidence_score: z.number().min(0).max(1).optional(),
  // In lockstep with normalizeFinding's clamp and the grammar: tighter here fails the whole file.
  priority: z.number().int().min(0).max(4).optional(),
  evidence: z.string().optional(),
  // `unknown`, not `string`: one bad label would discard the whole file. toClaimType coerces it.
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
});

export const fileReviewModelOutputSchema = z.object({
  findings: z.array(reviewFindingSchema),
  overall_correctness: z.string().optional().default('patch is correct'),
  overall_explanation: z.string().optional().default('Review completed (partial output).'),
  overall_confidence_score: z.number().min(0).max(1).optional(),
});

// One entry per packed file, so the nesting carries file identity. `.min(1)` throws on an empty
// response, so the chain falls through instead of marking the bin clean.
export const batchReviewModelOutputSchema = z.object({
  files: z.array(
    z.object({
      absolute_file_path: z.string(),
      // Required, not defaulted: an absent array would report a file the model skipped as clean.
      findings: z.array(reviewFindingSchema),
      overall_correctness: z.string().optional().default('patch is correct'),
      overall_explanation: z.string().optional().default('Review completed (partial output).'),
      overall_confidence_score: z.number().min(0).max(1).optional(),
    }),
  ).min(1),
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
  // Injected by the workflow so runReviewJob can bind it to the resolved job row; webhook jobs
  // can't be bound at instance-create time.
  workflowInstanceId: z.string().optional(),
  // Set by lease recovery so the consumer creates a FRESH instance keyed on deliveryId, instead
  // of colliding with the dead one still keyed on jobId.
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
  // Nullable, not just optional: the column has no default, so every path that inserts without
  // resolving a provider (bulkRecordRetryableFileReviewFailures, bulkMarkFilesFailed) stores NULL,
  // and JSON_BUILD_OBJECT emits it as null. `.optional()` alone rejected that and made getJobDetail
  // throw for the whole job -- one deferred bin took the entire dashboard page down.
  modelProvider: z.string().nullable().optional(),
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
  // How many files shared this file's model call: 1 alone, N batched, null for pre-batching rows.
  // The token columns are a proportional share of that one call, so the two must be read together.
  batchSize: z.number().int().nullable().optional(),
  // Findings the gates dropped before they could be posted. Nullable: only review paths write it,
  // and the deferral paths deliberately clear it.
  withheldCounts: z
    .object({ evidence: z.number().int(), claimDenied: z.number().int() })
    .partial()
    .nullable()
    .optional(),
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
  // Instance-wide, not per-repo: the subrequest budget and provider rate limit are both shared.
  maxFiles: z
    .number()
    .int()
    .min(reviewMaxFilesRange.min)
    .max(reviewMaxFilesRange.max)
    .default(reviewMaxFilesRange.default),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;
