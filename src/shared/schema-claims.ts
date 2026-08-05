import { reviewCategories } from './schema-enums';

// Enforced, not just labelled: DEFAULT_DENIED_CLAIM_TYPES drops whole types and filters rule
// candidates. Makes per-type precision measurable; would have caught react_hook_missing_deps at
// 0-posted-out-of-28 months earlier.
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
  // About the outside world: unverifiable by training cutoff or diff grounding. Worst family measured,
  // 21 generated, 4 posted, all wrong, confidence 0.964.
  'external_version_claim',
  'other',
] as const;

export type ClaimType = typeof claimTypes[number];

// DERIVED, never asked for: asking produced 'quality' on every row and one meaningless bar.
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
  external_version_claim: 'correctness',
  other: 'quality',
};

export function toClaimType(value: unknown): ClaimType {
  return (claimTypes as readonly string[]).includes(value as string) ? (value as ClaimType) : 'other';
}

// Decidable from a diff hunk ALONE? Wider context is unaffordable (16k input tokens/min, one
// subrequest per file body against a budget of 25). needs_whole_file wants a signature, nullability
// or reachability, where general models measure near a coin flip. A Record, so a new type is a
// COMPILE ERROR until classified.
export const CLAIM_TYPE_DECIDABILITY: Record<ClaimType, 'diff_local' | 'needs_whole_file' | 'needs_external_facts'> = {
  sql_injection: 'diff_local',
  unsafe_dom_sink: 'diff_local',
  unsafe_dynamic_code: 'diff_local',
  insecure_randomness: 'diff_local',
  hardcoded_secret: 'diff_local',
  mutable_default_arg: 'diff_local',
  destructive_migration: 'diff_local',
  swallowed_error: 'diff_local',
  unhandled_promise_rejection: 'diff_local',
  // Interprocedural but allowed: a known-true un-awaited call looks identical and the label is
  // unpredictable. The largest deliberate soundness hole here.
  missing_await: 'diff_local',
  // Escape hatch, never deniable: where real defects the taxonomy cannot name land. A jump in its
  // claimTypeCounts share means relabelling.
  other: 'diff_local',

  react_hook_missing_deps: 'needs_whole_file',   // needs the enclosing component and what's in scope
  react_missing_cleanup: 'needs_whole_file',     // needs to know whether cleanup exists outside the hunk
  resource_leak: 'needs_whole_file',             // interprocedural lifetime reasoning
  redos_regex: 'needs_whole_file',               // regex complexity AND reachability from untrusted input

  // Held out: 3 generated, 0 valid. Needs off-diff nullability plus path feasibility, the LLIFT class
  // (~50% precision).
  null_or_undefined_deref: 'needs_whole_file',

  // Undecidable from any source: the fact lives in a registry postdating training, and the only sound
  // answer is a network lookup we will not do mid-review.
  external_version_claim: 'needs_external_facts',
};

// Not reportable by default: anything undecidable from the diff. Derived from the table, so
// classifying a new type is the only step needed.
export const DEFAULT_DENIED_CLAIM_TYPES: ClaimType[] = claimTypes.filter(
  (type) => CLAIM_TYPE_DECIDABILITY[type] !== 'diff_local',
);

// Generate candidates, never post. Every rule starts here; promote by removing its id.
export const DEFAULT_SHADOW_RULE_IDS = [
  'empty-catch',
  'debugger-statement',
  'focused-test',
  'dynamic-code-exec',
  'dynamic-html-sink',
  'mutable-default-arg',
  'destructive-migration',
  // Tier 2, `enabled: false`. Listed so flipping one on starts SHADOW scoring, not posting P0s.
  'hardcoded-secret',
  'insecure-random',
] as const;

// How a finding ended its life; splits what `posted = false` conflated. READ-VALIDATING, not just
// descriptive: getJobDetail runs jobDetailSchema.parse() over raw Postgres rows, so deleting a value
// a historical row still carries makes the dashboard throw. Retire by marking historical, never by
// deleting.
export const findingDispositions = [
  'posted',
  'severity',
  'confidence',
  'suppression',
  'dedupe',
  'verify',
  // Distinct from 'verify': that is the model's judgement, this is it not answering, which is our bug.
  'verify_unanswered',
  // HISTORICAL, no producer: a rule candidate verification could not confirm, from when rules failed
  // CLOSED. Removed with verify-findings.ts; kept because older rows still hold it.
  'rule_unverified',
  'cap',
  // HISTORICAL, same removal: was for candidates unrenderable for verification, now simply kept.
  // comment-card.tsx still labels it so old findings read correctly.
  'unverifiable_passthrough',
] as const;

export type FindingDisposition = typeof findingDispositions[number];
