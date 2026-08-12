import { describe, expect, it } from 'vitest';
import { looksLikeExternalVersionClaim, refuteUndecidableClaim } from '@server/core/claim-checks';
import { parseFileReviewResponse } from '@server/core/model-output';
import type { FileDiff } from '@server/core/diff';

// The fixtures below are the VERBATIM titles and bodies of findings codra posted on its own PR #86.
// Every one was checked against the repository and every one was false, and each was false for the
// same reason: it asserted something settled outside the diff -- an installed package's API surface,
// whether a symbol has consumers, or which runtime the code lands on. All five survived evidence
// grounding (their quoted lines were real) and the verification pass agreed with all of them, because
// the verifier shares the generator's knowledge gap. Deterministic refutation is the only gate left.
const PR86 = {
  zodApi: {
    title: 'Invalid Zod schema method call',
    body: 'Zod does not expose top-level `z.uuid()` or `z.url()` validator functions; string validations like UUID and URL must be chained off `z.string()`, such as `z.string().uuid()`. Using `z.uuid()` directly results in a runtime TypeError when the schema is evaluated.',
  },
  removedExportSelector: {
    title: 'Removed export keyword from ModelSelector',
    body: 'The export keyword was removed from ModelSelector, which will cause compilation and import errors in other modules that rely on importing ModelSelector from this file.',
  },
  removedExportChain: {
    title: 'Removed export keyword from ModelChain',
    body: 'The export keyword was removed from ModelChain, preventing external files from importing this component.',
  },
  toSorted: {
    title: 'Use of toSorted method which might not exist in all Node/JS environments',
    body: 'The array method `toSorted` is a relatively new addition to ECMAScript (Node.js 20+). Depending on the runtime target, using `toSorted()` directly on an array without a polyfill or spreading via `[...modelCfg.size_overrides].sort(...)` can cause a TypeError in older Node versions.',
  },
  windowInRender: {
    title: 'Accessing window object during render',
    body: 'Accessing `window.innerHeight` directly in the component body can lead to hydration mismatches in Next.js or SSR environments, as `window` is not defined on the server. If this component is rendered server-side, it will throw a ReferenceError.',
  },
} as const;

describe('library-API claims route into the external-version denial', () => {
  // The pattern list already covered "does not exist"; this claim said "does not expose", so it
  // sailed through as `other` -- which CLAIM_TYPE_DECIDABILITY marks diff_local -- and posted as a P0.
  it('recognises the z.uuid() claim from PR #86', () => {
    expect(looksLikeExternalVersionClaim(PR86.zodApi.title, PR86.zodApi.body)).toBe(true);
  });

  it('recognises the other ways a model says an API is absent', () => {
    for (const body of [
      'The library does not provide a top-level helper for this.',
      'There is no such method on the client.',
      'This helper is not exported from the package root.',
    ]) {
      expect(looksLikeExternalVersionClaim('API misuse', body)).toBe(true);
    }
  });

  // The relabel must not swallow ordinary findings that happen to discuss what code does not do.
  it('leaves claims about the code in the diff alone', () => {
    for (const body of [
      'The catch block does not rethrow, so the caller sees a success it never got.',
      'This query does not use a parameter placeholder, so the term is interpolated into SQL.',
      'The effect does not clean up its subscription on unmount.',
    ]) {
      expect(looksLikeExternalVersionClaim('Defect', body)).toBe(false);
    }
  });
});

describe('cross-file breakage claims are undecidable from a diff', () => {
  it('refutes both removed-export claims from PR #86', () => {
    expect(refuteUndecidableClaim(PR86.removedExportSelector)).toBe('cross-file');
    expect(refuteUndecidableClaim(PR86.removedExportChain)).toBe('cross-file');
  });

  // Two signals are required, so neither half alone suppresses anything.
  it('does not refute on a cross-file mention with no predicted breakage', () => {
    expect(refuteUndecidableClaim({
      title: 'Duplicated helper',
      body: 'Other modules define a similar helper; consider consolidating them later.',
    })).toBeNull();
  });

  it('does not refute on breakage predicted about the code actually shown', () => {
    expect(refuteUndecidableClaim({
      title: 'Unbalanced braces',
      body: 'The added block never closes, so this file fails to compile.',
    })).toBeNull();
  });
});

describe('environment-conditional claims are undecidable from a diff', () => {
  it('refutes the toSorted and window claims from PR #86', () => {
    expect(refuteUndecidableClaim(PR86.toSorted)).toBe('environment');
    expect(refuteUndecidableClaim(PR86.windowInRender)).toBe('environment');
  });

  it('does not refute a hedge that is not about the environment', () => {
    expect(refuteUndecidableClaim({
      title: 'Possible null dereference',
      body: 'Depending on the caller, `user` may not be set before this line runs.',
    })).toBeNull();
  });

  it('does not refute a definite statement about a real environment constraint', () => {
    // No hedge: the claim is that the code as written cannot work here, which the diff can settle.
    expect(refuteUndecidableClaim({
      title: 'Node API used in a Worker',
      body: 'This calls `fs.readFileSync`, which the Workers runtime does not implement at all.',
    })).toBeNull();
  });
});

describe('the guards leave genuine findings untouched', () => {
  // The five defects codra posts most reliably on the benchmark corpus. If any of these start being
  // refuted, a guard has gone too far.
  it('passes through the high-confidence defect families', () => {
    for (const fixture of [
      { title: 'SQL injection in findUserByEmail', body: 'The email is interpolated straight into the statement, so a crafted address changes the query.' },
      { title: 'Authentication bypass in catch block', body: 'The catch returns true, so any error during verification authenticates the request.' },
      { title: 'Missing await on chargeCard', body: 'The charge promise is never awaited, so the order is marked paid before the card is charged.' },
      { title: 'Hardcoded live secret API key', body: 'A live `sk_live_` key is committed as a fallback and will be used whenever the environment variable is unset.' },
      { title: 'Mass update without filtering', body: 'The UPDATE has no WHERE clause, so every order in the table is archived.' },
    ]) {
      expect(refuteUndecidableClaim(fixture)).toBeNull();
      expect(looksLikeExternalVersionClaim(fixture.title, fixture.body)).toBe(false);
    }
  });
});

describe('an empty code_suggestion must not destroy the finding', () => {
  // Observed 256 times across an 800-review sweep. `codeSuggestion` is z.string().min(1), so a model
  // that emits `"code_suggestion": ""` used to throw a ZodError inside buildParsedComment and lose the
  // whole comment as `unverified:unassemblable` -- including real defects.
  const file: FileDiff = {
    path: 'src/auth/session.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 2,
    hunks: [{
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { kind: 'add', content: "  return process.env.SESSION_SECRET ?? 'hardcoded-dev-secret';", newLineNumber: 1, position: 1 },
        { kind: 'add', content: '}', newLineNumber: 2, position: 2 },
      ],
    }],
  };

  const payload = (codeSuggestion: unknown) => JSON.stringify({
    findings: [{
      evidence: "  return process.env.SESSION_SECRET ?? 'hardcoded-dev-secret';",
      code_location: { absolute_file_path: 'src/auth/session.ts', line: 1 },
      claim_type: 'hardcoded_secret',
      title: 'Fallback to a hardcoded session secret',
      body: 'The signing secret falls back to a literal, so tokens can be forged wherever the env var is unset.',
      priority: 1,
      code_suggestion: codeSuggestion,
    }],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'one finding',
  });

  for (const [label, value] of [['an empty string', ''], ['whitespace only', '   \n  ']] as const) {
    it(`keeps the finding when the suggestion is ${label}`, () => {
      const parsed = parseFileReviewResponse(payload(value), file);
      expect(parsed.comments).toHaveLength(1);
      expect(parsed.comments[0].title).toBe('Fallback to a hardcoded session secret');
      expect(parsed.comments[0].codeSuggestion).toBeUndefined();
      // And the empty fence must not reach the posted body either.
      expect(parsed.comments[0].body).not.toContain('```suggestion');
    });
  }

  it('still carries a real suggestion through', () => {
    const parsed = parseFileReviewResponse(payload("  return requireEnv('SESSION_SECRET');"), file);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].codeSuggestion).toBe("  return requireEnv('SESSION_SECRET');");
    expect(parsed.comments[0].body).toContain('```suggestion');
  });
});

describe('claims about a callee handling its own errors are undecidable', () => {
  // Posted as a P1 on codra's own PR #86 after the first round of guards shipped. `loadCooldowns`
  // already wraps its only failure path in try/catch -- in another file, with a comment saying "never
  // fail the review for it" -- so the rejection the claim depends on cannot occur. The verifier
  // nonetheless marked it `decidable: true`, which is why this needs a deterministic gate too.
  const PR86_SECOND_ROUND = {
    title: 'Unhandled promise rejection in async initializer',
    body: 'The `hydrate` method uses an async IIFE to initialize state. If the `this.persistence.loadCooldowns()` call fails (a network call or database query), the resulting promise rejection will be unhandled as it is assigned to `this.hydrated` without a `.catch()` block or internal try/catch. This can lead to unhandled promise rejections and potential process crashes in some environments.',
  };

  it('refutes the unhandled-rejection claim about an unseen callee', () => {
    expect(refuteUndecidableClaim(PR86_SECOND_ROUND)).toBe('callee-errors');
  });

  it('refutes the same shape however it is worded', () => {
    for (const body of [
      'If `fetchUser()` rejects, nothing catches it and the worker crashes.',
      'When loadConfig() throws, the rejection is not handled anywhere.',
    ]) {
      expect(refuteUndecidableClaim({ title: 'Unhandled rejection', body })).toBe('callee-errors');
    }
  });

  // The visible-code equivalents must still get through: these are about what the diff itself does.
  it('leaves claims about error handling in the shown code alone', () => {
    for (const body of [
      'The catch block returns true, so any error during verification authenticates the request.',
      'This empty catch swallows the write failure with no logging.',
      'The added line assigns the promise to a field and never awaits it, so the order is marked paid first.',
    ]) {
      expect(refuteUndecidableClaim({ title: 'Defect', body })).toBeNull();
    }
  });
});
