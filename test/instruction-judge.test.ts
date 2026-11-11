import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectStore, RecordsSchema, prepareWorkerBrief, checkWorkerBrief, requiredAssignmentContext, ref,
  type Assignment, type FactoryRecord } from '../src/index.js';
import { fakeJudge, fakeVerdict } from './judge-helper.js';

const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
function setup(edit?: (records: FactoryRecord[]) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-judge-'));
  const records = structuredClone(baseline.filter((record) => ['project', 'request', 'criterion', 'feature_revision',
    'design_revision', 'implementation_plan_revision', 'detailed_plan_task', 'task_mapping'].includes(record.kind)));
  edit?.(records);
  const db = join(directory, 'project.sqlite'); const store = new ProjectStore(db);
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history: records, receipts: [] });
  const template = baseline.find((record): record is Assignment => record.kind === 'assignment')!;
  const sourceFiles = requiredAssignmentContext(records, template).sources.filter((source) => !source.record).map((source, index) => {
    const path = join(directory, `source-${index}.txt`); writeFileSync(path, 'Supplied source snapshot.'); return { source, path };
  });
  const briefPath = join(directory, 'brief.md'); writeFileSync(briefPath, readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url), 'utf8'));
  const prepared = prepareWorkerBrief(store, { projectId: 'project-1', assignmentId: 'agent-assignment', attemptId: 'attempt-1', expectedRevision: 0,
    idempotencyKey: 'prepare-1', issuedAt: '2026-11-11T12:00:00Z', detailedPlanTask: template.detailedPlanTask, plan: template.plan,
    firstMateTaskId: template.firstMateTaskId, returnLocation: 'report.md', briefPath, sourceFiles });
  assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.equal(prepared.instructionFidelity, 'untested');
  const check = (config?: unknown) => checkWorkerBrief(store, 'project-1', prepared.assignment, briefPath, config);
  return { store, db, directory, briefPath, prepared, check,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const name of ['narrowed-task', 'adapter-boundary']) test(`agent judges the owner review example: ${name}`, () => {
  const fixturePath = new URL(`../../fixtures/instruction-judge/${name}.json`, import.meta.url).pathname;
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const flow = setup((records) => {
    const task = records.find((record) => record.kind === 'detailed_plan_task'); assert.ok(task?.kind === 'detailed_plan_task');
    task.expectedBehavior = fixture.expectedBehavior;
    if (name === 'adapter-boundary') task.boundaries!.push(fixture.candidateIncludes);
  });
  try {
    const recordPath = join(flow.directory, 'one-call.jsonl');
    const before = flow.store.exportProject('project-1');
    const result = flow.check({ ...fakeJudge, args: [...fakeJudge.args!, '--case', fixturePath, '--record', recordPath] });
    assert.equal(result.ok, name === 'adapter-boundary', JSON.stringify(result));
    assert.equal(readFileSync(recordPath, 'utf8').trimEnd().split('\n').length, 1);
    const input = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(input.originalRequests[0].text, fixture.originalRequest);
    assert.deepEqual(ref(input.design), { id: 'design-1', revision: 1 });
    assert.deepEqual(ref(input.task), { id: 'task-1', revision: 1 });
    assert.ok(input.candidateInstructions.includes(fixture.candidateIncludes));
    assert.ok(result.judgment?.ok);
    if (result.judgment?.ok) assert.deepEqual(result.judgment.verdict, fixture.verdict);
    assert.deepEqual(flow.store.exportProject('project-1'), before, 'The start gate is read-only');
    if (!result.ok) assert.ok(result.findings.some((finding) => finding.code === 'narrowed_generality'));
  } finally { flow.close(); }
});

for (const type of ['omission', 'invented_scope'] as const) test(`grounded ${type} findings block dispatch with quoted evidence`, () => {
  const flow = setup();
  try {
    const verdict = { verdict: 'fail' as const, findings: [{ type, message: `Concrete ${type} finding`,
      quotes: [{ source: 'original_request' as const, text: 'every connected system' }] }] };
    const result = flow.check(fakeVerdict(verdict)); assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === (type === 'omission' ? 'omitted_behavior' : 'invented_scope')));
    assert.ok(result.judgment?.ok);
    if (result.judgment?.ok) assert.deepEqual(result.judgment.verdict, verdict);
  } finally { flow.close(); }
});

const invalidOutputs = ['', '{}', 'not JSON', '{"verdict":"pass","findings":[]} trailing text',
  '{"verdict":"fail","verdict":"pass","findings":[]}', '{"verdict":"pass","findings":[],"unexpected":true}',
  '{"verdict":"fail","findings":[]}', '{"verdict":"pass","findings":[{"type":"omission","message":"missing","quotes":[{"source":"original_request","text":"every connected system"}]}]}',
  '{"verdict":"fail","findings":[{"type":"omission","message":"missing","quotes":[{"source":"task","text":"a fabricated quotation"}]}]}'];
for (const [index, output] of invalidOutputs.entries()) test(`invalid agent result ${index + 1} fails closed`, () => {
  const flow = setup();
  try {
    const result = flow.check({ ...fakeJudge, args: [...fakeJudge.args!, '--result', output] });
    assert.equal(result.ok, false); assert.ok(result.findings.some((finding) => finding.code === 'instruction_judge_unavailable'));
  } finally { flow.close(); }
});

for (const mode of ['missing', 'spawn', 'exit', 'timeout'] as const) test(`${mode} judge cannot pass the start gate`, () => {
  const flow = setup();
  try {
    const config = mode === 'missing' ? undefined : mode === 'spawn' ? { executable: join(flow.directory, 'missing-agent') } :
      { ...fakeJudge, args: [...fakeJudge.args!, ...(mode === 'exit' ? ['--exit', '4'] : ['--sleep', '2000'])], timeoutMs: 150 };
    const result = flow.check(config); assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'instruction_judge_unavailable'));
  } finally { flow.close(); }
});

test('each check calls one agent; an earlier pass cannot substitute for a missing judge', () => {
  const flow = setup();
  try {
    const recordPath = join(flow.directory, 'calls.jsonl');
    const config = { ...fakeJudge, args: [...fakeJudge.args!, '--record', recordPath] };
    assert.equal(flow.check(config).ok, true); assert.equal(flow.check(config).ok, true);
    assert.equal(flow.check().ok, false);
    assert.equal(readFileSync(recordPath, 'utf8').trimEnd().split('\n').length, 2);
  } finally { flow.close(); }
});

test('a faithful candidate paraphrase reaches the judge while changed intent and scaffold still fail mechanically', () => {
  const flow = setup();
  try {
    const original = readFileSync(flow.briefPath, 'utf8');
    writeFileSync(flow.briefPath, original.replace('Feature X across connected systems, including a second-system acceptance case.', 'Deliver the planned common feature and demonstrate a second system.'));
    assert.equal(flow.check(fakeJudge).ok, true);
    writeFileSync(flow.briefPath, original.replace('Build feature X', 'Change the original ask'));
    assert.ok(flow.check(fakeJudge).findings.some((finding) => finding.code === 'changed_captains_intent'));
    writeFileSync(flow.briefPath, original.replace('mode=local-only', 'mode=remote'));
    assert.ok(flow.check(fakeJudge).findings.some((finding) => finding.code === 'damaged_scaffold'));
  } finally { flow.close(); }
});

test('CLI returns nonzero without a configured judge and accepts a configured fake agent', () => {
  const flow = setup();
  try {
    const configPath = join(flow.directory, 'judge.json'); writeFileSync(configPath, JSON.stringify(fakeJudge));
    const cli = new URL('../src/cli.js', import.meta.url).pathname;
    const args = [cli, 'check-brief', '--db', flow.db, '--project', 'project-1', '--assignment', flow.prepared.assignment.id,
      '--revision', '1', '--brief', flow.briefPath];
    const missing = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).ok, false);
    const configured = spawnSync(process.execPath, [...args, '--judge-config', configPath], { encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr); assert.equal(JSON.parse(configured.stdout).judgment.verdict.verdict, 'pass');
  } finally { flow.close(); }
});

for (const changed of ['brief', 'source'] as const) test(`a passing verdict cannot approve ${changed} changed during judgment`, () => {
  const flow = setup();
  try {
    const path = changed === 'brief' ? flow.briefPath : join(flow.directory, 'source-0.txt');
    const result = flow.check({ ...fakeJudge, args: [...fakeJudge.args!, '--rewrite', path] });
    assert.equal(result.ok, false);
    assert.ok(result.judgment?.ok && result.judgment.verdict.verdict === 'pass');
    assert.ok(result.findings.some((finding) => finding.code === (changed === 'brief' ? 'candidate_changed' : 'missing_required_context')));
  } finally { flow.close(); }
});
