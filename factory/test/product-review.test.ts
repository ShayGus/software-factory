import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RecordsSchema, ProjectStore, reviewProduct, parseRoborevResult, readRoborevResult, snapshotDelivery,
  stepAgentCommand, reviewTicketPullRequest, validateRecords, validateReviewForCompletion, digestText, QualityResultSchema, type Assignment, type CriterionResult, type FactoryRecord,
  checkFactoryMerge, ref, recordSource, planReadinessFindings, technicalReviewSatisfied, type StageRevision, type ProductVerdict, type QualityResult } from '../src/index.js';
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

test('technical advisories preserve the failed raw verdict and require exact acceptance of every finding', () => {
  const commit = 'a'.repeat(40);
  const finding = { severity: 'low', location: 'test/review.test.ts:42', problem: 'A test omits a corner case', fix: 'Extend the test' };
  const other = { ...finding, location: 'test/review.test.ts:54' };
  const raw = JSON.parse(qualityRaw(commit, 'fail'));
  raw.structured_output.findings = [finding];
  const result = parseRoborevResult(JSON.stringify(raw), commit, at);
  const approval = { artifact: { uri: 'fixture:owner-approval', revision: commit, digest: 'sha256:approved' },
    description: 'Owner accepted this exact finding', observedAt: at };
  assert.equal(result.verdict, 'failed');
  assert.equal(technicalReviewSatisfied(result), false);
  assert.equal(technicalReviewSatisfied({ ...result, advisoryAcceptance: { approval, findings: [finding] } }), true);
  assert.equal(technicalReviewSatisfied({ ...result, advisoryAcceptance: { approval, findings: [other] } }), false);
  raw.structured_output.findings.push(other);
  const second = parseRoborevResult(JSON.stringify(raw), commit, at);
  assert.equal(technicalReviewSatisfied({ ...second, advisoryAcceptance: { approval, findings: [finding] } }), false);
});

test('scope advisories must match the complete recorded findings, prompt and commit', () => {
  const commit = 'a'.repeat(40);
  const scopeDigest = digestText('Scope prompt for ' + commit);
  const findings = ['A timing test covers an extra case.', 'An additional notice is displayed.'];
  const raw = JSON.stringify({ job_id: 42, job: { id: 42, git_ref: 'factory-scope-' + scopeDigest.slice(-16),
    status: 'done', job_type: 'task' }, prompt_digest: scopeDigest,
    output: JSON.stringify({ verdict: 'fail', findings }) });
  const result = QualityResultSchema.parse({ tool: 'roborev', commit, jobId: 42, verdict: 'failed',
    artifact: { uri: 'roborev:job/42', revision: commit, digest: digestText(raw) }, observedAt: at, raw, scopeDigest });
  const approval = { artifact: { uri: 'fixture:owner-approval', revision: commit, digest: digestText('Accepted scope findings') },
    description: 'Owner accepted these exact findings', observedAt: at };
  const accepted = QualityResultSchema.parse({ ...result, advisoryAcceptance: { approval, findings: [...findings].reverse() } });
  assert.equal(technicalReviewSatisfied(result), false);
  assert.equal(technicalReviewSatisfied(accepted), true);
  assert.equal(accepted.verdict, 'failed');
  assert.equal(accepted.raw, raw);
  assert.equal(technicalReviewSatisfied({ ...accepted, scopeDigest: digestText('Another scope prompt') }), false);
  assert.equal(technicalReviewSatisfied({ ...accepted, commit: 'b'.repeat(40) }), false);
  assert.equal(technicalReviewSatisfied({ ...accepted, jobId: 43 }), false);
  assert.equal(technicalReviewSatisfied({ ...accepted, advisoryAcceptance: { approval, findings: findings.slice(1) } }), false);
});
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
    reviewProduct(store, input, fakeJudgeOptions({ result: JSON.stringify(verdict), ...options }), reader, directory);
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
    assert.equal(input.deliveredFiles[0].text, undefined);
    assert.equal(readFileSync(input.deliveredFiles[0].snapshotPath, 'utf8'), badCode);
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
    const saved = flow.store.get('project-1', 'result-second'); assert.ok(saved?.kind === 'criterion_result');
    assert.equal(saved.result, 'passed');
    assert.equal(review.conformance?.verdict?.findings[0]?.type, type);
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

for (const problem of ['unavailable', 'failed', 'uncertain'] as const) test(`quality ${problem} cannot be replaced by a product pass`, () => {
  const flow = setup();
  try {
    const quality = parseRoborevResult(qualityRaw(flow.commit,
      problem === 'failed' ? 'fail' : problem === 'uncertain' ? 'unable_to_review' : 'pass'),
      flow.commit, at);
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

for (const output of ['not JSON', '{}', JSON.stringify(passing()).replace('{', '{"sourceComparison":"failed",'),
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

test('ordinary RoboRev reads still use only show --json for the delivered commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-quality-read-'));
  try {
    const sha = 'a'.repeat(40); const executable = join(directory, 'roborev.mjs'); const calls = join(directory, 'calls.json');
    writeFileSync(executable, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(qualityRaw(sha))});\n`, { mode: 0o755 });
    assert.equal(readRoborevResult(directory, sha, at, executable).verdict, 'passed');
    assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), ['show', '--json', sha]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI persists an incomplete review and exits nonzero when quality reviewers are unavailable', () => {
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

test('binary delivery lists the committed path and size alongside reviewable source', () => {
  const flow = setup();
  try {
    writeFileSync(join(flow.directory, 'opaque.bin'), Buffer.from([0, 1, 255]));
    flow.git('add', 'opaque.bin'); flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Binary artifact');
    const artifact = { ...flow.input.deliveredArtifact, revision: flow.git('rev-parse', 'HEAD') };
    writeFileSync(join(flow.directory, 'opaque.bin'), Buffer.alloc(100));
    const calls = join(flow.directory, 'agent.jsonl');
    const input = { ...flow.input, deliveredArtifact: artifact, paths: ['feature.js'],
      results: flow.input.results.map((result) => ({ ...result, artifact,
        evidence: result.evidence.map((evidence) => ({ ...evidence, artifact })) })) };
    const config = fakeJudgeOptions({ result: JSON.stringify(passing()), record: calls });
    const { review } = reviewProduct(flow.store, input, config, flow.reader, flow.directory);
    assert.equal(review.outcome, 'passed', JSON.stringify(review));
    const binary = review.conformance?.deliveredFiles.find((file) => file.path === 'opaque.bin');
    assert.equal(binary?.sizeBytes, 3);
    assert.equal(binary.text, '');
    assert.equal(binary.artifact.revision, artifact.revision);
    const evidence = JSON.parse(readFileSync(calls, 'utf8'));
    assert.deepEqual(evidence.deliveredFiles.find((file: { path: string }) => file.path === 'opaque.bin'),
      { path: 'opaque.bin', sizeBytes: 3, artifact: binary.artifact });
    assert.equal(readFileSync(evidence.deliveredFiles[0].snapshotPath, 'utf8'), goodCode);
  } finally { flow.close(); }
});

function splitAssignments(records: FactoryRecord[]) {
  const task = records.find((record) => record.kind === 'detailed_plan_task'); assert.ok(task?.kind === 'detailed_plan_task');
  const assignment = records.find((record) => record.kind === 'assignment'); assert.ok(assignment?.kind === 'assignment');
  const mapping = records.find((record) => record.kind === 'task_mapping'); assert.ok(mapping?.kind === 'task_mapping');
  const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
  const nextTask = { ...structuredClone(task), id: 'task-2', criteria: [second], verificationCases: ['Second-system case'] };
  const nextAssignment = JSON.parse(JSON.stringify(assignment).replaceAll('task-1', 'task-2')) as Assignment;
  nextAssignment.id = 'assignment-2'; nextAssignment.attemptId = 'attempt-2'; nextAssignment.firstMateTaskId = 'pilot-second'; nextAssignment.criteria = [second];
  const nextMapping = { ...structuredClone(mapping), id: 'mapping-2', firstMateTaskId: 'pilot-second', detailedPlanTask: { id: 'task-2', revision: 1 }, criteria: [second] };
  task.criteria = [general]; task.verificationCases = ['ERPNext case']; assignment.criteria = [general]; mapping.criteria = [general];
  plan.deliverySequence.push({ id: 'task-2', revision: 1 }); plan.priorities.push({ taskId: 'task-2', priority: 1 });
  records.push(nextTask, nextAssignment, nextMapping);
}

test('review finding 1: two delivered assignments complete one feature with exact task, commit and return provenance', () => {
  const flow = setup(goodCode, splitAssignments);
  try {
    const [firstReturn, template] = flow.input.results; assert.ok(firstReturn && template);
    flow.input.results = [firstReturn];
    const firstVerdict = passing(); firstVerdict.criteria = [firstVerdict.criteria[0]!];
    assert.equal(flow.run(firstVerdict).review.outcome, 'incomplete', 'The first slice cannot complete the whole feature');
    const nextCode = 'export const secondSystem = "supported";\n';
    writeFileSync(join(flow.directory, 'second-system.js'), nextCode); flow.git('add', 'second-system.js');
    flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Second-system delivery');
    const secondArtifact = { ...flow.input.deliveredArtifact, revision: flow.git('rev-parse', 'HEAD') };
    const secondReturn = { ...template, assignment: { id: 'assignment-2', revision: 1 }, artifact: secondArtifact,
      evidence: [{ artifact: secondArtifact, description: 'Second system verified in its delivered revision.', observedAt: at }] };
    const calls = join(flow.directory, 'aggregate-input.jsonl'); const verdict = passing();
    verdict.criteria[1]!.quotes = [{ source: 'delivery', text: nextCode.trim() }];
    const aggregateInput = { ...flow.input, reviewId: 'aggregate-review', idempotencyKey: 'aggregate-op', additionalDeliveries: [{
      assignment: { id: 'assignment-2', revision: 1 }, repository: flow.directory, deliveredArtifact: secondArtifact, results: [secondReturn],
    }] };
    const { review } = reviewProduct(flow.store, aggregateInput, fakeJudgeOptions({ record: calls, result: JSON.stringify(verdict) }), flow.reader);
    assert.equal(review.outcome, 'passed', JSON.stringify(review));
    assert.equal(validateReviewForCompletion(flow.store.history('project-1'), review).ok, true);
    assert.deepEqual(review.assignments, [{ id: 'assignment-1', revision: 1 }, { id: 'assignment-2', revision: 1 }]);
    assert.deepEqual(review.detailedPlanTasks, [{ id: 'task-1', revision: 1 }, { id: 'task-2', revision: 1 }]);
    assert.deepEqual(review.reviewedArtifacts, [flow.input.deliveredArtifact, secondArtifact]);
    assert.deepEqual(review.results, [{ id: firstReturn.id, revision: 1 }, { id: secondReturn.id, revision: 1 }]);
    assert.deepEqual(review.improvementEvidence.map((evidence) => evidence.artifact), [flow.input.deliveredArtifact, secondArtifact]);
    assert.deepEqual(review.conformance!.deliveries!.map(({ assignment, detailedPlanTask, artifact, results }) => ({ assignment, detailedPlanTask, artifact, results })), [
      { assignment: review.assignments[0], detailedPlanTask: review.detailedPlanTasks[0], artifact: flow.input.deliveredArtifact, results: [review.results[0]] },
      { assignment: review.assignments[1], detailedPlanTask: review.detailedPlanTasks[1], artifact: secondArtifact, results: [review.results[1]] },
    ]);
    const snapshot = JSON.parse(readFileSync(calls, 'utf8'));
    assert.equal(snapshot.tasks.length, 2); assert.equal(snapshot.deliveries[1].deliveredArtifact.revision, secondArtifact.revision);
    assert.deepEqual(snapshot.plans.map(ref), [{ id: 'plan-1', revision: 1 }]);
    assert.deepEqual(snapshot.reviewPlan, { id: 'plan-1', revision: 1 });
    assert.deepEqual(snapshot.workerReturns.map((result: CriterionResult) => result.assignment), review.assignments);
    assert.equal(flow.qualityReads(), 2, 'The first commit reuses its quality result; only the second commit reads another');
    const tampered = structuredClone(flow.store.history('project-1'));
    const saved = tampered.find((record) => record.id === review.id); assert.ok(saved?.kind === 'product_review');
    saved.conformance!.deliveries![1]!.results = [review.results[0]!];
    assert.equal(validateReviewForCompletion(tampered, review).ok, false, 'Evidence cannot be reassigned to the other delivery');
    const wrongDelivery = reviewProduct(flow.store, { ...aggregateInput, reviewId: 'wrong-delivery-review', idempotencyKey: 'wrong-delivery-op' },
      fakeJudgeOptions({ result: JSON.stringify(passing()) }), flow.reader);
    assert.equal(wrongDelivery.review.outcome, 'incomplete');
    assert.match(wrongDelivery.review.conformance?.error ?? '', /accomplishment_requires_delivery_evidence/,
      'The second criterion cannot borrow code evidence from only the first assignment');
  } finally { flow.close(); }
});

test('review finding 2: optional assigned criteria still require a worker return', () => {
  const flow = setup(goodCode, (records) => {
    const criterion = records.find((record) => record.id === second.id); assert.ok(criterion?.kind === 'criterion');
    criterion.requirement = 'optional';
  });
  try {
    const omitted = flow.input.results.pop()!;
    const { review } = flow.run(passing());
    assert.equal(review.outcome, 'incomplete');
    const completion = validateReviewForCompletion(flow.store.history('project-1'), review);
    assert.equal(completion.ok, false);
    if (!completion.ok) assert.ok(completion.issues.some((issue) => issue.code === 'missing_worker_return'));
    const complete = reviewProduct(flow.store, { ...flow.input, reviewId: 'optional-return-present', idempotencyKey: 'optional-return-op',
      results: [...flow.input.results, omitted] }, fakeJudgeOptions({ result: JSON.stringify(passing()) }), flow.reader);
    assert.equal(complete.review.outcome, 'passed');
  } finally { flow.close(); }
});

function concurrentWriterAgent(flow: ReturnType<typeof setup>, write: FactoryRecord, verdict: ProductVerdict) {
  const config = fakeJudgeOptions({ result: JSON.stringify(verdict) });
  const executable = config.executables.codex!;
  const assignment = flow.records.find((record): record is Assignment => record.kind === 'assignment')!;
  const command = { schemaVersion: 1, id: 'concurrent-write', projectId: 'project-1', issuedAt: at,
    idempotencyKey: 'concurrent-write-op', targetId: write.id, expectedRevision: write.revision - 1,
    ...(write.kind === 'assignment' ? { command: 'prepare_assignment', payload: { detailedPlanTask: assignment.detailedPlanTask,
      feature: assignment.feature, design: assignment.design, plan: assignment.plan, firstMateTaskId: assignment.firstMateTaskId,
      selectedContext: assignment.selectedContext, returnLocation: assignment.returnLocation } } :
      { command: 'record_review_result', payload: { originalRequests: [{ id: 'request-1', revision: 1 }], feature: assignment.feature,
        design: assignment.design, plan: assignment.plan, assignment: flow.input.assignment, deliveredArtifact: flow.input.deliveredArtifact, results: [write] } }),
  };
  const existingAgent = readFileSync(executable, 'utf8').replace('#!/usr/bin/env node\n', '');
  writeFileSync(executable, `#!/usr/bin/env node\nimport { ProjectStore } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};\nconst store = new ProjectStore(${JSON.stringify(flow.db)});\ntry { store.mutate(${JSON.stringify(command)}, () => [${JSON.stringify(write)}]); } finally { store.close(); }\n${existingAgent}`, { mode: 0o755 });
  return config;
}

test('review finding 3: an assignment superseded by another connection during the agent pass remains historical and incomplete', () => {
  const flow = setup();
  try {
    const assignment = flow.records.find((record): record is Assignment => record.kind === 'assignment')!;
    const next = { ...assignment, revision: 2, attemptId: 'new-attempt', updatedAt: at };
    const config = concurrentWriterAgent(flow, next, passing());
    const { review } = reviewProduct(flow.store, flow.input, config, flow.reader);
    assert.ok(review.conformance?.verdict, JSON.stringify(review));
    assert.equal(review.outcome, 'incomplete');
    assert.ok(review.unresolvedQuestions.includes('review_assignment_superseded_during_review'));
    assert.equal(flow.store.get('project-1', assignment.id)?.revision, 2);
    assert.equal(flow.store.get('project-1', review.id)?.kind, 'product_review');
    assert.equal(validateRecords(flow.store.history('project-1')).ok, true, 'The assessment is retained as valid history');
    assert.equal(validateReviewForCompletion(flow.store.history('project-1'), review).ok, false);
  } finally { flow.close(); }
});

for (const change of ['inserted-content', 'newer-revision'] as const) test(`review finding 3: ${change} worker evidence during judgment cannot replace what the reviewer saw`, () => {
  const flow = setup();
  try {
    const expected = flow.input.results[0]!;
    if (change === 'newer-revision') {
      const originalVerdict = failure('wrong_implementation', 'planConformance', goodCode);
      flow.run(originalVerdict);
      flow.input.reviewId = 'next-review'; flow.input.idempotencyKey = 'next-op';
    }
    const changed = { ...expected, revision: change === 'newer-revision' ? 2 : 1,
      accomplishedBehavior: 'A different report inserted while the review was running.', updatedAt: at };
    const config = concurrentWriterAgent(flow, changed, passing());
    assert.throws(() => reviewProduct(flow.store, flow.input, config, flow.reader), /worker_return_(revision_conflict|superseded)/);
    assert.equal(flow.store.get('project-1', flow.input.reviewId), undefined, 'No passing review or receipt is written');
    assert.equal(flow.store.receipt('project-1', flow.input.idempotencyKey), undefined);
    const saved = flow.store.get('project-1', changed.id); assert.ok(saved?.kind === 'criterion_result');
    assert.equal(saved.accomplishedBehavior, changed.accomplishedBehavior, 'The concurrent writer committed; the review did not silently substitute it');
  } finally { flow.close(); }
});

for (const definitive of ['pass', 'fail'] as const) test(`review finding 4: a new operation refreshes uncertain quality to ${definitive}, then reuses the definitive result`, () => {
  const flow = setup();
  try {
    const config = fakeJudgeOptions({ result: JSON.stringify(passing()) });
    let reads = 0;
    const reader = (_repo: string, commit: string, observedAt: string) => {
      reads++; return parseRoborevResult(qualityRaw(commit, reads === 1 ? 'unable_to_review' : definitive), commit, observedAt);
    };
    const first = reviewProduct(flow.store, flow.input, config, reader);
    assert.equal(first.review.outcome, 'incomplete'); assert.equal(first.review.conformance?.technicalReviews[0]?.verdict, 'uncertain');
    const replay = reviewProduct(flow.store, flow.input, config, reader);
    assert.equal(replay.replayed, true); assert.equal(reads, 1);
    const refreshed = reviewProduct(flow.store, { ...flow.input, reviewId: 'refreshed-review', idempotencyKey: 'refreshed-op' }, config, reader);
    assert.equal(refreshed.review.outcome, definitive === 'pass' ? 'passed' : 'failed'); assert.equal(reads, 2);
    assert.equal((flow.store.get('project-1', first.review.id) as typeof first.review).conformance?.technicalReviews[0]?.verdict, 'uncertain');
    const reused = reviewProduct(flow.store, { ...flow.input, reviewId: 'definitive-reused', idempotencyKey: 'definitive-op' }, config,
      () => { throw Error('A definitive unchanged result must be reused'); });
    assert.equal(reused.review.outcome, refreshed.review.outcome);
  } finally { flow.close(); }
});


test('review finding 1: assignments delivered at the same commit share a quality read and aggregate receipts replay exactly', () => {
  const flow = setup(goodCode, splitAssignments);
  try {
    const [firstReturn, next] = flow.input.results; assert.ok(firstReturn && next);
    const additional = { assignment: { id: 'assignment-2', revision: 1 }, repository: flow.directory,
      deliveredArtifact: flow.input.deliveredArtifact, results: [{ ...next, assignment: { id: 'assignment-2', revision: 1 } }] };
    const input = { ...flow.input, results: [firstReturn], additionalDeliveries: [additional] };
    const calls = join(flow.directory, 'aggregate-replay.jsonl');
    const config = fakeJudgeOptions({ record: calls, result: JSON.stringify(passing()) });
    const first = reviewProduct(flow.store, input, config, flow.reader);
    assert.equal(first.review.outcome, 'passed'); assert.equal(flow.qualityReads(), 1);
    const replay = reviewProduct(flow.store, input, config, () => { throw Error('No quality read during replay'); });
    assert.equal(replay.replayed, true); assert.deepEqual(replay.review, first.review);
    assert.equal(readFileSync(calls, 'utf8').trimEnd().split('\n').length, 1);
    assert.throws(() => reviewProduct(flow.store, { ...input, additionalDeliveries: [{ ...additional, paths: ['feature.js'] }] }, config, flow.reader), /idempotency_conflict/);
  } finally { flow.close(); }
});

test('review 1169 finding 2: a feature aggregate includes criterion and maintenance outcomes consistently', () => {
  const flow = setup(goodCode, (records) => {
    const task = records.find((record) => record.kind === 'detailed_plan_task'); assert.ok(task?.kind === 'detailed_plan_task');
    const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
    const mapping = records.find((record) => record.kind === 'task_mapping'); assert.ok(mapping?.kind === 'task_mapping');
    const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
    const maintenanceTask = { ...structuredClone(task), id: 'task-maintenance', criteria: [],
      maintenanceObjective: 'Maintain the feature integration marker.', expectedBehavior: 'Keep the feature integration marker current.',
      verificationCases: ['Integration marker is current'] };
    const maintenanceAssignment = JSON.parse(JSON.stringify(assignment).replaceAll('task-1', 'task-maintenance')) as Assignment;
    maintenanceAssignment.id = 'assignment-maintenance'; maintenanceAssignment.attemptId = 'maintenance-attempt';
    maintenanceAssignment.firstMateTaskId = 'pilot-maintenance'; maintenanceAssignment.criteria = [];
    maintenanceAssignment.instructionText = 'Maintain the feature integration marker.';
    const maintenanceMapping = { ...structuredClone(mapping), id: 'mapping-maintenance', firstMateTaskId: 'pilot-maintenance',
      detailedPlanTask: { id: maintenanceTask.id, revision: 1 }, criteria: [] };
    plan.deliverySequence.push({ id: maintenanceTask.id, revision: 1 });
    records.push(maintenanceTask, maintenanceAssignment, maintenanceMapping);
  });
  try {
    const maintenanceCode = 'export const integrationMarker = "current";\n';
    writeFileSync(join(flow.directory, 'integration-marker.js'), maintenanceCode); flow.git('add', 'integration-marker.js');
    flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Feature maintenance delivery');
    const artifact = { ...flow.input.deliveredArtifact, revision: flow.git('rev-parse', 'HEAD') };
    const maintenanceReturn: CriterionResult = { ...flow.input.results[0]!, id: 'result-maintenance',
      assignment: { id: 'assignment-maintenance', revision: 1 }, criterion: null, artifact,
      accomplishedBehavior: 'The integration marker is current.',
      evidence: [{ artifact, description: 'Integration marker verification passed.', observedAt: at }] };
    const input = { ...flow.input, additionalDeliveries: [{ assignment: maintenanceReturn.assignment,
      repository: flow.directory, deliveredArtifact: artifact, results: [maintenanceReturn] }] };
    const verdict = passing();
    verdict.criteria.push({ criterion: null, state: 'accomplished', behavior: maintenanceReturn.accomplishedBehavior,
      quotes: [{ source: 'delivery', text: maintenanceCode.trim() }], limitations: [] });
    const calls = join(flow.directory, 'mixed-maintenance.jsonl');
    const { review } = reviewProduct(flow.store, input, fakeJudgeOptions({ record: calls, result: JSON.stringify(verdict) }), flow.reader);
    assert.equal(review.outcome, 'passed', JSON.stringify(review));
    assert.deepEqual(review.conformance?.verdict?.criteria.map((outcome) => outcome.criterion), [general, second, null]);
    assert.equal(validateReviewForCompletion(flow.store.history('project-1'), review).ok, true);
    const snapshot = JSON.parse(readFileSync(calls, 'utf8'));
    assert.deepEqual(snapshot.assignedCriteria, [general, second, null]);
    assert.deepEqual(review.conformance?.deliveries?.[1]?.results, [{ id: maintenanceReturn.id, revision: 1 }]);
    assert.deepEqual(review.improvementEvidence.at(-1)?.artifact, artifact, 'Maintenance evidence retains its delivered commit');
    for (const state of ['failed', 'blocked', 'untested'] as const) {
      const invalid = { ...maintenanceReturn, id: `maintenance-${state}`, result: state, artifact: null, evidence: [] };
      const mixed = reviewProduct(flow.store, { ...input, reviewId: `mixed-${state}`, idempotencyKey: `mixed-${state}`,
        additionalDeliveries: [{ ...input.additionalDeliveries[0]!, results: [invalid] }] },
        fakeJudgeOptions({ result: JSON.stringify(verdict) }), flow.reader);
      assert.notEqual(mixed.review.outcome, 'passed', `Mixed review accepted ${state} maintenance`);
      const history = flow.store.history('project-1').map((record) => record.id === mixed.review.id ? { ...mixed.review, outcome: 'passed' as const } : record);
      assert.equal(validateReviewForCompletion(history, mixed.review).ok, false);
    }
    const omitted = structuredClone(verdict); omitted.criteria.pop();
    const incomplete = reviewProduct(flow.store, { ...input, reviewId: 'missing-maintenance-outcome', idempotencyKey: 'missing-maintenance-op' },
      fakeJudgeOptions({ result: JSON.stringify(omitted) }), flow.reader);
    assert.equal(incomplete.review.outcome, 'incomplete');
    assert.match(incomplete.review.conformance?.error ?? '', /criterion_coverage_mismatch/);
    const historical = structuredClone(flow.store.history('project-1'));
    const saved = historical.find((record) => record.id === review.id); assert.ok(saved?.kind === 'product_review');
    saved.conformance!.verdict!.criteria.pop();
    assert.equal(validateReviewForCompletion(historical, review).ok, false, 'Completion also requires the maintenance outcome');
  } finally { flow.close(); }
});


test('quality cache isolates repositories and artifacts even at the same commit', () => {
  const flow = setup();
  const other = mkdtempSync(join(tmpdir(), 'sf-other-repo-'));
  try {
    execFileSync('git', ['clone', '-q', flow.directory, other]);
    const config = fakeJudgeOptions({ result: JSON.stringify(passing()) });
    const artifactB = { ...flow.input.deliveredArtifact, uri: `git:${other}` };
    const inputB = { ...flow.input, repository: other, deliveredArtifact: artifactB,
      results: flow.input.results.map((result) => ({ ...result, id: result.id + '-B', artifact: artifactB })) };
    assert.equal(reviewProduct(flow.store, inputB, config, flow.reader).review.outcome, 'passed');
    let reads = 0;
    const inputA = { ...flow.input, reviewId: 'repository-A', idempotencyKey: 'repository-A' };
    const failed = reviewProduct(flow.store, inputA, config, (_repo, commit, observedAt) => {
      reads++; return parseRoborevResult(qualityRaw(commit, 'fail'), commit, observedAt);
    });
    assert.equal(reads, 1); assert.equal(failed.review.outcome, 'failed');
    const reused = reviewProduct(flow.store, { ...inputA, reviewId: 'repository-A-again', idempotencyKey: 'repository-A-again' }, config,
      () => { throw Error('Must reuse A failure rather than B pass'); });
    assert.equal(reused.review.outcome, 'failed');
    // The same artifact under another repository also requires its own result.
    let otherReads = 0;
    reviewProduct(flow.store, { ...inputA, reviewId: 'alias', idempotencyKey: 'alias', repository: other }, config,
      (_repo, commit, observedAt) => { otherReads++; return parseRoborevResult(qualityRaw(commit), commit, observedAt); });
    assert.equal(otherReads, 1);
  } finally { flow.close(); rmSync(other, { recursive: true, force: true }); }
});

test('large committed source is read through the manifest without appearing in the review JSON', () => {
  const code = goodCode + '// ' + 'x'.repeat(1_600_000);
  const flow = setup(code);
  try {
    const calls = join(flow.directory, 'large-review.jsonl');
    const result = reviewProduct(flow.store, flow.input,
      fakeJudgeOptions({ record: calls, result: JSON.stringify(passing()) }), flow.reader, flow.directory);
    assert.equal(result.review.outcome, 'passed');
    const serialized = readFileSync(calls, 'utf8');
    assert.equal(serialized.includes('x'.repeat(512)), false);
    const snapshot = JSON.parse(serialized);
    assert.equal(readFileSync(snapshot.deliveredFiles[0].snapshotPath, 'utf8'), code);
    assert.equal(result.review.conformance?.deliveredFiles[0]?.text, code);
  } finally { flow.close(); }
});

for (const primary of ['earlier', 'later'] as const) test(`aggregate completion accepts retained-task links with the ${primary} assignment first`, () => {
  const flow = setup(goodCode, (records) => {
    splitAssignments(records);
    const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
    const base = { projectId: 'project-1', schemaVersion: 1 as const, revision: 1, createdAt: at, updatedAt: at };
    const feature = { id: 'feature-1', revision: 1 }; const request = { id: 'request-1', revision: 1 };
    const understanding: FactoryRecord = { ...base, kind: 'understanding_revision', id: 'retained-understanding', feature,
      sourceRequests: [request], criteria: [general, second], goal: original, userBehavior: 'Common integration', terms: {},
      priorities: [], examples: [], exclusions: [], existingWork: [{ source: recordSource(request), finding: 'Existing interface' }],
      openUnknowns: [], scope: [], changeReason: 'Preserve delivery' };
    for (const task of records) if (task.kind === 'detailed_plan_task') { task.decisionsToKeep = []; task.verificationMethod = 'Exercise connected systems'; }
    plan.integrationApproach = 'Earlier authority: preserve integration with every connected system';
    const draft = { ...structuredClone(plan), revision: 2, updatedAt: at, integrationApproach: 'Updated integration sequence', readiness: { ...plan.readiness, ready: false },
      workflow: { slices: [{ id: 'slice', behavior: 'Keep common integration', criteria: [general, second], tasks: plan.deliverySequence }],
        scope: [], integrationSteps: ['Connect deliveries'], finalVerification: ['Exercise both systems'], changeReason: 'Retain unchanged deliveries',
        retainedTasks: plan.deliverySequence.map((task) => ({ task, reason: 'Unchanged task' })) } };
    const stage = (name: StageRevision['stage'], artifact: { id: string; revision: number }, previousStage?: StageRevision): StageRevision => ({
      ...base, kind: 'stage_revision', id: `retained-${name}`, stage: name, feature, sourceRequests: [request], criteria: [general, second],
      artifact: ref(artifact), changeReason: 'Reuse unchanged delivery', ...(previousStage ? { previousStage: ref(previousStage) } : {}) });
    const understand = stage('understand', understanding);
    const design = stage('design', plan.design, understand);
    design.reuse = { check: { result: 'passed', sourceRefs: [recordSource(request), recordSource(plan.design)], findings: [], reviewerSession: 'reuse', comparedAt: at }, criterionMap: [general, second].map((criterion) => ({ current: criterion, existing: criterion })) };
    const planned = stage('plan', draft, design); const detail = stage('detail', draft, planned);
    records.push(understanding, draft, understand, design, planned, detail);
    assert.deepEqual(planReadinessFindings(records, detail), []);
    const check: FactoryRecord = { ...base, kind: 'plan_readiness_revision', id: 'retained-check', feature, plan: ref(draft), detailStage: ref(detail), ready: true, findings: [] };
    const retained = { ...draft, revision: 3, readiness: plan.readiness, workflow: { ...draft.workflow, readinessCheck: ref(check) } };
    records.push(check, retained);
    const assignment = records.find((record) => record.id === 'assignment-2'); assert.ok(assignment?.kind === 'assignment');
    assignment.plan = ref(retained); assignment.instructionFidelity.sourceRefs.push(recordSource(retained));
  });
  try {
    const [first, secondReturn] = flow.input.results; assert.ok(first && secondReturn);
    const later = { assignment: { id: 'assignment-2', revision: 1 }, repository: flow.directory,
      deliveredArtifact: flow.input.deliveredArtifact, results: [{ ...secondReturn, assignment: { id: 'assignment-2', revision: 1 } }] };
    const earlier = { assignment: flow.input.assignment, repository: flow.directory,
      deliveredArtifact: flow.input.deliveredArtifact, results: [first] };
    const input = { ...flow.input, ...(primary === 'earlier' ? earlier : later),
      additionalDeliveries: [primary === 'earlier' ? later : earlier] };
    const calls = join(flow.directory, 'mixed-plans.jsonl');
    const { review } = reviewProduct(flow.store, input, fakeJudgeOptions({ record: calls, result: JSON.stringify(passing()) }), flow.reader);
    const snapshot = JSON.parse(readFileSync(calls, 'utf8'));
    assert.deepEqual(snapshot.reviewPlan, { id: 'plan-1', revision: 3 });
    assert.equal(JSON.stringify(snapshot).split('Updated integration sequence').length - 1, 1, 'Each plan authority is supplied once');
    assert.deepEqual(snapshot.plans.map(ref).sort((a: { revision: number }, b: { revision: number }) => a.revision - b.revision),
      [{ id: 'plan-1', revision: 1 }, { id: 'plan-1', revision: 3 }]);
    assert.deepEqual(snapshot.deliveries.map((delivery: { plan: unknown }) => delivery.plan), primary === 'earlier' ?
      [{ id: 'plan-1', revision: 1 }, { id: 'plan-1', revision: 3 }] :
      [{ id: 'plan-1', revision: 3 }, { id: 'plan-1', revision: 1 }]);
    const verdict = passing(); verdict.planConformance = 'failed';
    verdict.findings = [{ check: 'planConformance', type: 'missing_behavior', message: 'Retained delivery misses its earlier authority.',
      quotes: [{ source: 'plan', text: 'Earlier authority: preserve integration with every connected system' }] }];
    const failed = reviewProduct(flow.store, { ...input, reviewId: 'earlier-plan-finding', idempotencyKey: 'earlier-plan-finding' },
      fakeJudgeOptions({ result: JSON.stringify(verdict) }), flow.reader).review;
    assert.equal(failed.outcome, 'failed', JSON.stringify(failed));
    assert.deepEqual(failed.conformance?.verdict?.findings, verdict.findings);
    assert.ok(failed.sourceRefs.some((source) => source.record?.id === 'plan-1' && source.record.revision === 1));
    assert.equal(review.outcome, 'passed', JSON.stringify(review));
    assert.deepEqual(review.plan, { id: 'plan-1', revision: 3 });
    assert.equal(validateReviewForCompletion(flow.store.history('project-1'), review).ok, true);
  } finally { flow.close(); }
});


test('aggregate quality cache preserves opposite repository verdicts at a shared SHA', () => {
  const flow = setup(goodCode, splitAssignments);
  const other = mkdtempSync(join(tmpdir(), 'sf-shared-sha-'));
  try {
    execFileSync('git', ['clone', '-q', flow.directory, other]);
    const [first, secondReturn] = flow.input.results; assert.ok(first && secondReturn);
    const artifact = { uri: `git:${other}`, revision: flow.commit };
    const input = { ...flow.input, results: [first], additionalDeliveries: [{
      assignment: { id: 'assignment-2', revision: 1 }, repository: other, deliveredArtifact: artifact,
      results: [{ ...secondReturn, assignment: { id: 'assignment-2', revision: 1 }, artifact }],
    }] };
    const config = fakeJudgeOptions({ result: JSON.stringify(passing()) });
    let reads = 0;
    const firstReview = reviewProduct(flow.store, input, config, (repository, commit, observedAt) => {
      reads++; return parseRoborevResult(qualityRaw(commit, repository === other ? 'pass' : 'fail'), commit, observedAt);
    });
    assert.equal(reads, 2); assert.equal(firstReview.review.outcome, 'failed');
    const repeat = reviewProduct(flow.store, { ...input, reviewId: 'shared-sha-repeat', idempotencyKey: 'shared-sha-repeat' }, config,
      () => { throw Error('Both repository results must be cached'); });
    assert.deepEqual(repeat.review.conformance?.technicalReviews.map((result) => result.verdict), ['failed', 'passed']);
    assert.equal(repeat.review.outcome, 'failed');
  } finally { flow.close(); rmSync(other, { recursive: true, force: true }); }
});


test('factory merge requires a passing full product review for the exact head and mapped ticket', () => {
  const flow = setup();
  try {
    flow.git('remote', 'add', 'origin', 'git@github.com:example/factory.git');
    const project = flow.store.get('project-1', 'project-1'); assert.ok(project?.kind === 'project');
    const decision = { kind: 'decision_change', id: 'bind-project', projectId: 'project-1', schemaVersion: 1,
      revision: 1, createdAt: at, updatedAt: at, questionOrChange: 'Bind native repository', affectedRecords: [ref(project)],
      rationale: 'Test native project binding', disposition: 'selected', sourceRefs: [{ uri: 'fixture:registration' }], scopeChanges: [] };
    flow.store.mutate({ schemaVersion: 1, id: 'bind', projectId: 'project-1', issuedAt: at, idempotencyKey: 'bind',
      command: 'record_decision_suggestion', targetId: project.id, expectedRevision: project.revision, payload: { decision } },
      () => [decision, { ...project, revision: project.revision + 1, repositories: [{ uri: flow.directory }], firstMateHomeRef: flow.directory }]);
    const registry = { version: 1, projects: [{ home: flow.directory, database: flow.db, projectId: 'project-1', agentConfig: '/unused' }] };
    const check = (head = flow.commit, task = 'pilot-build') => checkFactoryMerge(registry, flow.directory, 'https://github.com/example/factory', task, head);
    assert.throws(() => check(), /requires_passing_product_review_for_head/);
    flow.run(failure('wrong_implementation', 'planConformance', goodCode));
    assert.throws(() => check(), /requires_passing_product_review_for_head/);
    const passed = reviewProduct(flow.store, { ...flow.input, reviewId: 'passing-final', idempotencyKey: 'passing-final' },
      fakeJudgeOptions({ result: JSON.stringify(passing()) }), flow.reader);
    assert.equal(passed.review.outcome, 'passed');
    assert.equal(check().managed, true);
    assert.throws(() => check('b'.repeat(40)), /requires_passing_product_review_for_head/);
    assert.throws(() => check(flow.commit, 'unmapped-task'), /ticket_missing_or_ambiguous/);
    assert.throws(() => checkFactoryMerge(registry, flow.directory, 'https://github.com/example/other', 'pilot-build', flow.commit), /repository_context_mismatch/);
    assert.deepEqual(checkFactoryMerge(registry, flow.directory, 'https://github.com/example/other', 'unmapped', flow.commit), { ok: true, managed: false });
  } finally { flow.close(); }
});


test('a published ticket reviews only the range since its last passing head and unlocks that exact pull request', () => {
  const flow = setup(goodCode, records => {
    const mapping = records.find(record => record.kind === 'task_mapping')!;
    assert.equal(mapping.kind, 'task_mapping');
    mapping.featureTaskId = 'ticket-parent';
  });
  try {
    const repoUrl = 'https://github.com/example/factory';
    const prUrl = `${repoUrl}/pull/31`;
    const branch = 'fm/ticket/ticket-parent';
    const project = flow.store.get('project-1', 'project-1');
    assert.ok(project?.kind === 'project');
    flow.git('remote', 'add', 'origin', repoUrl);
    const decision = { kind: 'decision_change', id: 'bind-ticket-project', projectId: 'project-1', schemaVersion: 1,
      revision: 1, createdAt: at, updatedAt: at, questionOrChange: 'Bind native repository', affectedRecords: [ref(project)],
      rationale: 'Test native project binding', disposition: 'selected', sourceRefs: [{ uri: 'fixture:registration' }], scopeChanges: [] };
    flow.store.mutate({ schemaVersion: 1, id: 'bind-ticket', projectId: 'project-1', issuedAt: at, idempotencyKey: 'bind-ticket',
      command: 'record_decision_suggestion', targetId: project.id, expectedRevision: project.revision, payload: { decision } },
      () => [decision, { ...project, revision: project.revision + 1, repositories: [{ uri: flow.directory }], firstMateHomeRef: flow.directory }]);
    const commitAll = (message: string) => {
      flow.git('add', '-A', '--', '*.js');
      flow.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message);
      return flow.git('rev-parse', 'HEAD');
    };
    flow.git('switch', '-c', branch);
    writeFileSync(join(flow.directory, 'legacy.js'), 'const obsolete = "remove this legacy code";\n');
    const reviewedCommit = commitAll('Initial delivery');
    const artifact = { ...flow.input.deliveredArtifact, revision: reviewedCommit };
    // The original checkout can disappear after the aggregate handoff.
    const oldCheckout = join(flow.directory, 'worker-checkout');
    symlinkSync(flow.directory, oldCheckout);
    const aggregate = reviewProduct(flow.store, { ...flow.input, repository: oldCheckout, deliveredArtifact: artifact, paths: ['feature.js'],
      results: flow.input.results.map(result => ({ ...result, artifact,
        evidence: result.evidence.map(evidence => ({ ...evidence, artifact })) })),
    }, fakeJudgeOptions({ result: JSON.stringify(passing()) }), flow.reader).review;
    assert.equal(aggregate.outcome, 'passed');
    rmSync(oldCheckout);
    const delivery = { taskId: 'ticket-parent', mode: 'no-mistakes' as const, branch, repository: flow.directory,
      repositoryIdentity: 'github.com/example/factory', commit: reviewedCommit, review: ref(aggregate) };
    const registry = { version: 1, projects: [{ home: flow.directory, database: flow.db, projectId: 'project-1', agentConfig: '/unused' }] };
    const check = (head: string, url = prUrl) => checkFactoryMerge(registry, flow.directory, repoUrl, delivery.taskId, head, url);
    let target = { url: prUrl, head: reviewedCommit, base: flow.commit, sourceBranch: branch, sourceRepository: repoUrl };
    let observed = 0;
    let currentTicket: { id: string; text: string } | undefined;
    const calls = join(flow.directory, 'ticket-judge.jsonl');
    const pass = { verdict: 'passed', assessment: 'Preserves accepted behavior.', findings: [], unresolvedQuestions: [] };
    const fail = { verdict: 'failed', assessment: 'Change causes regression.', findings: [{ description: 'Legacy behavior changed.',
      quotes: [{ source: 'patch', text: '-const obsolete = "remove this legacy code";' }] }], unresolvedQuestions: [] };
    const run = (reader = flow.reader, verdict: unknown = pass, readForge = () => { observed++; return target; }) =>
      reviewTicketPullRequest({ store: flow.store, projectId: 'project-1', delivery, prUrl: target.url,
        expectedHead: target.head, readForge, readTicket: () => currentTicket,
        agentConfig: fakeJudgeOptions({ result: JSON.stringify(verdict), record: calls }), readQuality: reader });
    const initial = run();
    assert.equal(initial.publication.reviewedCommit, reviewedCommit);
    assert.deepEqual(ref(initial.review), ref(aggregate));
    assert.equal(initial.replayed, true);
    assert.equal(observed, 2);
    assert.deepEqual(check(reviewedCommit).review, ref(aggregate));
    assert.throws(() => check(reviewedCommit, `${repoUrl}/pull/32`), /pull_request_mismatch/);

    writeFileSync(join(flow.directory, 'fix.js'), 'export const fixed = true;\n');
    commitAll('Add fix');
    rmSync(join(flow.directory, 'legacy.js'));
    const fixedHead = commitAll('Remove obsolete code');
    target = { ...target, head: fixedHead };
    assert.throws(() => check(fixedHead), /requires_passing_product_review_for_head/);
    const rejected = run(flow.reader, fail);
    assert.equal(rejected.review.outcome, 'failed');
    assert.throws(() => check(fixedHead), /requires_passing_product_review_for_head/);

    // A further commit supersedes the rejected head. Both earlier changes
    // remain in scope because the rejected head never became a baseline.
    writeFileSync(join(flow.directory, 'fix.js'), 'export const fixed = true;\n// preserve feature behavior\n');
    const updated = commitAll('Finish fix');
    target = { ...target, head: updated };
    const missing = run(() => { throw Error('No existing result'); });
    assert.equal(missing.review.outcome, 'incomplete');
    assert.throws(() => check(updated), /requires_passing_product_review_for_head/);
    const mismatched = run(() => flow.reader(flow.directory, fixedHead, at));
    assert.equal(mismatched.review.outcome, 'incomplete');
    assert.equal(mismatched.review.ticketReview?.quality, null);
    assert.throws(() => check(updated), /requires_passing_product_review_for_head/);
    assert.throws(() => run(flow.reader, pass, () => {
      observed++;
      return observed % 2 ? target : { ...target, head: fixedHead };
    }), /head_changed/);
    assert.throws(() => check(updated), /requires_passing_product_review_for_head/);
    const completed = run();
    assert.equal(completed.review.outcome, 'passed', JSON.stringify(completed.review));
    assert.deepEqual(completed.review.ticketReview?.priorReview, ref(aggregate));
    assert.equal(completed.review.ticketReview?.quality?.commit, updated);
    assert.equal(completed.review.ticketReview?.from, reviewedCommit);
    assert.deepEqual(completed.review.results, []);
    assert.equal(check(updated).managed, true);
    assert.deepEqual(check(updated).review, ref(completed.review));
    const tampered = structuredClone(flow.store.history('project-1'));
    const tamperedReview = tampered.find(record => record.kind === 'product_review' && record.revision === completed.review.revision &&
      record.id === completed.review.id);
    assert.ok(tamperedReview?.kind === 'product_review' && tamperedReview.ticketReview?.changes);
    tamperedReview.ticketReview.changes.patch = '';
    assert.equal(validateReviewForCompletion(tampered, completed.review).ok, false);
    assert.throws(() => check(updated, `${repoUrl}/pull/32`), /pull_request_mismatch/);
    assert.equal(run(() => { throw Error('must replay'); }).replayed, true);

    const snapshots = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const { changes, priorPass, originalRequests, deliveredFiles, workerReturns } =
      snapshots.find(snapshot => snapshot.head === fixedHead);
    assert.equal(priorPass.head, reviewedCommit);
    assert.equal(originalRequests[0].text, original);
    assert.match(changes.patch, /\+export const fixed = true/);
    assert.match(changes.patch, /-const obsolete = "remove this legacy code";/);
    assert.doesNotMatch(changes.patch, /feature\.js|system\.featureX/);
    assert.equal(deliveredFiles, undefined);
    assert.equal(workerReturns, undefined);

    flow.git('mv', 'fix.js', 'renamed.js');
    const newer = commitAll('Rename fix');
    target = { ...target, head: newer };
    assert.throws(() => check(newer), /requires_passing_product_review_for_head/);
    const next = run();
    assert.equal(next.review.outcome, 'passed');
    assert.deepEqual(next.review.ticketReview?.priorReview, ref(completed.review));
    assert.match(next.review.ticketReview!.changes!.patch, /rename from fix.js\nrename to renamed.js/);
    assert.deepEqual(check(newer).review, ref(next.review));

    // A change to the native authority also requires whole-PR review.
    currentTicket = { id: delivery.taskId, text: `${original} Preserve the revised interface.` };
    writeFileSync(join(flow.directory, 'renamed.js'), 'export const fixed = false;\n');
    target = { ...target, head: commitAll('Change under revised authority') };
    const changedScope = run(flow.reader, { ...pass, verdict: 'uncertain' });
    assert.equal(changedScope.review.outcome, 'incomplete');
    assert.equal(changedScope.review.ticketReview?.priorReview, undefined);
    assert.throws(() => check(target.head), /requires_passing_product_review_for_head/);
    currentTicket = undefined;

    flow.git('switch', '--detach', flow.commit);
    writeFileSync(join(flow.directory, 'replacement.js'), 'export const replacement = true;\n');
    const divergent = commitAll('Rewrite delivery');
    target = { ...target, head: divergent };
    assert.throws(() => check(divergent), /requires_passing_product_review_for_head/);
    const uncertainFull = run(flow.reader, { ...pass, verdict: 'uncertain' });
    assert.equal(uncertainFull.review.outcome, 'incomplete');
    assert.equal(uncertainFull.review.ticketReview?.priorReview, undefined);
    assert.equal(uncertainFull.review.ticketReview?.from, flow.commit);
    assert.throws(() => check(divergent), /requires_passing_product_review_for_head/);
    const full = run();
    assert.equal(full.review.outcome, 'passed');
    assert.deepEqual(check(divergent).review, ref(full.review));
    writeFileSync(join(flow.directory, 'replacement.js'), 'export const replacement = "later";\n');
    target = { ...target, head: commitAll('Advance rewritten delivery') };
    const afterFull = run();
    assert.deepEqual(afterFull.review.ticketReview?.priorReview, ref(full.review));
    target = { ...target, url: `${repoUrl}/pull/32` };
    assert.throws(() => run(), /ticket_publication_conflict/);
  } finally { flow.close(); }
});
