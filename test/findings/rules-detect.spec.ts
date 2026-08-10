import { describe, expect, it } from 'vitest';
import { scanFileForRuleHits, ruleHitsToComments } from '@server/core/rules/detect';
import { RULES } from '@server/core/rules/table';
import { CLAIM_TYPE_DECIDABILITY, DEFAULT_SHADOW_RULE_IDS } from '@shared/schema';

import { addedLinesFile } from '../mocks/fixtures';

// Every rule gets a true positive AND a fixture for each false-positive route it must survive:
// a comment, a string literal, a removed line -- the three ways a regex over a diff usually goes wrong.
const fileWith = addedLinesFile;

const scan = (path: string, added: string[], removed: string[] = []) =>
  scanFileForRuleHits(fileWith(path, added, removed), { shadowRuleIds: [] });

const ruleIds = (path: string, added: string[], removed: string[] = []) =>
  scan(path, added, removed).hits.map((h) => h.rule.id);

describe('rule table invariants', () => {
  // A rule whose claim type is denied downstream would generate candidates that can never post.
  it('only uses claim types decidable from the diff alone', () => {
    for (const rule of RULES) {
      expect(CLAIM_TYPE_DECIDABILITY[rule.claimType], rule.id).toBe('diff_local');
    }
  });

  it('gives every rule a cheap trigger, so the sieve can reject lines before any regex runs', () => {
    for (const rule of RULES) {
      expect(rule.triggers.length, rule.id).toBeGreaterThan(0);
      expect(rule.triggers.every((t) => t.length >= 3), rule.id).toBe(true);
    }
  });

  it('has unique rule ids', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });

  // Without this, adding a rule to the table and forgetting the shadow list posts it live on the
  // next deploy. That is the one mistake in this file with no other backstop.
  it('ships every rule in shadow, including the disabled ones', () => {
    for (const rule of RULES) {
      expect(DEFAULT_SHADOW_RULE_IDS as readonly string[], rule.id).toContain(rule.id);
    }
  });
});

describe('empty-catch', () => {
  it('fires on a genuinely empty catch', () => {
    expect(ruleIds('a.ts', ['  } catch (e) {}'])).toContain('empty-catch');
    expect(ruleIds('a.ts', ['  } catch {}'])).toContain('empty-catch');
  });

  // The escape hatch, and the reason the rule runs on STRIPPED text: a documented empty catch is a
  // deliberate choice, and the comment survives stripping as whitespace rather than vanishing.
  it('does not fire when the catch body carries an explanatory comment', () => {
    expect(ruleIds('a.ts', ['  } catch (e) { /* intentional: probe only */ }'])).not.toContain('empty-catch');
  });

  it('does not fire when the catch has a body', () => {
    expect(ruleIds('a.ts', ['  } catch (e) { logger.warn(e); }'])).not.toContain('empty-catch');
  });
});

describe('dynamic-html-sink', () => {
  it('fires on a non-literal assignment', () => {
    expect(ruleIds('a.ts', ['  el.innerHTML = userHtml;'])).toContain('dynamic-html-sink');
  });

  // The string case: stripping removes the literal, so the right-hand side is empty and cannot match.
  it('does not fire when clearing with a literal', () => {
    expect(ruleIds('a.ts', ["  el.innerHTML = '';"])).not.toContain('dynamic-html-sink');
    expect(ruleIds('a.ts', ['  el.innerHTML = "<br>";'])).not.toContain('dynamic-html-sink');
  });
});

describe('destructive-migration', () => {
  it('fires on statements that discard rows', () => {
    expect(ruleIds('m.sql', ['ALTER TABLE jobs DROP COLUMN legacy_id;'])).toContain('destructive-migration');
    expect(ruleIds('m.sql', ['DROP TABLE old_reviews;'])).toContain('destructive-migration');
    expect(ruleIds('m.sql', ['TRUNCATE TABLE staging;'])).toContain('destructive-migration');
  });

  // This repository's own migrations use these constantly; matching them would make the rule noise.
  it('does not fire on non-destructive DROPs', () => {
    expect(ruleIds('m.sql', ['DROP INDEX IF EXISTS jobs_idx;'])).not.toContain('destructive-migration');
    expect(ruleIds('m.sql', ['ALTER TABLE jobs ALTER COLUMN x DROP NOT NULL;'])).not.toContain('destructive-migration');
    expect(ruleIds('m.sql', ['ALTER TABLE jobs ALTER COLUMN x DROP DEFAULT;'])).not.toContain('destructive-migration');
  });
});

describe('the other Tier-1 rules', () => {
  it('detects debugger, focused tests, eval and mutable defaults', () => {
    expect(ruleIds('a.ts', ['  debugger;'])).toContain('debugger-statement');
    expect(ruleIds('a.spec.ts', ["  it.only('x', () => {});"])).toContain('focused-test');
    expect(ruleIds('a.ts', ['  const r = eval(input);'])).toContain('dynamic-code-exec');
    expect(ruleIds('a.ts', ['  const f = new Function(src);'])).toContain('dynamic-code-exec');
    expect(ruleIds('s.py', ['def f(items=[]):'])).toContain('mutable-default-arg');
  });

  it('respects file extensions', () => {
    // A Python default-arg rule must not fire on TypeScript, and vice versa.
    expect(ruleIds('a.ts', ['def f(items=[]):'])).not.toContain('mutable-default-arg');
    expect(ruleIds('s.py', ['  debugger;'])).not.toContain('debugger-statement');
  });

  it('does not fire on prose in a comment', () => {
    expect(ruleIds('a.ts', ['  // remember to remove the debugger; statement'])).toEqual([]);
    expect(ruleIds('a.ts', ['  // never call eval(x) here'])).toEqual([]);
  });
});

describe('cross-cutting suppressions', () => {
  it('ignores removed lines entirely', () => {
    const result = scan('a.ts', ['  const x = 1;'], ['  debugger;']);
    expect(result.hits).toEqual([]);
  });

  // If the identical line was also removed in this hunk, the PR moved/reindented existing code
  // rather than introducing it -- reporting it would blame the author for someone else's line.
  it('suppresses a hit whose line was merely moved, and counts it', () => {
    const result = scan('a.ts', ['    debugger;'], ['  debugger;']);
    expect(result.hits).toEqual([]);
    expect(result.stats.suppressedAsMoved).toBe(1);
  });

  it('caps the scan on a huge file and says so', () => {
    const added = Array.from({ length: 5_000 }, (_, i) => `  const value${i} = ${i};`);
    const result = scan('a.ts', added);
    expect(result.stats.truncated).toBe(true);
    expect(result.stats.addedLinesScanned).toBeLessThanOrEqual(600);
  });

  // The sieve is what keeps this inside a 10ms CPU budget: innocuous lines must never be stripped.
  it('rejects innocuous lines before stripping them', () => {
    const added = Array.from({ length: 1_000 }, (_, i) => `  const value${i} = ${i};`);
    expect(scan('a.ts', added).stats.sievePassed).toBe(0);
  });

  it('honours the denied claim types and the disabled list', () => {
    const file = fileWith('a.ts', ['  } catch (e) {}']);
    expect(scanFileForRuleHits(file, { deniedClaimTypes: ['swallowed_error'] }).hits).toEqual([]);
    expect(scanFileForRuleHits(file, { disabledRuleIds: ['empty-catch'] }).hits).toEqual([]);
  });

  it('reports shadow hits separately and produces no comment for them', () => {
    const file = fileWith('a.ts', ['  } catch (e) {}']);
    const result = scanFileForRuleHits(file, { shadowRuleIds: ['empty-catch'] });
    expect(result.stats.shadowHits).toBe(1);
    expect(result.stats.hits).toBe(0);
    expect(ruleHitsToComments(file, result)).toEqual([]);
  });
});

describe('ruleHitsToComments', () => {
  it('marks findings as rule-sourced and carries the rule id', () => {
    const file = fileWith('a.ts', ['  } catch (e) {}']);
    const [comment] = ruleHitsToComments(file, scanFileForRuleHits(file, { shadowRuleIds: [] }));

    expect(comment.source).toBe('rule');
    expect(comment.ruleId).toBe('empty-catch');
    expect(comment.claimType).toBe('swallowed_error');
    // Evidence is the real line, so the same grounding checks apply as to an LLM finding.
    expect(comment.evidence).toBe('  } catch (e) {}');
    expect(comment.anchorHash).toBeTruthy();
  });

  // `buildFindingFingerprint` is f(path, title) and a rule's title is a CONSTANT, so without mixing
  // the anchor hash in, two hits of one rule in one file would collide and share a disposition.
  it('gives two hits of the same rule in one file distinct fingerprints', () => {
    const file = fileWith('a.ts', ['  } catch (e) {}', '  } catch (err) {}']);
    const comments = ruleHitsToComments(file, scanFileForRuleHits(file, { shadowRuleIds: [] }));

    expect(comments).toHaveLength(2);
    expect(comments[0].fingerprint).not.toBe(comments[1].fingerprint);
    expect(comments[0].fingerprintV2).not.toBe(comments[1].fingerprintV2);
  });
});
