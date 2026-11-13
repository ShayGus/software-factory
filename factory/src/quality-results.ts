import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { CommitSchema, QualityResultSchema, type QualityResult } from './review-contracts.js';
import { digestText } from './instruction-context.js';
import { parseStrictJson } from './strict-json.js';

// Inspected roborev v0.74.0-fmpatch.1: show --json returns a review with a
// nested job. Closed is workflow state, never evidence of a passing verdict.
export function parseRoborevResult(raw: string, commit: string, observedAt: string): QualityResult {
  CommitSchema.parse(commit);
  const review = z.object({ job_id: z.number().int().positive(), output: z.string(),
    created_at: z.string(), structured_output: z.object({ verdict: z.enum(['pass', 'fail', 'unable_to_review']) }).nullish(),
    job: z.object({ id: z.number().int().positive(), git_ref: z.string(), status: z.literal('done'), job_type: z.literal('review') }),
  }).parse(parseStrictJson(raw));
  if (review.job.git_ref !== commit || review.job.id !== review.job_id) throw new Error('quality_review_commit_or_job_mismatch');
  const verdict = review.structured_output?.verdict;
  return QualityResultSchema.parse({ tool: 'roborev', commit, jobId: review.job_id,
    verdict: verdict === 'pass' ? 'passed' : verdict === 'fail' ? 'failed' : 'uncertain',
    artifact: { uri: `roborev:job/${review.job_id}`, revision: commit, digest: digestText(raw) }, observedAt, raw });
}

/** Reads an existing review only. Never enqueues review, analyze, tests or fixes. */
export function readRoborevResult(repository: string, commit: string, observedAt: string,
  executable = 'roborev'): QualityResult {
  CommitSchema.parse(commit);
  const result = spawnSync(executable, ['show', '--json', commit], { cwd: repository, encoding: 'utf8',
    timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0 || result.signal) throw new Error(`quality_result_unavailable: ${result.error?.message ?? result.signal ?? result.stderr.trim()}`);
  return parseRoborevResult(result.stdout, commit, observedAt);
}
