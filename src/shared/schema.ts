import { z } from 'zod';

export const reviewTriggers = ['auto', 'mention', 'retry'] as const;
export const jobStatuses = ['queued', 'running', 'done', 'failed', 'superseded', 'cancelled', 'stopped'] as const;
export const fileStatuses = ['pending', 'done', 'skipped', 'failed'] as const;
export const reviewVerdicts = ['approve', 'comment'] as const;
export const reviewSeverities = ['P0', 'P1', 'P2', 'P3', 'nit'] as const;
export const reviewCategories = ['security', 'bugs', 'performance', 'correctness', 'quality'] as const; // Keeping for DB compatibility but will deprecate usage in prompts
export const llmApiFormats = ['openai', 'anthropic', 'gemini', 'cloudflare-workers-ai'] as const;

export const dateStringSchema = z.union([z.string(), z.date()]).transform((d) => (d instanceof Date ? d.toISOString() : d));
export const coerceNumberSchema = z.coerce.number();

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
});

export const fileReviewModelOutputSchema = z.object({
  findings: z.array(
    z.object({
      title: z.string().max(100),
      body: z.string().min(1),
      confidence_score: z.number().min(0).max(1).optional(),
      // 4 = 'nit'. Kept in lockstep with the clamp in normalizeFinding and the JSON grammar in
      // buildReviewResponseSchema -- if this is tighter than the clamp, a single out-of-range
      // priority fails the parse for the ENTIRE file, not just that finding.
      priority: z.number().int().min(0).max(4).optional(),
      evidence: z.string().optional(),
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

export const summaryModelOutputSchema = z.union([
  z.array(z.object({ summary: z.string().min(1) })),
  z.object({ summary: z.string().min(1) }),
]);

export const labelsSchema = z.union([
  z.literal(false),
  z.object({
    p1: z.string().min(1),
    p2: z.string().min(1),
    p3: z.string().min(1),
  }),
]);

export const reviewConfigSchema = z.object({
  on: z.array(z.enum(['opened', 'synchronize', 'ready_for_review', 'reopened', 'closed'])).default(['opened', 'synchronize', 'ready_for_review', 'reopened']),
  ignore_drafts: z.boolean().default(true),
  mention_trigger: z.union([z.literal(false), z.string().min(1)]).default('@codra-app'),
  skip_files: z
    .array(z.string().min(1))
    .default(['**/*.lock', 'dist/**', 'build/**', '.next/**', '*.generated.*', 'coverage/**']),
  // NOTE: `max_files` used to live here. It is now an instance-wide setting
  // (`reviewSettingsSchema.maxFiles`) because the limit it protects -- subrequest budget and
  // provider rate limits -- is shared across repositories, not owned by any one of them.
  // Stale `max_files` keys left in stored repo configs are simply ignored on parse.
  large_file_threshold_lines: z.number().int().min(1).max(5_000).default(200),
  max_diff_lines_per_file: z.number().int().min(1).max(5_000).default(800),
  max_total_diff_chars: z.number().int().min(1).max(500_000).default(150_000),
  max_comments: z.number().int().min(1).max(150).default(10),
  // 'P3' and not 'nit': findings the model itself marks as cosmetic are exactly the "technically
  // true, nobody cared" comments that make a review bot get ignored. NOTE this default only
  // applies to repos seen for the first time -- syncRepoConfig materializes the whole config into
  // repo_configs.parsed_json, so existing rows need a data migration (008) to move.
  min_severity: z.enum(reviewSeverities).default('P3'),
  min_confidence: z.number().min(0).max(1).default(0.6),
  focus: z.array(z.enum(reviewCategories)).default([...reviewCategories]),
  custom_rules: z.array(z.string().min(1)).default([]),
  labels: labelsSchema.default({
    p1: 'review: needs-attention',
    p2: 'review: approved',
    p3: 'review: approved',
  }),
  exec: z
    .object({
      enabled: z.boolean().default(false),
      on_file_types: z.array(z.string().min(1)).default(['.ts', '.tsx', '.js']),
      command: z.string().min(1).default('npm run lint && npm run typecheck'),
    })
    .default({
      enabled: false,
      on_file_types: ['.ts', '.tsx', '.js'],
      command: 'npm run lint && npm run typecheck',
    }),
});

export const repoConfigSchema = z.object({
  review: reviewConfigSchema.default({
    on: ['opened', 'synchronize', 'ready_for_review', 'reopened'],
    ignore_drafts: true,
    mention_trigger: '@codra-app',
    skip_files: ['**/*.lock', 'dist/**', 'build/**', '.next/**', '*.generated.*', 'coverage/**'],
    large_file_threshold_lines: 200,
    max_diff_lines_per_file: 800,
    max_total_diff_chars: 150_000,
    max_comments: 10,
    min_severity: 'P3',
    min_confidence: 0.6,
    focus: [...reviewCategories],
    custom_rules: [],
    labels: {
      p1: 'review: needs-attention',
      p2: 'review: approved',
      p3: 'review: approved',
    },
    exec: {
      enabled: false,
      on_file_types: ['.ts', '.tsx', '.js'],
      command: 'npm run lint && npm run typecheck',
    },
  }),
  model: z
    .object({
      main: z.string().nullable().default(null),
      fallbacks: z.array(z.string()).nullable().default([]),
      size_overrides: z
        .array(
          z.object({
            max_lines: z.number().int().positive(),
            model: z.string(),
            fallbacks: z.array(z.string()).optional(),
          }),
        )
        .nullable()
        .optional(),
    })
    .default({
      main: null,
      fallbacks: [],
      size_overrides: [],
    }),
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

export type JobsQuery = z.infer<typeof jobsQuerySchema>;
export type JobStep = z.infer<typeof jobStepSchema>;

export const fileReviewRecordSchema = z.object({
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
export type FileReviewModelOutput = z.infer<typeof fileReviewModelOutputSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export const KIMI_K2_5_MODEL = '@cf/moonshotai/kimi-k2.5';
export const KIMI_K2_6_MODEL = '@cf/moonshotai/kimi-k2.6';
export const DEPRECATED_MODEL_ALIASES: Record<string, string> = {
  [KIMI_K2_5_MODEL]: KIMI_K2_6_MODEL,
};

export function normalizeModelId(model: string) {
  return DEPRECATED_MODEL_ALIASES[model] ?? model;
}

export function normalizeRepoModelConfig(model: RepoConfig['model']): RepoConfig['model'] {
  return {
    ...model,
    main: model.main ? normalizeModelId(model.main) : null,
    fallbacks: model.fallbacks === null
      ? null
      : Array.isArray(model.fallbacks)
        ? model.fallbacks.map(normalizeModelId)
        : [],
    size_overrides: model.size_overrides === null || model.size_overrides === undefined
      ? model.size_overrides
      : model.size_overrides.map((tier) => ({
          ...tier,
          model: normalizeModelId(tier.model),
          fallbacks: tier.fallbacks?.map(normalizeModelId),
        })),
  };
}

export function normalizeRepoConfig(config: RepoConfig): RepoConfig {
  return {
    ...config,
    model: normalizeRepoModelConfig(config.model),
  };
}

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

export const defaultRepoConfig = repoConfigSchema.parse({});

export const reviewConcurrencyLevels = ['low', 'medium', 'high', 'max'] as const;
export type ReviewConcurrencyLevel = typeof reviewConcurrencyLevels[number];
export const REVIEW_CONCURRENCY_LIMITS: Record<ReviewConcurrencyLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

export const reviewMaxCommentsOptions = [5, 10, 15, 20] as const;

export const reviewMaxFilesRange = { min: 1, max: 500, default: 200 } as const;

export const reviewSettingsSchema = z.object({
  concurrencyLevel: z.enum(reviewConcurrencyLevels).default('medium'),
  maxComments: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).default(10),
  // Instance-wide, not per-repo: the ceiling exists to bound one review's cost against the
  // Workers subrequest budget and the model provider's rate limit, both of which are shared
  // across every repository. A per-repo value could not express that.
  maxFiles: z
    .number()
    .int()
    .min(reviewMaxFilesRange.min)
    .max(reviewMaxFilesRange.max)
    .default(reviewMaxFilesRange.default),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;
