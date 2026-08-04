import { describe, expect, it } from 'vitest';
import { verifyFindings } from '@server/core/review';
import { dedupeFindings } from '@server/core/model-output';
import { ruleHitsToComments, scanFileForRuleHits } from '@server/core/rules/detect';
import { defaultRepoConfig, type ParsedReviewComment, type RepoConfig } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';

function fileWith(path: string, added: string[]): FileDiff {
  return {
    path,
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: added.length,
    hunks: [{
      header: '@@ -1,5 +1,5 @@',
      lines: added.map((content, i) => ({
        kind: 'add' as const, content, newLineNumber: i + 1, position: i + 1,
      })),
    }],
  };
}

const liveRules = (file: FileDiff) =>
  ruleHitsToComments(file, scanFileForRuleHits(file, { shadowRuleIds: [] }));

const config: RepoConfig = {
  ...defaultRepoConfig,
  review: { ...defaultRepoConfig.review, rules: { enabled: true, disabled_rule_ids: [], shadow_rule_ids: [] } },
};

const llmComment = (over: Partial<ParsedReviewComment> = {}): ParsedReviewComment => ({
  path: 'src/a.ts',
  line: 1,
  position: 1,
  severity: 'P1',
  category: 'bugs',
  title: 'An LLM finding',
  body: 'Body',
  evidence: '  } catch (e) {}',
  ...over,
});

describe('the rule channel in the pipeline', () => {
  /**
   * The recall argument, stated as a test. If the model returns nothing the deterministic channel
   * must still produce a candidate — otherwise it buys nothing over a better prompt.
   */
  it('produces findings when the LLM produced none', () => {
    const file = fileWith('src/a.ts', ['  } catch (e) {}']);
    const comments = liveRules(file);

    expect(comments).toHaveLength(1);
    expect(comments[0].source).toBe('rule');
    expect(comments[0].ruleId).toBe('empty-catch');
  });

  it('survives dedupe across files, rather than collapsing on its constant title', () => {
    const a = liveRules(fileWith('src/a.ts', ['  } catch (e) {}']));
    const b = liveRules(fileWith('src/b.ts', ['  } catch (e) {}']));

    // Both rule findings carry the identical title. Title-keyed dedupe would leave one.
    expect(a[0].title).toBe(b[0].title);
    expect(dedupeFindings([...a, ...b])).toHaveLength(2);
  });

  it('keeps two hits of one rule in a single file distinct', () => {
    const file = fileWith('src/a.ts', ['  } catch (e) {}', '  } catch (err) {}']);
    expect(dedupeFindings(liveRules(file))).toHaveLength(2);
  });

  // The LLM finding has prose and grounded evidence; the rule hit is a constant template. When both
  // describe the same defect the richer one should be what a human reads.
  it('does not let a rule finding displace the LLM finding it duplicates', () => {
    const file = fileWith('src/a.ts', ['  } catch (e) {}']);
    const [rule] = liveRules(file);
    const llm = llmComment({ title: 'Errors are swallowed here', severity: 'P1' });

    const deduped = dedupeFindings([llm, rule]);
    expect(deduped).toContain(llm);
  });

  describe('fail-closed verification', () => {
    const file = fileWith('src/a.ts', ['  } catch (e) {}']);
    const job = { id: 'job-1' };
    const files = [file];

    /**
     * `verifyFindings` fails OPEN for LLM findings by design — deleting one nobody judged is worse
     * than posting it. Rule candidates must invert that, or promoting a rule out of shadow ships an
     * unfiltered candidate stream behind a filter that is not running.
     */
    it('drops rule candidates but keeps LLM findings when the verifier throws', async () => {
      const [rule] = liveRules(file);
      const llm = llmComment();

      const outcome = await verifyFindings({
        job,
        config,
        files,
        comments: [llm, rule],
        model: { verifyFindings: async () => { throw new Error('provider down'); } } as never,
      });

      expect(outcome.comments).toEqual([llm]);
      expect(outcome.stats.droppedRuleFailClosed).toBe(1);
      expect(outcome.dropped[0]?.disposition).toBe('rule_unverified');
    });

    it('reports zero fail-closed drops when the verifier actually answered', async () => {
      const llm = llmComment();
      const outcome = await verifyFindings({
        job,
        config,
        files,
        comments: [llm],
        model: {
          verifyFindings: async () => ({
            rawText: JSON.stringify({ results: [{ index: 0, reason: 'real', verdict: 'keep' }] }),
            modelUsed: 'test', provider: 'test', inputTokens: 1, outputTokens: 1,
          }),
        } as never,
      });

      expect(outcome.stats.droppedRuleFailClosed).toBe(0);
      expect(outcome.comments).toEqual([llm]);
    });
  });

  it('produces nothing for a rule whose claim type the repo denies', () => {
    const file = fileWith('src/a.ts', ['  } catch (e) {}']);
    const result = scanFileForRuleHits(file, {
      shadowRuleIds: [],
      deniedClaimTypes: ['swallowed_error'],
    });
    expect(ruleHitsToComments(file, result)).toEqual([]);
  });

  // Shadow is the shipping default: every rule scores itself on real pull requests before any of it
  // reaches a reviewer.
  it('defaults every shipped rule to shadow, so nothing posts without a deliberate promotion', () => {
    const file = fileWith('src/a.ts', ['  } catch (e) {}']);
    const result = scanFileForRuleHits(file, {
      shadowRuleIds: defaultRepoConfig.review.rules.shadow_rule_ids,
    });

    expect(result.stats.shadowHits).toBe(1);
    expect(ruleHitsToComments(file, result)).toEqual([]);
  });
});
