import { z } from 'zod';

export const reviewTriggers = ['auto', 'mention', 'retry'] as const;
export const jobStatuses = ['queued', 'running', 'done', 'failed', 'superseded', 'cancelled', 'stopped'] as const;
export const fileStatuses = ['pending', 'done', 'skipped', 'failed'] as const;
export const reviewVerdicts = ['approve', 'comment'] as const;
export const reviewSeverities = ['P0', 'P1', 'P2', 'P3', 'nit'] as const;
export const reviewCategories = ['security', 'bugs', 'performance', 'correctness', 'quality'] as const;

/**
 * The kinds of defect a finding may claim to be.
 *
 * Every value corresponds to something the prompts already invite, and every value has a
 * mechanically checkable precondition (a token that must be present for the claim to be possible).
 * The precondition table is deliberately NOT part of this enum and is never emitted by the model --
 * a model asked to state its own precondition will invent that too.
 *
 * Labelling only for now: nothing is refuted or filtered on this field yet. It exists so per-type
 * precision becomes measurable, which is the thing that would have surfaced `react_hook_missing_deps`
 * at 0-posted-out-of-28 months ago.
 */
export const claimTypes = [
  'react_hook_missing_deps',
  'react_missing_cleanup',
  'missing_await',
  'unhandled_promise_rejection',
  'resource_leak',
  'null_or_undefined_deref',
  'sql_injection',
  'unsafe_dom_sink',
  'unsafe_dynamic_code',
  'insecure_randomness',
  'hardcoded_secret',
  'redos_regex',
  'swallowed_error',
  'mutable_default_arg',
  'destructive_migration',
  'other',
] as const;

export type ClaimType = typeof claimTypes[number];

/**
 * Category is DERIVED from the claim type, never asked for. The model has never been asked for a
 * category and every row in the database reads 'quality' as a result, which makes the per-category
 * dashboard aggregate a single meaningless bar.
 */
export const CLAIM_TYPE_CATEGORY: Record<ClaimType, typeof reviewCategories[number]> = {
  sql_injection: 'security',
  unsafe_dom_sink: 'security',
  unsafe_dynamic_code: 'security',
  insecure_randomness: 'security',
  hardcoded_secret: 'security',
  missing_await: 'bugs',
  unhandled_promise_rejection: 'bugs',
  null_or_undefined_deref: 'bugs',
  react_hook_missing_deps: 'bugs',
  swallowed_error: 'bugs',
  mutable_default_arg: 'bugs',
  resource_leak: 'performance',
  redos_regex: 'performance',
  destructive_migration: 'correctness',
  react_missing_cleanup: 'correctness',
  other: 'quality',
};

export function toClaimType(value: unknown): ClaimType {
  return (claimTypes as readonly string[]).includes(value as string) ? (value as ClaimType) : 'other';
}

/**
 * Whether a claim of this kind can be decided from a diff hunk ALONE.
 *
 * Only diff hunks ever reach the model -- there is no enclosing-file or repo context anywhere in
 * this codebase, and adding it is not affordable (gemma's free tier is a 16k input-tokens-per-minute
 * bucket, and fetching file bodies costs a subrequest per file against a budget of 25). So rather
 * than widening the context to match the claims, this narrows the claims to match the context.
 *
 * 'needs_whole_file' means the defect cannot be established without knowing a callee's signature, a
 * value's nullability, or whether a path is reachable. Published measurements on exactly these
 * classes: LLIFT reached 50% precision on path feasibility (a coin flip); DCE-LLM needs a fine-tuned
 * classifier to beat GPT-4o by 30% on dead code, putting a general model in the mid-60s F1; and for
 * ReDoS there is no published LLM accuracy measurement at all, while purpose-built detectors still
 * carry ~23% false-positive rates.
 *
 * A `Record` rather than an array on purpose: a 17th claim type is a COMPILE ERROR until someone
 * classifies it, exactly as CLAIM_TYPE_CATEGORY already forces a category. An array would let a new
 * type default silently into "allowed".
 */
export const CLAIM_TYPE_DECIDABILITY: Record<ClaimType, 'diff_local' | 'needs_whole_file'> = {
  // Lexically visible in the added line itself.
  sql_injection: 'diff_local',
  unsafe_dom_sink: 'diff_local',
  unsafe_dynamic_code: 'diff_local',
  insecure_randomness: 'diff_local',
  hardcoded_secret: 'diff_local',
  mutable_default_arg: 'diff_local',
  destructive_migration: 'diff_local',
  swallowed_error: 'diff_local',
  unhandled_promise_rejection: 'diff_local',
  // Genuinely interprocedural -- deciding it requires knowing the callee is async -- but allowed
  // anyway. A known-true un-awaited call is shaped exactly like this, and there is no way to predict
  // whether a model labels such a finding `missing_await` or `unhandled_promise_rejection`; denying
  // this would risk silencing the real thing. The largest deliberate soundness hole in the table.
  missing_await: 'diff_local',
  // The escape hatch. Cannot be denied: it is where a model puts any real defect the taxonomy has no
  // name for. Watch its share of claimTypeCounts -- a jump means claims are being relabelled into it.
  other: 'diff_local',

  react_hook_missing_deps: 'needs_whole_file',   // needs the enclosing component and what's in scope
  react_missing_cleanup: 'needs_whole_file',     // needs to know whether cleanup exists outside the hunk
  resource_leak: 'needs_whole_file',             // interprocedural lifetime reasoning
  null_or_undefined_deref: 'needs_whole_file',   // nullability of values declared elsewhere + path feasibility
  redos_regex: 'needs_whole_file',               // regex complexity AND reachability from untrusted input
};

/**
 * Claim types not reportable by default.
 *
 * `null_or_undefined_deref` is classified above but deliberately EXCLUDED from this list for now: it
 * is the most FP-prone class, but unlike the hook claims there is no corpus measurement showing it
 * never posts, so it is scored in the shadow harness first. Move it in once that data exists.
 */
export const DEFAULT_DENIED_CLAIM_TYPES: ClaimType[] = claimTypes.filter(
  (type) => CLAIM_TYPE_DECIDABILITY[type] === 'needs_whole_file' && type !== 'null_or_undefined_deref',
);

/** How a finding ended its life. Distinguishes the six reasons `posted = false` used to conflate. */
export const findingDispositions = [
  'posted',
  'severity',
  'confidence',
  'suppression',
  'dedupe',
  'verify',
  // Distinct from 'verify' deliberately. 'verify' is the model's judgement; this is the verifier
  // failing to answer for a finding at all, which is our defect. Collapsing them would make the
  // tuning data useless in exactly the way `posted = false` was.
  'verify_unanswered',
  'cap',
  // NOTE: there is deliberately no value here for the parser's own drops (unmatched evidence, denied
  // claim types, refuted absence claims). Those findings never become review_comments rows, so a
  // disposition could never be written for them -- adding one would be a value nothing can produce.
  // They are surfaced two other ways instead: a `[reason]`-prefixed entry in the file summary, and
  // the per-file `withheld_counts` column that drives the review verdict.
  'unverifiable_passthrough',
] as const;

export type FindingDisposition = typeof findingDispositions[number];
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
  // Whether this finding actually reached the pull request. The dashboard lists everything the
  // model produced, so without this a review that generated 11 findings and posted 1 looks
  // identical to one that posted all 11.
  posted: z.boolean().nullable().optional(),
  // What kind of defect this claims to be. Kept in its own field and NEVER folded into the title:
  // buildFindingFingerprint hashes the title, so a title-format change would reset cross-run
  // suppression and unmatch every human dismissal in comment_feedback -- meaning the next review
  // re-posts findings someone already deleted.
  claimType: z.enum(claimTypes).nullable().optional(),
  // The diff window this finding was anchored to, captured at parse time. Findings cannot be
  // re-evaluated offline without it: diff_input is nulled by migration 003 and the KV diff cache
  // expires after 6 hours, so historical findings have no retrievable context.
  contextSnippet: z.string().nullable().optional(),
  // Which pipeline stage ended this finding's life.
  disposition: z.enum(findingDispositions).nullable().optional(),
  // The verifier's own justification, for kept findings as well as dropped ones. The tuning surface:
  // a subtraction stage nobody can inspect is a subtraction stage nobody can improve.
  verifyReason: z.string().nullable().optional(),
  // A human's verdict from the dashboard, if any. `null` means UNLABELLED, which is not a verdict --
  // precision may only be computed over the labelled subset.
  humanLabel: z.enum(['marked_right', 'marked_wrong']).nullable().optional(),
});

export const findingLabelSchema = z.object({ label: z.enum(['right', 'wrong']) });

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
      // `unknown`, not `string`: a Zod rejection here throws for the WHOLE file, so one model that
      // emits `claim_type: 42` would discard every finding in that file over a label. Validation
      // happens in toClaimType, which coerces anything unrecognized to 'other'.
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
  // repo_configs.parsed_json, so changing a default here needs a data migration to reach existing
  // rows (see 005 for min_confidence) plus a REPO_CONFIG_CACHE_VERSION bump.
  min_severity: z.enum(reviewSeverities).default('P3'),
  // Defaults to 0, i.e. OFF, on purpose. Model-reported confidence is not merely a weak signal in
  // this corpus, it is an INVERTED one: the worst-performing claim family carried a mean confidence
  // of 0.964 across 21 findings, of which the 4 that posted were all the same wrong claim under
  // different titles, while the only claim area that ever produced a true positive averaged 0.775.
  // A live floor here would therefore preferentially retain the least correct findings.
  //
  // The gate itself is kept and is now provider-independent (an omitted score records as 0 rather
  // than `undefined`), so an operator who sets this deliberately gets consistent behaviour on every
  // provider. The mechanism is repaired; the default declines to use it. Grounding is enforced by
  // evidence provenance in the parser instead, which is checkable rather than self-reported.
  min_confidence: z.number().min(0).max(1).default(0),
  focus: z.array(z.enum(reviewCategories)).default([...reviewCategories]),
  // Claim classes the model may not report, enforced at parse time so it binds every provider.
  // Config-driven rather than hardcoded so it lands in the job's replayable configSnapshot and a
  // retried job filters against the same list it originally ran with.
  deny_claim_types: z.array(z.enum(claimTypes)).default([...DEFAULT_DENIED_CLAIM_TYPES]),
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
    min_confidence: 0,
    focus: [...reviewCategories],
    deny_claim_types: [...DEFAULT_DENIED_CLAIM_TYPES],
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
