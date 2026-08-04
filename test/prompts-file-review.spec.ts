import { describe, expect, it } from 'vitest';
import { getLanguageForFile } from '@server/prompts/languages';
import {
  buildFileReviewPrompts,
  buildFileReviewSystemPrompt,
  buildFileReviewSystemPromptBase,
  buildReviewResponseSchema,
  generatorFindingCap,
  type GeneratorProfile,
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

const PROFILES: GeneratorProfile[] = ['strict', 'balanced'];

const promptFor = (path: string, profile: GeneratorProfile = 'strict') => buildFileReviewPrompts({
  file: fileAt(path),
  prTitle: 'PR',
  prDescription: null,
  config: { ...defaultRepoConfig.review, generator_profile: profile },
});

describe('language guideline selection', () => {
  // The whole reason this file exists. `.tsx` used to match BOTH the TypeScript entry and the React
  // entry, and the merge concatenated both personas and unioned both guideline sets -- so every
  // React file arrived carrying "flag missing useEffect/useCallback/useMemo dependencies". That
  // steered the model into a claim family that is 0-for-28 lifetime in production.
  it('does not hand .tsx files a hook-dependency checklist', () => {
    const { systemPrompt, userPrompt } = promptFor('src/client/pages/settings.tsx');
    const combined = `${systemPrompt}\n${userPrompt}`;
    expect(combined).not.toMatch(/useEffect|useCallback|useMemo/);
    expect(combined).not.toMatch(/dependenc/i);
  });

  it('gives .tsx a single, un-merged persona', () => {
    const info = getLanguageForFile('src/client/pages/settings.tsx');
    // Assert the merge is gone by identity, not by string shape: the legitimate TypeScript persona
    // contains the word "and" on its own ("correctness and safe async code"), so a naive
    // not-to-contain(' and ') check cannot distinguish a merge from a normal persona.
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

/**
 * The output contract is stated FOUR times — the grammar's `required`, the grammar's `properties`, the
 * system prompt's SCHEMA FORMAT block, and the user prompt's schema block. If they disagree, a provider
 * that constrains decoding emits one shape while the prose asks for another.
 *
 * Field order is load-bearing, not cosmetic: `evidence` is the only checkable field (the parser matches it
 * against the diff and withholds the finding if it does not resolve), so it must be emitted before any
 * prose. Strict schemas cost 10-30% reasoning accuracy through premature serialization, and the penalty is
 * worst on capacity-limited models — which is this entire chain.
 */
// Run against BOTH profiles. The contract is not what the relaxation is allowed to change, and a
// profile that only exists on one code path is how a flag silently ships half-applied.
describe.each(PROFILES)('output contract (%s profile)', (profile) => {
  const schema = buildReviewResponseSchema(10, profile) as unknown as {
    schema: { properties: { findings: { items: { required: string[]; properties: Record<string, unknown> } } } };
  };
  const finding = schema.schema.properties.findings.items;
  const systemBase = buildFileReviewSystemPromptBase(profile);
  const { userPrompt } = promptFor('src/app.ts', profile);

  const orderIn = (text: string, fields: string[]) => fields.map((f) => text.indexOf(`"${f}"`));
  const isAscending = (positions: number[]) =>
    positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1]));

  it('requires evidence first, before any prose field', () => {
    expect(finding.required[0]).toBe('evidence');
    expect(finding.required.indexOf('evidence')).toBeLessThan(finding.required.indexOf('title'));
    expect(finding.required.indexOf('evidence')).toBeLessThan(finding.required.indexOf('body'));
    expect(finding.required.indexOf('evidence')).toBeLessThan(finding.required.indexOf('priority'));
  });

  // Several providers drive generation order from the property declaration order rather than `required`,
  // so a mismatch would defeat the reordering on precisely the provider that enforces the grammar.
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
    // The calibration instruction went with it — asking for a calibrated number nobody reads is worse
    // than not asking, because it consumes tokens and the model's attention.
    expect(systemBase).not.toMatch(/calibrated/i);
  });

  it('states the same field order in both prose copies of the schema', () => {
    const fields = ['evidence', 'code_location', 'claim_type', 'title', 'body', 'priority'];
    expect(isAscending(orderIn(systemBase, fields))).toBe(true);
    expect(isAscending(orderIn(userPrompt, fields))).toBe(true);
  });

  /**
   * The restraints that encode something NO downstream gate can check. The generator is the only
   * place these can be enforced, so the relaxation must not touch them — and all of them sat
   * completely untested before Phase 2, which is how "relax the generator" could have quietly
   * deleted the one instruction keeping the model from inventing missing imports.
   */
  it('keeps the restraints the gates cannot replace', () => {
    // Context limits: the model sees a diff, not a repository.
    expect(systemBase).toMatch(/ONLY the diff/);
    expect(systemBase).toMatch(/undefined, unimported, unused, missing, or never-called/);
    expect(systemBase).toMatch(/If confirming an issue requires code you cannot see, do not report it/);

    // The evidence mandate. Without it the parser withholds everything and recall goes to zero.
    expect(systemBase).toMatch(/copied VERBATIM from the diff/);
    expect(systemBase).toMatch(/you do not have a finding/);

    // The external-version prohibition. This family was 12 of the corpus's 23 denials and produced
    // four separate false findings against SHA-pinned actions that a passing CI job disproved.
    expect(systemBase).toMatch(/NEVER claim that a package, action, tag or version "does not exist"/);
    expect(systemBase).toMatch(/resolves by that SHA/);

    // Subjective-preference exclusion survives in both profiles: the audit shows the model still
    // emits these, and they are the classic "technically true, nobody cared" review comment.
    expect(systemBase).toMatch(/Do NOT report subjective preferences/);
  });
});

describe('generator profiles', () => {
  const strictBase = buildFileReviewSystemPromptBase('strict');
  const balancedBase = buildFileReviewSystemPromptBase('balanced');

  it('actually differ, so the flag is not decorative', () => {
    expect(balancedBase).not.toBe(strictBase);
    expect(promptFor('src/app.ts', 'balanced').userPrompt)
      .not.toBe(promptFor('src/app.ts', 'strict').userPrompt);
  });

  // The specific sentences Phase 2 set out to retire. Each duplicated a downstream gate, and behind
  // four serial filters they produced 0.039 findings/file with zero true positives.
  it('drops the prefer-empty framing under balanced, and keeps it under strict', () => {
    expect(strictBase).toMatch(/Prefer returning an empty findings array/);
    expect(balancedBase).not.toMatch(/Prefer returning an empty findings array/);

    expect(strictBase).toMatch(/would confidently agree it is a genuine defect/);
    expect(balancedBase).not.toMatch(/confidently agree/);

    expect(promptFor('src/app.ts', 'strict').userPrompt).toMatch(/Prefer no finding over a speculative one/);
    expect(promptFor('src/app.ts', 'balanced').userPrompt).not.toMatch(/Prefer no finding/);
  });

  /**
   * The generator cap is not the posted cap, and pinning it is the point: `max_comments` is applied
   * per JOB in finalize, while this applies per CHUNK upstream of four filters that only remove.
   * Setting them equal throttles the generator to the volume that would survive if nothing were ever
   * filtered — which never happens.
   */
  it('lets the generator produce more candidates than can be posted', () => {
    const capOf = (profile: 'strict' | 'balanced') =>
      (buildReviewResponseSchema(10, profile) as unknown as {
        schema: { properties: { findings: { maxItems: number } } };
      }).schema.properties.findings.maxItems;

    expect(capOf('strict')).toBe(10);
    expect(capOf('balanced')).toBe(20);
    expect(generatorFindingCap(10, 'balanced')).toBeGreaterThan(generatorFindingCap(10, 'strict'));
    // Never zero, whatever an operator sets.
    expect(generatorFindingCap(1, 'strict')).toBe(1);
  });

  // The grammar and the prose must agree on the number. They are two statements of one cap, and the
  // model obeys the prose while the decoder enforces the grammar.
  it('states the same cap in the grammar and in the prose', () => {
    for (const profile of PROFILES) {
      const expected = generatorFindingCap(10, profile);
      expect(buildFileReviewSystemPrompt({ ...defaultRepoConfig.review, generator_profile: profile }))
        .toContain(`Return at most ${expected} findings`);
    }
  });
});

describe('PR description context', () => {
  // Diff-only scores F1 36.08 on ContextCRBench; adding the PR description reaches 62.12 (+72% relative),
  // where adding the enclosing function reaches only 42.56 and was negative for open models. Author
  // intent is the highest-value context per token in the prompt, and 500 chars discarded most of it.
  it('carries substantially more of the description than a single truncated paragraph', () => {
    const description = `${'x'.repeat(1_500)}NEEDLE${'y'.repeat(1_000)}`;
    const { userPrompt } = buildFileReviewPrompts({
      file: fileAt('src/app.ts'),
      prTitle: 'PR',
      prDescription: description,
      config: defaultRepoConfig.review,
    });

    expect(userPrompt).toContain('NEEDLE');
    // Still bounded — the whole body must not be pasted into a 16k-tokens-per-minute budget.
    expect(userPrompt).toContain('…');
  });

  it('omits the block entirely when there is no description', () => {
    expect(promptFor('src/app.ts').userPrompt).not.toMatch(/PR description/);
  });
});

/**
 * Negative few-shot exemplars: findings a human already rejected in this repository.
 *
 * Retrieval is the strongest measured lever for models this size (RAG at 20 shots took F1 36.35 →
 * 74.05 on this task, with larger gains the smaller the model). Only REJECTED findings are shown —
 * that is the label there is actual data for, since an absent label means nothing.
 */
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

  // Every exemplar character competes with the diff for a 16k-tokens-per-minute bucket, so the block
  // is capped. A prompt that no longer fits is worth less than one with fewer exemplars.
  it('caps the block rather than letting it grow with the label count', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ title: `Rejected finding number ${i} with a long title` }));
    const prompt = withExemplars(many);

    // Count the exemplars that actually made it in, rather than measuring to the end of the prompt.
    const included = many.filter((e) => prompt.includes(e.title));
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(20);
    expect(prompt).not.toContain('Rejected finding number 99');
  });
});
