import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RecordsSchema, ProjectStore, reviewProduct, parseRoborevResult, readRoborevResult, snapshotDelivery,
  stepAgentCommand, validateRecords, validateReviewForCompletion, type Assignment, type CriterionResult, type FactoryRecord,
  type ProductVerdict, type QualityResult } from '../src/index.js';
import { fakeJudgeOptions } from './judge-helper.js';

const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const at = '2026-11-11T18:00:00Z';
const general = { id: 'criterion-general', revision: 1 };
const second = { id: 'criterion-second-system', revision: 1 };
const original = 'Build feature X for every connected system, ERPNext is only an example.';
const goodCode = 'export function feature(system) { return system.featureX(); }\n';
const badCode = 'export function feature(system) { if (system.name !== "ERPNext") throw Error("unsupported"); return system.featureX(); }\n';
function qualityRaw(commit: string, verdict = 'pass') {
  return JSON.stringify({ job_id: 42, output: 'Existing technical review', created_at: at, closed: true,
    structured_output: { schema_version: 2, verdict, summary: 'Existing result', findings: [] },
    job: { id: 42, git_ref: commit, status: 'done', job_type: 'review' } });
}
function passing(code = goodCode): ProductVerdict {
  return { sourceComparison: 'passed', instructionFidelity: 'passed', planConformance: 'passed',
    criteria: [general, second].map((criterion) => ({ criterion, state: 'accomplished',
      behavior: 'Common interface is implemented for the connected systems.', quotes: [{ source: 'delivery', text: code.trim() }], limitations: [] })),
    findings: [], suggestions: ['Consider adding an optional example.'], unresolvedQuestions: [] };
}
function failure(type: ProductVerdict['findings'][number]['type'], check: ProductVerdict['findings'][number]['check'], code = badCode): ProductVerdict {
  const verdict = passing(code);
  verdict[check] = 'failed';
  verdict.findings = [{ check, type, message: 'The delivered behavior does not cover the authoritative requirement.',
    quotes: [{ source: 'original_request', text: original }, { source: 'delivery', text: code.trim() }] }];
  verdict.criteria[1]!.state = 'failed';
  return verdict;
}
function setup(code = goodCode, edit?: (records: FactoryRecord[]) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-product-review-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(directory, 'feature.js'), code); git('add', 'feature.js'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic delivery');
  const commit = git('rev-parse', 'HEAD');
  const records = structuredClone(baseline.filter((record) => ['project', 'request', 'feature_revision', 'criterion', 'design_revision',
    'implementation_plan_revision', 'detailed_plan_task', 'assignment', 'task_mapping'].includes(record.kind)));
  edit?.(records);
  const db = join(directory, 'project.sqlite'); const store = new ProjectStore(db);
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history: records, receipts: [] });
  const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
  const artifact = { uri: `git:${directory}`, revision: commit };
  const results = structuredClone(baseline.filter((record): record is CriterionResult => record.kind === 'criterion_result'));
  for (const result of results) { result.artifact = artifact; result.evidence = [{ artifact, description: 'Recorded acceptance verification.', observedAt: at }]; }
  const input = { projectId: 'project-1', reviewId: 'product-review-1', expectedRevision: 0,
    idempotencyKey: 'product-review-op-1', issuedAt: at, assignment: { id: assignment.id, revision: assignment.revision },
    repository: directory, deliveredArtifact: artifact, results,
    baselineEvidence: [{ artifact: { uri: 'fixture:baseline', revision: 'before-feature' }, description: 'Feature X was absent.', observedAt: at }] };
  let qualityReads = 0;
  const reader = (_repository: string, sha: string, observedAt: string): QualityResult => {
    qualityReads++; return parseRoborevResult(qualityRaw(sha), sha, observedAt);
  };
  const run = (verdict: ProductVerdict, options: { record?: string; result?: string; exit?: string; sleep?: string } = {}) =>
    reviewProduct(store, input, fakeJudgeOptions({ result: JSON.stringify(verdict), ...options }), reader);
  return { directory, db, records, store, input, reader, run, git, commit, qualityReads: () => qualityReads,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('decisive case: perfect compliance with the ERPNext brief and green technical review still fails product review', () => {
  const flow = setup(badCode, (records) => {
    const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
    assignment.instructionText = 'Implement feature X only for ERPNext.';
  });
  try {
    const calls = join(flow.directory, 'agent.jsonl');
    const result = flow.run(failure('narrowed_generality', 'planConformance'), { record: calls });
    assert.equal(result.review.outcome, 'failed');
    assert.equal(result.review.conformance?.technicalReviews[0]?.verdict, 'passed');
    assert.equal(result.review.conformance?.verdict?.criteria[1]?.state, 'failed');
    assert.equal(validateReviewForCompletion(flow.store.history('project-1'), result.review).ok, false);
    const input = JSON.parse(readFileSync(calls, 'utf8'));
    assert.equal(input.originalRequests[0].text, original);
    assert.match(input.design.productBehavior, /common connected-system interface/);
    assert.equal(input.candidateInstructions, 'Implement feature X only for ERPNext.');
    assert.deepEqual(input.acceptanceCases, ['ERPNext case', 'Second-system case']);
    assert.equal(input.deliveredArtifact.revision, flow.commit);
    assert.equal(input.deliveredFiles[0].text, badCode);
    assert.equal(input.workerReturns.length, 2);
    assert.equal(input.technicalReviews[0].commit, flow.commit);
    assert.notEqual(input.agentPid, process.pid); assert.deepEqual(input.inheritedSessionMarkers, []);
    assert.equal(readFileSync(calls, 'utf8').trimEnd().split('\n').length, 1);
    assert.deepEqual(result.review.conformance?.verdict?.suggestions, ['Consider adding an optional example.']);
  } finally { flow.close(); }
});

for (const type of ['missing_behavior', 'wrong_implementation'] as const) test(`${type} is persisted separately from the worker's passing claims`, () => {
  const flow = setup(badCode);
  try {
    const { review } = flow.run(failure(type, 'planConformance'));
    assert.equal(review.outcome, 'failed'); assert.equal(review.planConformance.result, 'failed');
    assert.equal(flow.store.get('project-1', 'result-second')?.kind, 'criterion_result');
    assert.equal(review.conformance?.verdict?.findings[0]?.type, type);
    assert.equal(flow.input.results[1]!.result, 'passed');
  } finally { flow.close(); }
});

test('original-request omission cannot validate itself through a narrowed plan or criterion list', () => {
  const flow = setup(goodCode, (records) => {
    const request = records.find((record) => record.kind === 'request'); assert.ok(request?.kind === 'request');
    request.originalText += ' Also allow users to export results.';
    const design = records.find((record) => record.kind === 'design_revision'); assert.ok(design?.kind === 'design_revision');
    design.productBehavior = 'Build a common feature; export is absent from this mistaken plan.';
  });
  try {
    const verdict = passing(); verdict.sourceComparison = 'failed';
    verdict.findings = [{ check: 'sourceComparison', type: 'original_request_omission', message: 'Export was never mapped to a criterion or implemented.',
      quotes: [{ source: 'original_request', text: 'Also allow users to export results.' }] }];
    const { review } = flow.run(verdict);
    assert.ok(review.conformance?.verdict?.criteria.every((criterion) => criterion.state === 'accomplished'));
    assert.equal(review.outcome, 'failed'); assert.equal(review.sourceComparison.result, 'failed');
  } finally { flow.close(); }
});

test('accomplished behavior with baseline, improvement and quality evidence permits completion', () => {
  const flow = setup();
  try {
    const { review } = flow.run(passing());
    assert.equal(review.outcome, 'passed', JSON.stringify(review));
    assert.equal(validateReviewForCompletion(flow.store.history('project-1'), review).ok, true);
    assert.ok(review.improvementEvidence.length); assert.ok(review.baselineEvidence.length);
    assert.equal(flow.store.get('project-1', 'feature-1')?.kind, 'feature_revision');
  } finally { flow.close(); }
});

test('unchanged quality results are reused across product passes; a changed commit reads its own result', () => {
  const flow = setup();
  try {
    const config = fakeJudgeOptions({ result: JSON.stringify(passing()) });
    const first = reviewProduct(flow.store, flow.input, config, flow.reader);
    assert.equal(first.review.outcome, 'passed'); assert.equal(flow.qualityReads(), 1);
    const replay = reviewProduct(flow.store, flow.input, config, () => { throw Error('must not read again'); });
    assert.equal(replay.replayed, true); assert.deepEqual(replay.review, first.review);
    const next = { ...flow.input, reviewId: 'second-review', idempotencyKey: 'second-review-key' };
    assert.equal(reviewProduct(flow.store, next, config, () => { throw Error('cached quality must be reused'); }).review.outcome, 'passed');
    writeFileSync(join(flow.directory, 'feature.js'), goodCode + '// second revision\n'); flow.git('add', 'feature.js');
    flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Changed delivery');
    const revision = flow.git('rev-parse', 'HEAD'); const artifact = { ...flow.input.deliveredArtifact, revision };
    const changed = { ...flow.input, reviewId: 'changed-review', idempotencyKey: 'changed-review-key', deliveredArtifact: artifact,
      results: flow.input.results.map((result) => ({ ...result, id: `${result.id}-new`, artifact,
        evidence: result.evidence.map((evidence) => ({ ...evidence, artifact })) })) };
    assert.equal(reviewProduct(flow.store, changed, config, flow.reader).review.outcome, 'passed');
    assert.equal(flow.qualityReads(), 2);
  } finally { flow.close(); }
});

for (const problem of ['unavailable', 'failed', 'uncertain', 'wrong-commit'] as const) test(`quality ${problem} cannot be replaced by a product pass`, () => {
  const flow = setup();
  try {
    const quality = parseRoborevResult(qualityRaw(problem === 'wrong-commit' ? 'f'.repeat(40) : flow.commit,
      problem === 'failed' ? 'fail' : problem === 'uncertain' ? 'unable_to_review' : 'pass'),
      problem === 'wrong-commit' ? 'f'.repeat(40) : flow.commit, at);
    const { review } = reviewProduct(flow.store, flow.input, fakeJudgeOptions({ result: JSON.stringify(passing()) }),
      () => { if (problem === 'unavailable') throw Error('No existing result'); return quality; });
    assert.equal(review.outcome, problem === 'failed' ? 'failed' : 'incomplete');
  } finally { flow.close(); }
});

for (const problem of ['uncertain', 'missing-return', 'missing-baseline'] as const) test(`${problem} remains incomplete despite green quality`, () => {
  const flow = setup();
  try {
    const verdict = passing();
    if (problem === 'uncertain') verdict.criteria[1]!.state = 'uncertain';
    if (problem === 'missing-return') flow.input.results.pop();
    if (problem === 'missing-baseline') flow.input.baselineEvidence = [];
    assert.equal(flow.run(verdict).review.outcome, 'incomplete');
  } finally { flow.close(); }
});

for (const output of ['not JSON', '{}', '{"sourceComparison":"passed","sourceComparison":"failed"}',
  JSON.stringify({ ...passing(), criteria: [] }),
  JSON.stringify({ ...passing(), criteria: [passing().criteria[0], passing().criteria[0]] }),
  JSON.stringify({ ...passing(), criteria: passing().criteria.map((criterion) => ({ ...criterion, quotes: [{ source: 'delivery', text: 'invented code' }] })) }),
  JSON.stringify({ ...passing(), criteria: passing().criteria.map((criterion) => ({ ...criterion, quotes: [{ source: 'original_request', text: original }] })) }),
]) test(`invalid product output fails closed: ${output.slice(0, 55)}`, () => {
  const flow = setup();
  try {
    const { review } = flow.run(passing(), { result: output });
    assert.equal(review.outcome, 'incomplete'); assert.equal(review.conformance?.verdict, null); assert.ok(review.conformance?.error);
  } finally { flow.close(); }
});

for (const mode of ['exit', 'timeout', 'missing-profile'] as const) test(`${mode} never falls back to the worker`, () => {
  const flow = setup();
  try {
    const config = { ...fakeJudgeOptions(mode === 'exit' ? { exit: '3' } : { sleep: '1000' }), timeoutMs: 100 };
    if (mode === 'missing-profile') {
      delete (config.steps as Partial<typeof config.steps>).product_review;
      assert.throws(() => reviewProduct(flow.store, flow.input, config, flow.reader), /product_review/);
    } else {
      const { review } = reviewProduct(flow.store, flow.input, config, flow.reader);
      assert.equal(review.outcome, 'incomplete'); assert.match(review.conformance?.error ?? '', /agent_failed/);
    }
  } finally { flow.close(); }
});

test('idempotency changes and stale expected revisions refuse a second model call', () => {
  const flow = setup();
  try {
    const calls = join(flow.directory, 'calls.jsonl'); const config = fakeJudgeOptions({ record: calls, result: JSON.stringify(passing()) });
    reviewProduct(flow.store, flow.input, config, flow.reader);
    assert.throws(() => reviewProduct(flow.store, { ...flow.input, paths: ['feature.js'] }, config, flow.reader), /idempotency_conflict/);
    assert.throws(() => reviewProduct(flow.store, { ...flow.input, idempotencyKey: 'another-op' }, config, flow.reader), /revision_conflict/);
    assert.equal(readFileSync(calls, 'utf8').trimEnd().split('\n').length, 1);
  } finally { flow.close(); }
});

for (const harness of ['codex', 'claude'] as const) test(`${harness} product-review uses its own fresh profile, read-only command and structured schema`, () => {
  const flow = setup();
  try {
    const calls = join(flow.directory, 'profile.jsonl'); const config = fakeJudgeOptions({ record: calls, result: JSON.stringify(passing()) });
    config.steps.instruction_check = { harness: 'codex', model: 'other-instruction-model', effort: 'low' };
    config.steps.product_review = { harness, provider: harness, model: 'review-model', effort: 'high' };
    const command = stepAgentCommand(config, 'project-1', 'product_review');
    const { review } = reviewProduct(flow.store, flow.input, config, flow.reader);
    assert.equal(review.outcome, 'passed'); assert.deepEqual(review.conformance?.profile, config.steps.product_review);
    const call = JSON.parse(readFileSync(calls, 'utf8')); assert.deepEqual(call.agentArgv, command.args);
    assert.deepEqual(call.inheritedSessionMarkers, []); assert.notEqual(call.agentPid, process.pid);
    assert.ok(command.args.includes(harness === 'codex' ? '--ephemeral' : '--no-session-persistence'));
    assert.ok(command.args.includes(harness === 'codex' ? 'read-only' : '--safe-mode'));
    assert.ok(command.args.includes('review-model'));
    if (harness === 'codex') assert.match(command.args[command.args.indexOf('--output-schema') + 1]!, /product-review.schema.json$/);
  } finally { flow.close(); }
});

test('delivery is pinned to committed files and changed paths cannot be omitted or silently truncated', () => {
  const flow = setup();
  try {
    writeFileSync(join(flow.directory, 'feature.js'), badCode);
    assert.equal(snapshotDelivery(flow.directory, flow.input.deliveredArtifact, [], 10_000)[0]!.text, goodCode);
    assert.throws(() => snapshotDelivery(flow.directory, flow.input.deliveredArtifact, [], 5), /too_large/);
    assert.throws(() => snapshotDelivery(flow.directory, flow.input.deliveredArtifact, ['absent.js'], 10_000), /not_found/);
    assert.throws(() => snapshotDelivery(flow.directory, { ...flow.input.deliveredArtifact, revision: 'HEAD' }, [], 10_000));
  } finally { flow.close(); }
});

for (const problem of ['wrong-commit', 'pending', 'run-job'] as const) test(`RoboRev adapter refuses ${problem} evidence`, () => {
  const sha = 'a'.repeat(40); const raw = JSON.parse(qualityRaw(sha));
  if (problem === 'wrong-commit') raw.job.git_ref = 'b'.repeat(40);
  if (problem === 'pending') raw.job.status = 'running';
  if (problem === 'run-job') raw.job.job_type = 'run';
  assert.throws(() => parseRoborevResult(JSON.stringify(raw), sha, at));
});

test('closed technical review with no structured verdict stays uncertain', () => {
  const sha = 'a'.repeat(40); const raw = JSON.parse(qualityRaw(sha)); delete raw.structured_output;
  assert.equal(parseRoborevResult(JSON.stringify(raw), sha, at).verdict, 'uncertain');
});

test('RoboRev executable adapter calls only show --json for the delivered commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-quality-read-'));
  try {
    const sha = 'a'.repeat(40); const executable = join(directory, 'roborev.mjs'); const calls = join(directory, 'calls.json');
    writeFileSync(executable, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(qualityRaw(sha))});\n`, { mode: 0o755 });
    assert.equal(readRoborevResult(directory, sha, at, executable).verdict, 'passed');
    assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), ['show', '--json', sha]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI persists an incomplete review and exits nonzero when an existing quality result is missing', () => {
  const flow = setup();
  try {
    const config = fakeJudgeOptions({ result: JSON.stringify(passing()) });
    const configPath = join(flow.directory, 'agents.json'); const inputPath = join(flow.directory, 'input.json');
    writeFileSync(configPath, JSON.stringify(config)); writeFileSync(inputPath, JSON.stringify(flow.input));
    const executable = new URL('../src/cli.js', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [executable, 'review-product', '--db', flow.db, '--input', inputPath, '--agent-config', configPath],
      { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' }, timeout: 20_000 });
    assert.equal(result.status, 1, result.stderr); assert.equal(JSON.parse(result.stdout).review.outcome, 'incomplete');
    assert.equal(flow.store.get('project-1', 'product-review-1')?.kind, 'product_review');
  } finally { flow.close(); }
});


test('a newer assignment preserves historical review evidence but cannot use it for current completion', () => {
  const flow = setup();
  try {
    const { review } = flow.run(passing());
    const history = flow.store.history('project-1');
    const previous = history.find((record): record is Assignment => record.kind === 'assignment')!;
    const next = { ...previous, revision: 2, updatedAt: at };
    assert.equal(validateRecords([...history, next]).ok, true, 'Historical passing reviews stay valid');
    const completion = validateReviewForCompletion([...history, next], review);
    assert.equal(completion.ok, false);
    if (!completion.ok) assert.ok(completion.issues.some((issue) => issue.code === 'superseded_assignment'));
  } finally { flow.close(); }
});

test('merge delivery includes first-parent changes and explicitly selected unchanged dependencies', () => {
  const flow = setup();
  try {
    const primary = flow.git('branch', '--show-current');
    flow.git('checkout', '-qb', 'implementation');
    writeFileSync(join(flow.directory, 'adapter.js'), 'export const adapter = "connected-system";\n');
    flow.git('add', 'adapter.js'); flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Implementation dependency');
    flow.git('checkout', '-q', primary);
    writeFileSync(join(flow.directory, 'unrelated.txt'), 'Other change\n');
    flow.git('add', 'unrelated.txt'); flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Other delivery');
    flow.git('-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '-qm', 'Merged delivery', 'implementation');
    const artifact = { ...flow.input.deliveredArtifact, revision: flow.git('rev-parse', 'HEAD') };
    const files = snapshotDelivery(flow.directory, artifact, ['feature.js'], 10_000);
    assert.deepEqual(files.map((file) => file.path), ['adapter.js', 'feature.js']);
    assert.equal(files[1]!.text, goodCode);
  } finally { flow.close(); }
});

test('binary delivery is explicitly unavailable rather than silently absent from the review', () => {
  const flow = setup();
  try {
    writeFileSync(join(flow.directory, 'opaque.bin'), Buffer.from([0, 1, 255]));
    flow.git('add', 'opaque.bin'); flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Binary artifact');
    const artifact = { ...flow.input.deliveredArtifact, revision: flow.git('rev-parse', 'HEAD') };
    assert.throws(() => snapshotDelivery(flow.directory, artifact, [], 10_000), /requires_text/);
  } finally { flow.close(); }
});
