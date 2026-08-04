import type { ClaimType, reviewSeverities } from '@shared/schema';

type ReviewSeverity = typeof reviewSeverities[number];

/**
 * Deterministic candidate rules — the second finding channel.
 *
 * The reasoning, from BitsAI-CR (ByteDance, FSE 2025): an LLM asked to GENERATE review findings
 * scores F1 0.07-0.37 on real pull requests, while an LLM asked to TRIAGE a bounded, pre-grounded
 * candidate scores 0.88-0.96. So candidates come from rules and the model only judges them.
 *
 * Every rule here must satisfy four constraints, and a rule that cannot is not worth shipping:
 *
 *  1. It maps to a `diff_local` claim type. Anything needing whole-file or external context is
 *     denied downstream anyway (see CLAIM_TYPE_DECIDABILITY), so it would generate and never post.
 *  2. It fires on ADDED lines only. Flagging a `del` line means reporting code the PR removed.
 *  3. Its `pattern` runs on a comment- and string-STRIPPED line, so prose can never trigger it.
 *  4. It has a cheap `triggers` substring. Those form one sieve that runs before any stripping, and
 *     it is what keeps this inside a 10ms CPU budget.
 */
export type Rule = {
  id: string;
  claimType: ClaimType;
  severity: ReviewSeverity;
  title: string;
  body: string;
  /** Cheap substrings; if none appear in the raw line the rule is never considered. */
  triggers: readonly string[];
  /** Runs against the stripped line. Must not backtrack catastrophically. */
  pattern: RegExp;
  /**
   * Optional veto, run against the RAW line. Needed where stripping destroys the very evidence that
   * would clear a hit: `stripCommentsAndStrings` replaces a block comment with a space, so
   * `catch (e) { /* intentional *\/ }` strips to `catch (e) {  }` and looks empty.
   */
  rejectRaw?: RegExp;
  /** File extensions this applies to. Empty means all. */
  extensions?: readonly string[];
  /** Tier-2 rules ship disabled: the code is reviewable, the rule is not yet trusted. */
  enabled: boolean;
};

const ts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const;

export const RULES: readonly Rule[] = [
  {
    id: 'empty-catch',
    claimType: 'swallowed_error',
    severity: 'P2',
    title: 'Empty catch block swallows the error',
    body: 'This `catch` has no body, so the error is discarded with no log, no rethrow and no recovery. '
      + 'A failure here becomes silent. If the error is genuinely expected, say so in a comment inside the block.',
    triggers: ['catch'],
    pattern: /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/,
    // The escape hatch: a documented empty catch is a deliberate choice, not an oversight. It has to
    // be checked against the RAW line, because the stripper collapses the comment to a single space
    // and the block then looks genuinely empty.
    rejectRaw: /\bcatch\s*(\([^)]*\))?\s*\{\s*(?:\/\/|\/\*)/,
    extensions: ts,
    enabled: true,
  },
  {
    id: 'debugger-statement',
    claimType: 'other',
    severity: 'P1',
    title: '`debugger` statement left in the diff',
    body: 'A `debugger` statement halts execution whenever devtools are open. This is almost always '
      + 'a leftover from local debugging.',
    triggers: ['debugger'],
    pattern: /^\s*debugger\s*;?\s*$/,
    extensions: ts,
    enabled: true,
  },
  {
    id: 'focused-test',
    claimType: 'other',
    severity: 'P1',
    title: 'Focused test will skip the rest of the suite',
    body: 'A focused test (`.only`) silently prevents every other test in the file from running, so '
      + 'CI stays green while covering almost nothing.',
    triggers: ['.only'],
    pattern: /\b(?:describe|it|test|context|suite)\s*\.\s*only\s*\(/,
    extensions: ts,
    enabled: true,
  },
  {
    id: 'dynamic-code-exec',
    claimType: 'unsafe_dynamic_code',
    severity: 'P1',
    title: 'Dynamic code execution',
    body: '`eval` and the `Function` constructor execute arbitrary strings as code. If any part of '
      + 'that string can be influenced by input, this is remote code execution.',
    triggers: ['eval(', 'Function('],
    pattern: /(?:^|[^.\w])eval\s*\(|new\s+Function\s*\(/,
    extensions: ts,
    enabled: true,
  },
  {
    id: 'dynamic-html-sink',
    claimType: 'unsafe_dom_sink',
    severity: 'P1',
    title: 'Unsanitized value assigned to an HTML sink',
    body: 'Assigning a non-literal to `innerHTML`/`outerHTML` (or passing one to `insertAdjacentHTML`) '
      + 'executes any markup it contains. If the value can carry user input this is XSS.',
    triggers: ['innerHTML', 'outerHTML', 'insertAdjacentHTML'],
    // Only flags a non-literal right-hand side: the stripper removes string literals, so
    // `el.innerHTML = ''` becomes `el.innerHTML = ` and does not match, while `= html` does.
    pattern: /\.(?:inner|outer)HTML\s*=\s*[A-Za-z_$][\w$.[\]()]*|insertAdjacentHTML\s*\([^)]*,\s*[A-Za-z_$]/,
    extensions: ts,
    enabled: true,
  },
  {
    id: 'mutable-default-arg',
    claimType: 'mutable_default_arg',
    severity: 'P2',
    title: 'Mutable default argument',
    body: 'Python evaluates a default argument once, at definition time, so this list/dict/set is '
      + 'shared by every call. Mutating it leaks state between invocations. Use `None` and build the '
      + 'value inside the function.',
    triggers: ['def '],
    pattern: /\bdef\s+\w+\s*\([^)]*=\s*(?:\[\s*\]|\{\s*\}|set\s*\(\s*\)|dict\s*\(\s*\)|list\s*\(\s*\))/,
    extensions: ['py'],
    enabled: true,
  },
  {
    id: 'destructive-migration',
    claimType: 'destructive_migration',
    severity: 'P1',
    title: 'Destructive migration statement',
    body: 'This statement discards data irreversibly. On a forward-only migration chain there is no '
      + 'rollback: confirm the column/table is genuinely unused and that a backup exists.',
    triggers: ['DROP', 'TRUNCATE', 'drop', 'truncate'],
    // DROP COLUMN / DROP TABLE / TRUNCATE only. Deliberately NOT `DROP INDEX`, `DROP CONSTRAINT`,
    // `DROP DEFAULT` or `DROP NOT NULL` — those discard no rows, and this repo's migrations use them
    // routinely, so including them would make the rule fire constantly on correct code.
    pattern: /\b(?:drop\s+(?:column|table)|truncate\s+table|truncate\s+\w)/i,
    extensions: ['sql'],
    enabled: true,
  },

  /* ── Tier 2: shipped but disabled ──────────────────────────────────────────────────────────── */

  {
    id: 'hardcoded-secret',
    claimType: 'hardcoded_secret',
    severity: 'P0',
    title: 'Possible hardcoded credential',
    body: 'This looks like a literal credential committed to the repository. If it is real, rotate it '
      + 'and move it to a secret binding.',
    triggers: ['sk-', 'AIza', 'ghp_', 'AKIA'],
    pattern: /\b(?:sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/,
    // Disabled: the stripper removes string literals, which is exactly where a credential lives, so
    // this can only fire on an unquoted token. Needs a different scanning mode, not a different regex.
    enabled: false,
  },
  {
    id: 'insecure-random',
    claimType: 'insecure_randomness',
    severity: 'P2',
    title: '`Math.random()` used for a security-sensitive value',
    body: '`Math.random()` is not cryptographically secure and its output is predictable. Use '
      + '`crypto.getRandomValues()` for tokens, ids or anything an attacker should not guess.',
    triggers: ['Math.random'],
    pattern: /\b(?:token|secret|key|nonce|salt|password|session|id)\w*\s*=[^=]*Math\.random\s*\(/i,
    extensions: ts,
    // Disabled: the name heuristic is the whole rule, and `id = Math.random()` in a test fixture or a
    // React key is a false positive. Needs shadow data before it is trusted.
    enabled: false,
  },
];

/**
 * NOT SHIPPED: `sql-string-concat`.
 *
 * The stripper deletes string literals, so it cannot tell a `sql`SELECT … ${x}`` tagged template
 * (safe, parameterised) from real concatenation — and this repository is built on that safe pattern,
 * so the rule would fire dozens of times on its own diffs. Detecting it properly needs to know
 * whether the template is tagged, which is a parse, not a regex.
 */

export const RULES_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));
