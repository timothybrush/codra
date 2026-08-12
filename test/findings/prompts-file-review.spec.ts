import { describe, expect, it } from 'vitest';
import { getLanguageForFile } from '@server/prompts/languages';
import {
  buildFileReviewPrompts,
  buildFileReviewSystemPrompt,
  buildFileReviewSystemPromptBase,
  buildReviewResponseSchema,
  generatorFindingCap,
} from '@server/prompts/file-review';
import { defaultRepoConfig } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';

function fileAt(path: string): FileDiff {
  return {
    path,
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 1,
    hunks: [{
      header: '@@ -1,1 +1,1 @@',
      lines: [{ kind: 'add', content: 'const timeout = config.timeout;', newLineNumber: 1, position: 1 }],
    }],
  };
}

const promptFor = (path: string) => buildFileReviewPrompts({
  file: fileAt(path),
  prTitle: 'PR',
  prDescription: null,
  config: defaultRepoConfig.review,
});

describe('language guideline selection', () => {
  // `.tsx` used to match both the TypeScript and React entries, merging their personas.
  it('does not hand .tsx files a hook-dependency checklist', () => {
    const { systemPrompt, userPrompt } = promptFor('src/client/pages/settings.tsx');
    const combined = `${systemPrompt}\n${userPrompt}`;
    expect(combined).not.toMatch(/useEffect|useCallback|useMemo/);
    expect(combined).not.toMatch(/dependenc/i);
  });

  it('gives .tsx a single, un-merged persona', () => {
    const info = getLanguageForFile('src/client/pages/settings.tsx');
    // By identity, not string shape: a legitimate persona also contains "and".
    expect(info?.persona).toBe('an expert TypeScript engineer focused on correctness and safe async code');
    expect(info?.language).toBe('TypeScript/JavaScript');
    expect(info?.persona).not.toMatch(/react|hook/i);
  });

  it('never merges two entries into one persona or checklist', () => {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'py', 'sql', 'md', 'css', 'yml']) {
      const info = getLanguageForFile(`file.${ext}`);
      if (!info) continue;
      expect(info.language).not.toContain(' & ');
    }
  });

  it('still applies TypeScript guidance to .tsx', () => {
    const { userPrompt } = promptFor('src/client/pages/settings.tsx');
    expect(userPrompt).toMatch(/unhandled promise rejections/i);
  });

  it('keeps guidance the base prompt does not cover', () => {
    expect(promptFor('scripts/tool.py').userPrompt).toMatch(/mutable default arguments/i);
    expect(promptFor('db/migrations/004_x.sql').userPrompt).toMatch(/destructive/i);
    expect(promptFor('config/app.yml').userPrompt).toMatch(/hardcoded secrets/i);
  });

  it('falls back cleanly for an unknown extension', () => {
    expect(getLanguageForFile('bin/tool.xyz')).toBeUndefined();
    expect(promptFor('bin/tool.xyz').userPrompt).toContain('Language: Generic');
  });
});

// The output contract is stated four times (grammar `required`/`properties`, both prompts' schema
// blocks) and must agree, or the decoder emits one shape while the prose asks for another. Field
// order matters too: `evidence` is the only checkable field, so it comes before any prose.
describe('output contract', () => {
  const schema = buildReviewResponseSchema(10) as unknown as {
    schema: { properties: { findings: { items: { required: string[]; properties: Record<string, unknown> } } } };
  };
  const finding = schema.schema.properties.findings.items;
  const systemBase = buildFileReviewSystemPromptBase();
  const { userPrompt } = promptFor('src/app.ts');

  const orderIn = (text: string, fields: string[]) => fields.map((f) => text.indexOf(`"${f}"`));
  const isAscending = (positions: number[]) =>
    positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1]));

  it('requires evidence first, before any prose field', () => {
    expect(finding.required[0]).toBe('evidence');
    expect(finding.required.indexOf('evidence')).toBeLessThan(finding.required.indexOf('title'));
    expect(finding.required.indexOf('evidence')).toBeLessThan(finding.required.indexOf('body'));
    expect(finding.required.indexOf('evidence')).toBeLessThan(finding.required.indexOf('priority'));
  });

  // Several providers drive generation order from `properties`, not `required`.
  it('declares properties in the same order as required', () => {
    const declared = Object.keys(finding.properties);
    const requiredInDeclaredOrder = declared.filter((k) => finding.required.includes(k));
    expect(requiredInDeclaredOrder).toEqual(finding.required);
  });

  it('no longer solicits a per-finding confidence score', () => {
    expect(finding.required).not.toContain('confidence_score');
    expect(Object.keys(finding.properties)).not.toContain('confidence_score');
    expect(systemBase).not.toMatch(/"confidence_score"/);
    expect(userPrompt).not.toMatch(/"confidence_score"/);
    // Asking for a number nobody reads costs tokens and attention.
    expect(systemBase).not.toMatch(/calibrated/i);
  });

  it('states the same field order in both prose copies of the schema', () => {
    const fields = ['evidence', 'code_location', 'claim_type', 'title', 'body', 'priority'];
    expect(isAscending(orderIn(systemBase, fields))).toBe(true);
    expect(isAscending(orderIn(userPrompt, fields))).toBe(true);
  });

  // Restraints no downstream gate can check, so the generator is the only place to enforce them.
  it('keeps the restraints the gates cannot replace', () => {
    // Context limits: the model sees a diff, not a repository, a lockfile, or a build target.
    expect(systemBase).toMatch(/ONLY the diff/);
    expect(systemBase).toMatch(/Never predict that a change breaks callers, importers/);
    expect(systemBase).toMatch(/your training data predates the installed version/);
    expect(systemBase).toMatch(/Do not raise compatibility, polyfill, transpilation, engine-version or server-side-rendering concerns/);

    // The evidence mandate. Without it the parser withholds everything and recall goes to zero.
    expect(systemBase).toMatch(/copied VERBATIM from the diff/);
    expect(systemBase).toMatch(/you do not have a finding/);

    // External-version prohibition: 12 of the corpus's 23 denials.
    expect(systemBase).toMatch(/NEVER claim that a package, action, tag or version "does not exist"/);
    expect(systemBase).toMatch(/resolves by that SHA/);

    // Survives in both profiles: the model still emits "technically true, nobody cared" comments.
    // The base prompt now leaves this to the per-file instruction rather than repeating it.
    expect(userPrompt).toMatch(/avoid subjective style feedback/);

    // A claim resting on something outside the window may still be raised, but never as P0/P1.
    expect(systemBase).toMatch(/at most priority 3, never 0 or 1/);
  });
});

describe('the generator', () => {
  const systemBase = buildFileReviewSystemPromptBase();

  // Sentences duplicating a downstream gate; they measured 0.039 findings/file, no true positives.
  it('carries no prefer-empty framing', () => {
    expect(systemBase).not.toMatch(/Prefer returning an empty findings array/);
    expect(systemBase).not.toMatch(/confidently agree/);
    expect(promptFor('src/app.ts').userPrompt).not.toMatch(/Prefer no finding/);
  });

  // Not the posted cap: `max_comments` applies per job in finalize, this per chunk upstream of
  // four remove-only filters.
  it('lets the generator produce more candidates than can be posted', () => {
    const maxItems = (buildReviewResponseSchema(10) as unknown as {
      schema: { properties: { findings: { maxItems: number } } };
    }).schema.properties.findings.maxItems;

    expect(maxItems).toBe(20);
    expect(generatorFindingCap(10)).toBe(20);
    // Never zero, whatever an operator sets.
    expect(generatorFindingCap(1)).toBe(2);
  });

  // Two statements of one cap: the model obeys the prose, the decoder enforces the grammar.
  it('states the same cap in the grammar and in the prose', () => {
    expect(buildFileReviewSystemPrompt(defaultRepoConfig.review))
      .toContain(`Return at most ${generatorFindingCap(defaultRepoConfig.review.max_comments)} findings`);
  });
});

describe('PR description context', () => {
  // ContextCRBench: diff-only F1 36.08, +PR description 62.12, +enclosing function only 42.56.
  it('carries substantially more of the description than a single truncated paragraph', () => {
    const description = `${'x'.repeat(1_500)}NEEDLE${'y'.repeat(1_000)}`;
    const { userPrompt } = buildFileReviewPrompts({
      file: fileAt('src/app.ts'),
      prTitle: 'PR',
      prDescription: description,
      config: defaultRepoConfig.review,
    });

    expect(userPrompt).toContain('NEEDLE');
    // Still bounded - the whole body must not be pasted into a 16k-tokens-per-minute budget.
    expect(userPrompt).toContain('…');
  });

  it('omits the block entirely when there is no description', () => {
    expect(promptFor('src/app.ts').userPrompt).not.toMatch(/PR description/);
  });
});

// Negative few-shot exemplars: findings a human rejected here. The strongest measured lever at this
// model size (RAG at 20 shots took F1 36.35 → 74.05). Rejections only; an absent label means nothing.
describe('rejected exemplars', () => {
  const withExemplars = (exemplars: Array<{ title: string; claimType?: string | null }>) =>
    buildFileReviewPrompts({
      file: fileAt('src/app.ts'),
      prTitle: 'PR',
      prDescription: null,
      config: defaultRepoConfig.review,
      rejectedExemplars: exemplars,
    }).userPrompt;

  it('injects rejected findings as things not to report', () => {
    const prompt = withExemplars([{ title: 'Invalid GitHub Action version', claimType: 'external_version_claim' }]);
    expect(prompt).toMatch(/already rejected/i);
    expect(prompt).toContain('Invalid GitHub Action version');
    expect(prompt).toContain('external_version_claim');
  });

  it('omits the block entirely when there is nothing labelled', () => {
    expect(withExemplars([])).not.toMatch(/already rejected/i);
    expect(promptFor('src/app.ts').userPrompt).not.toMatch(/already rejected/i);
  });

  // Every character competes with the diff for a 16k-tokens/minute bucket.
  it('caps the block rather than letting it grow with the label count', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ title: `Rejected finding number ${i} with a long title` }));
    const prompt = withExemplars(many);

    // Count the exemplars that made it in, not the whole prompt.
    const included = many.filter((e) => prompt.includes(e.title));
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(20);
    expect(prompt).not.toContain('Rejected finding number 99');
  });
});
