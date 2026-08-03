import { describe, expect, it } from 'vitest';
import { getLanguageForFile } from '@server/prompts/languages';
import { buildFileReviewPrompts } from '@server/prompts/file-review';
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
