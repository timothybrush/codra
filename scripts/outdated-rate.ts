/**
 * Outdated Rate: the share of flagged lines a developer actually modified afterwards.
 *
 *   npx vite-node scripts/outdated-rate.ts -- --repo devarshishimpi/codra
 *
 * Why this metric and not precision: it needs ZERO human annotation and is measured against what
 * happened rather than what someone said. BitsAI-CR runs at roughly 65% precision / 25% Outdated
 * Rate, and uses it as the retirement signal — a rule with high precision and a low Outdated Rate is
 * technically right and practically ignored, which is a rule worth deleting.
 *
 * The measurement, precisely: for a job A that posted findings, find the next job B on the same PR
 * at a DIFFERENT commit, diff A's head against B's head, and check whether any changed line hashes
 * to one of A's anchor hashes. A `-` line matching means the flagged line was rewritten, i.e. acted
 * upon.
 *
 * Deliberately NOT the pure-SQL alternative ("did job B re-derive the same fingerprint_v2?"). That
 * is a biased estimator: it cannot distinguish "the line was fixed" from "the model was flaky", and
 * flakiness is exactly what this system has too much of for that to be safe.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { buildUnifiedDiffFromFiles, parseUnifiedDiff } from '@server/core/diff';
import { buildAnchorHash } from '@server/core/fingerprint';

const argOf = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const [owner, repo] = argOf('repo', 'devarshishimpi/codra').split('/');
const databaseUrl = readFileSync('.dev.vars', 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)![1];
const sql = postgres(databaseUrl, { ssl: 'require', max: 1 });

type Candidate = {
  job_id: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  anchor_hashes: string[];
  rule_ids: (string | null)[];
};

/** Unauthenticated compare, same as the fixture recorder. Rebuilt from the JSON file list because
 *  the unified-diff media type 406s past 20,000 lines. */
async function changedLineHashes(base: string, head: string): Promise<Set<string>> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`compare ${base.slice(0, 8)}...${head.slice(0, 8)}: ${res.status}`);

  const payload = (await res.json()) as { files?: Array<Record<string, unknown>> };
  const raw = buildUnifiedDiffFromFiles((payload.files ?? []) as never);

  const hashes = new Set<string>();
  for (const file of parseUnifiedDiff(raw)) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        // A REMOVED line that matches an anchor is the signal: that exact line no longer exists.
        if (line.kind === 'del') hashes.add(buildAnchorHash(line.content));
      }
    }
  }
  return hashes;
}

async function main() {
  const candidates = await sql<Candidate[]>`
    WITH posted AS (
      SELECT j.id AS job_id, j.pr_number, j.created_at,
             encode(j.commit_sha, 'hex') AS head_sha,
             ARRAY_AGG(rc.anchor_hash) FILTER (WHERE rc.anchor_hash IS NOT NULL) AS anchor_hashes,
             ARRAY_AGG(rc.rule_id)     FILTER (WHERE rc.anchor_hash IS NOT NULL) AS rule_ids
      FROM jobs j
      JOIN repositories   r  ON r.id = j.repository_id
      JOIN file_reviews   fr ON fr.job_id = j.id
      JOIN review_comments rc ON rc.file_review_id = fr.id
      WHERE r.owner = ${owner} AND r.repo = ${repo} AND rc.posted
      GROUP BY j.id, j.pr_number, j.created_at, j.commit_sha
    )
    SELECT p.job_id, p.pr_number, p.head_sha AS base_sha,
           encode(n.commit_sha, 'hex') AS head_sha,
           p.anchor_hashes, p.rule_ids
    FROM posted p
    JOIN LATERAL (
      SELECT j2.commit_sha FROM jobs j2
      JOIN repositories r2 ON r2.id = j2.repository_id
      WHERE r2.owner = ${owner} AND r2.repo = ${repo}
        AND j2.pr_number = p.pr_number
        AND j2.created_at > p.created_at
        AND encode(j2.commit_sha, 'hex') <> p.head_sha
      ORDER BY j2.created_at ASC LIMIT 1
    ) n ON true
    WHERE p.anchor_hashes IS NOT NULL
    ORDER BY p.created_at DESC
    LIMIT 50`;

  if (candidates.length === 0) {
    console.log('No measurable job pairs yet. This needs a PR that was reviewed, then pushed to again.');
    await sql.end();
    return;
  }

  let flagged = 0;
  let acted = 0;
  const byRule = new Map<string, { flagged: number; acted: number }>();

  for (const candidate of candidates) {
    let changed: Set<string>;
    try {
      changed = await changedLineHashes(candidate.base_sha, candidate.head_sha);
    } catch (error) {
      // A force-push breaks the compare. Skipping is correct: the pair is unmeasurable, not zero.
      console.warn(`skipped job ${candidate.job_id.slice(0, 8)}: ${(error as Error).message}`);
      continue;
    }

    candidate.anchor_hashes.forEach((hash, index) => {
      const ruleId = candidate.rule_ids[index] ?? 'llm';
      const entry = byRule.get(ruleId) ?? { flagged: 0, acted: 0 };
      flagged += 1;
      entry.flagged += 1;
      if (changed.has(hash)) {
        acted += 1;
        entry.acted += 1;
      }
      byRule.set(ruleId, entry);
    });
  }

  const rate = flagged > 0 ? Math.round((acted / flagged) * 1000) / 10 : 0;
  console.log(`\njob pairs measured   ${candidates.length}`);
  console.log(`findings flagged     ${flagged}`);
  console.log(`lines later changed  ${acted}`);
  console.log(`OUTDATED RATE        ${rate}%   (BitsAI-CR operates at ~25%)`);

  console.log('\nby channel/rule:');
  for (const [ruleId, entry] of [...byRule].sort((a, b) => b[1].flagged - a[1].flagged)) {
    const ruleRate = entry.flagged > 0 ? Math.round((entry.acted / entry.flagged) * 1000) / 10 : 0;
    console.log(`  ${ruleId.padEnd(22)} ${String(entry.acted).padStart(3)}/${String(entry.flagged).padEnd(3)}  ${ruleRate}%`);
  }

  // n is stated because it is the whole caveat: at n=12 this number is a hint, not a measurement.
  console.log(`\nn = ${flagged}. Below ~50 findings treat this as directional only.`);
  await sql.end();
}

await main();
