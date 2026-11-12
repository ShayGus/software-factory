import { fakeRuntime } from './runtime-helper.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProjectStore, RecordsSchema, queueCorrection, deliverCorrection, recordCorrectionFact, correctionDeliveryStatus,
  validateReviewForCompletion, validateAssignmentForDispatch, validateRecords, ref, correctionOperation, taskReadinessReasons, assertRevisionTransition, requiredAssignmentContext, type CorrectionAdapterOptions,
  prepareWorkerBrief, checkWorkerBrief, type Assignment, type Observation, type FactoryRecord, type CorrectionAction } from '../src/index.js';
import { fakeJudge } from './judge-helper.js';
import { fakeTask, fakeTaskWrapper } from './task-wrapper-helper.js';

const projectId = 'project-1';
const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-corrections-'));
  const database = join(directory, 'store.sqlite');
  const store = new ProjectStore(database);
  store.importProject({ schemaVersion: 1, projectId, history: baseline.filter(record => !['observation', 'guidance_revision'].includes(record.kind)), receipts: [] });
  const runtime = fakeRuntime(directory, ['pilot-build']);
  const executable = join(directory, 'wrapper');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const home = process.env.FM_HOME;
fs.appendFileSync(path.join(home, 'calls'), JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env).filter(k => k.startsWith('FM_')) }) + '\\n');
if (fs.existsSync(path.join(home, 'fail'))) process.exit(1);
process.stdout.write(process.argv[3] === 'interrupt' ? 'interrupt-delivered pilot-build harness=codex backend=tmux verified=agent-alive cancel=confirmed\\n' : 'accepted');
`);
  chmodSync(executable, 0o755);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const assignment = () => { const item = store.get(projectId, 'assignment-1'); assert.ok(item?.kind === 'assignment'); return item; };
  const options = (state: 'active' | 'stopped' | 'unknown' = 'active'): CorrectionAdapterOptions => ({ fmHome: directory,
    sendExecutable: executable, controlExecutable: executable, snapshotExecutable: runtime.executable, recipients: [{ assignment: ref(assignment()),
      attemptId: assignment().attemptId, firstMateTaskId: assignment().firstMateTaskId, state, observedAt: new Date().toISOString() }] });
  let number = 0;
  const command = (action: CorrectionAction = 'clarification', extra: Record<string, unknown> = {}) => {
    const n = ++number;
    return { schemaVersion: 1 as const, id: `command-${n}`, projectId, issuedAt: new Date().toISOString(),
      idempotencyKey: `correction-key-${n}`, command: 'deliver_correction' as const, targetId: `correction-${n}`, expectedRevision: 0,
      payload: { affectedRevision: ref(store.get(projectId, 'feature-1')!), assignment: ref(assignment()),
        originalCorrection: `Correction ${n}: preserve the exact source\nwith trailing detail`, action, sequence: n,
        supersedes: [], sourceRefs: [{ uri: `fixture://source/${n}` }], ...extra } };
  };
  const queue = (action: CorrectionAction = 'clarification', extra: Record<string, unknown> = {}) => queueCorrection(store, command(action, extra));
  const deliver = (id: string, config = options()) => deliverCorrection(store, projectId, id, config);
  const calls = (): { args: string[]; env: string[] }[] => {
    try { return readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; }
  };
  const observation = (id: string) => store.get(projectId, id) as Observation;
  const fact = (id: string, name: 'acknowledged' | 'incorporated') => {
    const record = observation(id);
    return recordCorrectionFact(store, { projectId, correction: ref(record), assignment: record.correction!.assignment,
      fact: name, at: new Date().toISOString(), idempotencyKey: `${name}-${id}`, evidence: [{ artifact: { uri: `fixture://${name}/${id}`, revision: '1' },
        description: name === 'acknowledged' ? 'Durable inbox message moved to handled' : 'Verified correction in delivered artifact', observedAt: new Date().toISOString() }] });
  };
  return { directory, database, store, options, command, queue, deliver, calls, observation, fact, assignment };
}

test('ordered steering goes to the exact current attempt and preserves the original correction', t => {
  const flow = setup(t); const first = flow.queue(); const second = flow.queue();
  assert.equal(flow.deliver(second.correction.id).state, 'pending'); assert.equal(flow.calls().length, 0);
  assert.equal(flow.deliver(first.correction.id).state, 'succeeded');
  assert.equal(flow.deliver(second.correction.id).state, 'succeeded');
  assert.deepEqual(flow.calls().map(call => JSON.parse(call.args[1]!).corrections[0].sequence), [1, 2]);
  assert.ok(flow.calls().every(call => call.args[0] === 'pilot-build'));
  assert.equal(JSON.parse(flow.calls()[0]!.args[1]!).attemptId, 'attempt-1');
  assert.equal(JSON.parse(flow.calls()[0]!.args[1]!).corrections[0].originalText, first.correction.correction!.originalText);
  assert.deepEqual(flow.calls()[0]!.env, ['FM_HOME']);
  flow.deliver(first.correction.id); assert.equal(flow.calls().length, 2);
});

test('compatible pending amendments consolidate recursively without losing any source or instruction', t => {
  const flow = setup(t);
  const ids = [1, 2, 3].map(n => flow.queue('amended_scope', { changedOutcome: `Outcome ${n}`, compatibilityKey: 'same-outcome-edit' }).correction.id);
  assert.equal(flow.store.get(projectId, 'feature-1')!.revision, 4);
  assert.equal(flow.assignment().revision, 4);
  const feature = flow.store.get(projectId, 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  const context = requiredAssignmentContext(flow.store.history(projectId), { ...flow.assignment(), feature: ref(feature) });
  for (const id of ids) {
    const decision = feature.decisions.map(pointer => flow.store.get(projectId, pointer.id, pointer.revision))
      .find(record => record?.kind === 'decision_change' && record.originalInstruction === flow.observation(id).correction!.originalText);
    assert.ok(decision?.kind === 'decision_change');
    assert.ok(context.sources.some(source => source.record?.id === decision.id), 'Future briefs must carry the original scope amendment');
  }
  assert.equal(flow.assignment().correctionContext?.requiresReplan, true);
  assert.equal(flow.observation(ids[0]!)!.correction!.supersededBy!.id, ids[1]);
  assert.equal(flow.deliver(ids[2]!).state, 'succeeded');
  const delivered = JSON.parse(flow.calls()[0]!.args[1]!).corrections;
  assert.deepEqual(delivered.map((item: { sequence: number }) => item.sequence), [1, 2, 3]);
  assert.deepEqual(delivered.map((item: { sources: { uri: string }[] }) => item.sources[0]!.uri),
    ['fixture://source/1', 'fixture://source/2', 'fixture://source/3']);
  for (const id of ids.slice(0, 2)) assert.equal(flow.observation(id).correction!.facts.some(f => f.fact === 'delivered'), false);
  assert.equal(flow.observation(ids[2]!).correction!.impact!.completedEvidence.length, 3);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
});

test('a distinct intervening clarification prevents amendment coalescing across it', t => {
  const flow = setup(t);
  const first = flow.queue('amended_scope', { changedOutcome: 'Changed once', compatibilityKey: 'outcome' });
  flow.queue();
  const third = flow.queue('amended_scope', { changedOutcome: 'Changed twice', compatibilityKey: 'outcome' });
  assert.equal(flow.observation(first.correction.id).correction!.supersededBy, undefined);
  assert.equal(flow.deliver(third.correction.id).state, 'pending');
});

test('urgent stop bypasses pending earlier steering and maps exactly to interrupt', t => {
  const flow = setup(t); flow.queue();
  const stop = flow.queue('clarification', { urgentStop: true });
  assert.equal(flow.deliver(stop.correction.id).state, 'succeeded');
  assert.deepEqual(flow.calls().map(call => call.args), [['pilot-build', 'interrupt']]);
  assert.equal(flow.observation(stop.correction.id).correction!.supersededBy, undefined);
});

test('rewind exposes missing capability and never invokes any lifecycle or launch operation', t => {
  const flow = setup(t); const correction = flow.queue('rewind');
  const operation = flow.deliver(correction.correction.id);
  assert.equal(operation.state, 'failed'); assert.match(operation.reconciliation!.note, /Missing capability/);
  assert.equal(flow.calls().length, 0);
});

test('resume requires a stopped exact attempt and calls only relaunch', t => {
  const flow = setup(t); const correction = flow.queue('resume');
  assert.equal(flow.deliver(correction.correction.id).state, 'pending');
  assert.equal(flow.deliver(correction.correction.id, flow.options('stopped')).state, 'succeeded');
  assert.deepEqual(flow.calls()[0]!.args, ['pilot-build', 'relaunch']);
});

test('delivery failure stays unresolved, cannot acknowledge or complete, and never blindly retries', t => {
  const flow = setup(t); const correction = flow.queue();
  writeFileSync(join(flow.directory, 'fail'), 'fail');
  assert.equal(flow.deliver(correction.correction.id).state, 'unknown');
  assert.throws(() => flow.fact(correction.correction.id, 'acknowledged'), /delivered_exact_recipient/);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
  flow.deliver(correction.correction.id); assert.equal(flow.calls().length, 1);
});

test('acknowledgement is independent of incorporation; only evidence of incorporation clears the correction gate', t => {
  const flow = setup(t); const correction = flow.queue();
  flow.deliver(correction.correction.id); flow.fact(correction.correction.id, 'acknowledged');
  assert.deepEqual(flow.observation(correction.correction.id).correction!.facts.map(f => f.fact), ['recorded', 'delivered', 'acknowledged']);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
  flow.fact(correction.correction.id, 'incorporated');
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, true);
});

for (const missing of ['absent', 'unknown', 'stale', 'wrong-attempt', 'wrong-revision'] as const) test(`unresolved ${missing} recipient does not deliver`, t => {
  const flow = setup(t); const correction = flow.queue(); const options = flow.options();
  if (missing === 'absent') options.recipients = [];
  if (missing === 'unknown') options.recipients[0]!.state = 'unknown';
  if (missing === 'stale') options.recipients[0]!.observedAt = '2020-01-01T00:00:00Z';
  if (missing === 'wrong-attempt') options.recipients[0]!.attemptId = 'another-attempt';
  if (missing === 'wrong-revision') options.recipients[0]!.assignment.revision++;
  assert.equal(flow.deliver(correction.correction.id, options).state, 'pending'); assert.equal(flow.calls().length, 0);
});

test('idempotency and sequence conflicts leave intent and revisions unchanged', t => {
  const flow = setup(t); const command = flow.command();
  const one = queueCorrection(flow.store, command);
  assert.deepEqual(queueCorrection(flow.store, command), one);
  assert.throws(() => queueCorrection(flow.store, { ...command, payload: { ...command.payload, originalCorrection: 'Different' } }), /idempotency_conflict/);
  assert.throws(() => queueCorrection(flow.store, { ...flow.command(), payload: { ...command.payload, sequence: 3 } }), /sequence_must_be_next/);
  assert.equal(flow.store.records(projectId).filter(record => record.kind === 'observation' && record.correction).length, 1);
});

test('late returns stay historical and cannot close a changed outcome', t => {
  const flow = setup(t); const old = flow.store.get(projectId, 'result-general')!;
  flow.queue('amended_scope', { changedOutcome: 'A changed outcome requires new design evidence' });
  assert.deepEqual(flow.store.get(projectId, old.id), old);
  assert.equal(validateRecords(flow.store.history(projectId)).ok, true);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
});

test('cancellation and new work require matching BUILD-08 commands; no spawn mapping exists', t => {
  const flow = setup(t);
  assert.throws(() => flow.queue('new_work'), /BUILD08/);
  const operations = ['clarification', 'amended_scope', 'rewind', 'resume', 'cancellation', 'new_work', 'status'].map(action => correctionOperation(action as CorrectionAction));
  assert.deepEqual(operations, ['steer', 'steer', 'unsupported_rewind', 'relaunch', 'cancel_task', 'create_task', 'read_status']);
});

test('cancellation uses BUILD-08 with fake task and lifecycle wrappers', t => {
  const flow = setup(t); const fake = fakeTaskWrapper(flow.directory, false, flow.database);
  fake.edit(state => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'in_flight' }); });
  const command = flow.command('cancellation', { taskCommand: {
    schemaVersion: 1, id: 'cancel-task', projectId, issuedAt: new Date().toISOString(), idempotencyKey: 'cancel-task',
    command: 'map_manage_execution_task', targetId: 'mapping-1', expectedRevision: 1,
    payload: { task: { kind: 'existing', firstMateTaskId: 'pilot-build' }, action: 'cancel', feature: { id: 'feature-1', revision: 1 },
      criteria: flow.assignment().criteria, detailedPlanTask: flow.assignment().detailedPlanTask, dependencies: [], reason: 'Explicit cancellation' } } });
  const correction = queueCorrection(flow.store, command);
  const options = flow.options(); options.taskAdapter = { fmHome: flow.directory, tasksExecutable: fake.executable,
    controlExecutable: options.controlExecutable, snapshotExecutable: options.snapshotExecutable! };
  assert.equal(flow.deliver(correction.correction.id, options).state, 'succeeded');
  assert.deepEqual(flow.calls()[0]!.args, ['pilot-build', 'exit']);
  const mapping = flow.store.get(projectId, 'mapping-1'); assert.ok(mapping?.kind === 'task_mapping');
  assert.equal(mapping.disposition.state, 'cancelled');
});

test('CLI queues and delivers through configured fake wrappers', t => {
  const flow = setup(t); const input = join(flow.directory, 'input.json'); const config = join(flow.directory, 'config.json');
  writeFileSync(input, JSON.stringify(flow.command())); writeFileSync(config, JSON.stringify(flow.options()));
  const cli = (args: string[]) => spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname,
    ...args, '--db', flow.database], { encoding: 'utf8' });
  const queued = cli(['queue-correction', '--input', input]); assert.equal(queued.status, 0, queued.stderr);
  const id = JSON.parse(queued.stdout).correction.id;
  const delivered = cli(['deliver-correction', '--project', projectId, '--correction', id, '--adapter-config', config]);
  assert.equal(delivered.status, 0, delivered.stderr); assert.equal(JSON.parse(delivered.stdout).state, 'succeeded');
});

// Verify a new attempt under the same runtime task ID cannot receive old steering.
test('a replacement attempt rejects pending steering and old review completion', t => {
  const flow = setup(t); const queued = flow.queue(); const at = new Date().toISOString();
  const assignment = { ...flow.assignment(), id: 'replacement', attemptId: 'attempt-2', createdAt: at, updatedAt: at };
  const decision = { kind: 'decision_change' as const, id: 'replace-decision', projectId, schemaVersion: 1 as const, revision: 1,
    createdAt: at, updatedAt: at, questionOrChange: 'New explicit attempt', affectedRecords: [ref(flow.assignment())], rationale: 'Explicit replacement',
    disposition: 'selected' as const, sourceRefs: [{ uri: 'fixture://replacement' }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
    command: 'record_decision_suggestion', targetId: assignment.id, expectedRevision: 0, payload: { decision } }, () => [decision, assignment] as FactoryRecord[]);
  assert.equal(flow.deliver(queued.correction.id).state, 'pending'); assert.equal(flow.calls().length, 0);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
});

test('request-linked clarification advances request metadata and preserves the captured original', t => {
  const flow = setup(t); const request = flow.store.get(projectId, 'request-1'); assert.ok(request?.kind === 'request');
  const correction = flow.queue('clarification', { affectedRevision: ref(request) });
  const next = flow.store.get(projectId, request.id); assert.ok(next?.kind === 'request');
  assert.equal(next.revision, 2); assert.equal(next.originalText, request.originalText);
  assert.deepEqual(next.interpretationRefs.at(-1), ref(correction.correction));
});

test('missing steering executable reports failed without claiming delivery', t => {
  const flow = setup(t); const correction = flow.queue(); const options = flow.options();
  options.sendExecutable = join(flow.directory, 'missing');
  assert.equal(flow.deliver(correction.correction.id, options).state, 'failed');
  assert.deepEqual(flow.observation(correction.correction.id).correction!.facts.map(f => f.fact), ['recorded']);
});

for (const state of ['state: active', 'state: unknown', 'arbitrary output']) test(`status reads ${state} without steering or lifecycle`, t => {
  const flow = setup(t); const correction = flow.queue('status');
  const executable = join(flow.directory, 'state-wrapper');
  writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(state + '\n')});\n`); chmodSync(executable, 0o755);
  const options = flow.options(); options.stateExecutable = executable;
  assert.equal(flow.deliver(correction.correction.id, options).state, state === 'state: active' ? 'succeeded' : 'unknown');
  assert.equal(flow.calls().length, 0);
});

test('new work creates a held managed task through BUILD-08 without launching or steering', t => {
  const flow = setup(t); const fake = fakeTaskWrapper(flow.directory, false, flow.database);
  const command = flow.command('new_work', { taskCommand: {
    schemaVersion: 1, id: 'new-task', projectId, issuedAt: new Date().toISOString(), idempotencyKey: 'new-task',
    command: 'map_manage_execution_task', targetId: 'new-mapping', expectedRevision: 0,
    payload: { task: { kind: 'new', firstMateTaskId: 'followup', title: 'Planned followup', repo: 'sample' }, action: 'create',
      feature: { id: 'feature-1', revision: 1 }, criteria: flow.assignment().criteria, detailedPlanTask: flow.assignment().detailedPlanTask,
      dependencies: [], readiness: [{ id: 'hold-for-check', reason: 'Check before execution', evidence: [] }], reason: 'Explicit new work' } } });
  const correction = queueCorrection(flow.store, command);
  const options = flow.options(); options.taskAdapter = { fmHome: flow.directory, tasksExecutable: fake.executable, guardTaskId: 'permanent-guard' };
  assert.equal(flow.deliver(correction.correction.id, options).state, 'succeeded');
  assert.equal(fake.read().tasks.followup!.held, true); assert.equal(flow.calls().length, 0);
});

test('pending correction invalidates completed prerequisite evidence until incorporation', t => {
  const flow = setup(t); const mapping = flow.store.get(projectId, 'mapping-1'); assert.ok(mapping?.kind === 'task_mapping');
  const consumer = { ...mapping, id: 'consumer', firstMateTaskId: 'consumer', detailedPlanTask: { id: 'consumer-task', revision: 1 },
    management: { operationId: '', requirements: [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'consumer-task', reason: 'Need corrected result',
      needs: { kind: 'criterion' as const, criterion: { id: 'criterion-general', revision: 1 } } }], paused: false,
      readiness: [], managedDependencies: [], holdReason: 'Consumer readiness' } };
  assert.deepEqual(taskReadinessReasons(flow.store.records(projectId), consumer), []);
  const correction = flow.queue();
  assert.match(taskReadinessReasons(flow.store.records(projectId), consumer).join('\n'), /Product prerequisite not met/);
  flow.deliver(correction.correction.id); flow.fact(correction.correction.id, 'acknowledged');
  assert.match(taskReadinessReasons(flow.store.records(projectId), consumer).join('\n'), /Product prerequisite not met/);
  flow.fact(correction.correction.id, 'incorporated');
  assert.deepEqual(taskReadinessReasons(flow.store.records(projectId), consumer), []);
});

test('correction revision cannot erase original source or prior delivery facts', t => {
  const flow = setup(t); const correction = flow.queue(); flow.deliver(correction.correction.id);
  const record = flow.observation(correction.correction.id); assert.ok(record.correction);
  const next = { ...record, revision: record.revision + 1 };
  assert.throws(() => assertRevisionTransition(record, { ...next, correction: { ...record.correction, originalText: 'Rewritten source' } }), /correction_history_mutation/);
  assert.throws(() => assertRevisionTransition(record, { ...next, correction: { ...record.correction,
    facts: record.correction!.facts.filter(fact => fact.fact !== 'delivered') } }), /correction_history_mutation/);
});

function commitReviewFixture(flow: ReturnType<typeof setup>, writes: FactoryRecord[], key: string) {
  const at = new Date().toISOString(); const target = writes[0]!;
  const decision = { kind: 'decision_change' as const, id: key, projectId, schemaVersion: 1 as const, revision: 1,
    createdAt: at, updatedAt: at, questionOrChange: 'Explicit review regression fixture update', affectedRecords: writes.map(ref),
    rationale: 'Exercise checked successor records or lifecycle progress', disposition: 'selected' as const,
    sourceRefs: [{ uri: 'fixture://review-1214' }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: key, projectId, issuedAt: at, idempotencyKey: key,
    command: 'record_decision_suggestion', targetId: target.id, expectedRevision: target.revision - 1, payload: { decision } },
  () => [decision, ...writes]);
}

function checkedScopeSuccessor(flow: ReturnType<typeof setup>, key = 'checked-scope-successor') {
  const feature = flow.store.get(projectId, 'feature-1'); const design = flow.store.get(projectId, 'design-1');
  const plan = flow.store.get(projectId, 'plan-1'); const task = flow.store.get(projectId, 'task-1');
  const mapping = flow.store.get(projectId, 'mapping-1'); const assignment = flow.assignment();
  assert.ok(feature?.kind === 'feature_revision' && design?.kind === 'design_revision' && plan?.kind === 'implementation_plan_revision' &&
    task?.kind === 'detailed_plan_task' && mapping?.kind === 'task_mapping');
  const at = new Date().toISOString();
  const nextDesign = { ...design, revision: design.revision + 1, updatedAt: at, feature: ref(feature) };
  const nextPlan = { ...plan, revision: plan.revision + 1, updatedAt: at, feature: ref(feature), design: ref(nextDesign),
    deliverySequence: [{ id: task.id, revision: task.revision + 1 }], readiness: { ...plan.readiness,
      comparison: { ...plan.readiness.comparison, sourceRefs: [...plan.readiness.comparison.sourceRefs, { uri: 'fixture://checked-design', record: ref(nextDesign) }] } } };
  const nextTask = { ...task, revision: task.revision + 1, updatedAt: at, feature: ref(feature), design: ref(nextDesign), plan: ref(nextPlan) };
  const nextMapping = { ...mapping, revision: mapping.revision + 1, updatedAt: at, feature: ref(feature), detailedPlanTask: ref(nextTask) };
  const replacements = new Map([nextDesign, nextPlan, nextTask, feature].map(record => [record.id, ref(record)]));
  const source = (item: typeof assignment.sourceRefs[number]) => item.record && replacements.has(item.record.id) ?
    { ...item, record: replacements.get(item.record.id)! } : item;
  const nextAssignment = { ...assignment, revision: assignment.revision + 1, updatedAt: at, feature: ref(feature),
    design: ref(nextDesign), plan: ref(nextPlan), detailedPlanTask: ref(nextTask),
    sourceRefs: assignment.sourceRefs.map(source), selectedContext: assignment.selectedContext.map(item => ({ ...item, source: source(item.source) })),
    instructionFidelity: { ...assignment.instructionFidelity, sourceRefs: assignment.instructionFidelity.sourceRefs.map(source) },
    ...(assignment.correctionContext ? { correctionContext: { ...assignment.correctionContext, requiresReplan: false } } : {}) };
  commitReviewFixture(flow, [nextDesign, nextPlan, nextTask, nextMapping, nextAssignment], key);
  return nextAssignment;
}

function incorporationInput(flow: ReturnType<typeof setup>, id: string, assignment = flow.assignment()) {
  return { projectId, correction: ref(flow.observation(id)), assignment: ref(assignment), fact: 'incorporated',
    at: new Date().toISOString(), idempotencyKey: `successor-incorporation-${id}`, evidence: [{
      artifact: { uri: 'fixture://verified-successor', revision: 'result-2' }, description: 'Verified correction in checked successor implementation',
      observedAt: new Date().toISOString() }] };
}

test('review 1214-1: scope incorporation follows a checked successor of the delivered attempt', t => {
  const flow = setup(t); const queued = flow.queue('amended_scope', { changedOutcome: 'Deliver the corrected outcome' });
  assert.equal(flow.deliver(queued.correction.id).state, 'succeeded');
  const delivered = flow.observation(queued.correction.id).correction!.assignment;
  const successor = checkedScopeSuccessor(flow);
  const recorded = recordCorrectionFact(flow.store, incorporationInput(flow, queued.correction.id, successor));
  assert.ok(recorded.correction!.facts.some(item => item.fact === 'incorporated'));
  assert.deepEqual(recorded.correction!.assignment, delivered, 'The delivery revision remains historical');
});

test('review 1214-2: a state-only feature revision permits current-scope review before completion evidence exists', t => {
  const flow = setup(t); const feature = flow.store.get(projectId, 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  commitReviewFixture(flow, [{ ...feature, revision: 2, previousRevision: 1, updatedAt: new Date().toISOString(),
    state: 'in_review', methodStage: 'product_review', changeReason: 'Begin product review' }], 'state-only-review');
  const result = validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('review 1214-3: a concurrent replacement during steering cannot inherit the delivery receipt', t => {
  const flow = setup(t); const queued = flow.queue(); const original = flow.assignment();
  const executable = join(flow.directory, 'replace-during-send.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import { ProjectStore, ref } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
const store = new ProjectStore(${JSON.stringify(flow.database)});
const previous = store.get('project-1', 'assignment-1');
const at = new Date().toISOString();
const replacement = { ...previous, revision: previous.revision + 1, updatedAt: at, attemptId: 'replacement-attempt' };
const decision = { kind: 'decision_change', id: 'wrapper-replacement', projectId: 'project-1', schemaVersion: 1, revision: 1,
createdAt: at, updatedAt: at, questionOrChange: 'Replace the attempt concurrently', affectedRecords: [ref(previous)],
rationale: 'Deterministic replacement while fm-send runs', disposition: 'selected', sourceRefs: [{ uri: 'fixture://race' }], scopeChanges: [] };
store.mutate({ schemaVersion: 1, id: decision.id, projectId: 'project-1', issuedAt: at, idempotencyKey: decision.id,
command: 'record_decision_suggestion', targetId: previous.id, expectedRevision: previous.revision, payload: { decision } }, () => [decision, replacement]);
store.close();
process.stdout.write('accepted by original recipient');
`); chmodSync(executable, 0o755);
  const options = flow.options(); options.sendExecutable = executable;
  const operation = flow.deliver(queued.correction.id, options);
  assert.equal(operation.state, 'unknown');
  assert.deepEqual(flow.observation(queued.correction.id).correction!.assignment, ref(original));
  assert.equal(flow.observation(queued.correction.id).correction!.facts.some(item => item.fact === 'delivered'), false);
  assert.throws(() => recordCorrectionFact(flow.store, incorporationInput(flow, queued.correction.id)), /recipient|delivered/);
});

test('review 1214-4: urgent status cannot become an interrupt', t => {
  const flow = setup(t);
  assert.throws(() => flow.queue('status', { urgentStop: true }), /urgent_stop_conflicts_with_action/);
  assert.equal(flow.calls().length, 0);
  assert.equal(correctionOperation('status', true), 'read_status');
});

test('review 1214-5: durable corrections drain in order while stopped before explicit resume', t => {
  const flow = setup(t); const first = flow.queue(); const second = flow.queue(); const resume = flow.queue('resume');
  assert.equal(flow.deliver(resume.correction.id, flow.options('stopped')).state, 'pending');
  assert.equal(flow.deliver(second.correction.id, flow.options('stopped')).state, 'pending');
  assert.equal(flow.deliver(first.correction.id, flow.options('stopped')).state, 'succeeded');
  assert.equal(flow.deliver(second.correction.id, flow.options('stopped')).state, 'succeeded');
  assert.equal(flow.deliver(resume.correction.id, flow.options('stopped')).state, 'succeeded');
  assert.deepEqual(flow.calls().slice(0, 2).map(call => JSON.parse(call.args[1]!).corrections[0].sequence), [1, 2]);
  assert.deepEqual(flow.calls()[2]!.args, ['pilot-build', 'relaunch']);
});

function recordSuccessorEvidence(flow: ReturnType<typeof setup>, assignment: Assignment) {
  const at = new Date().toISOString(); const previous = flow.store.get(projectId, 'review-1'); assert.ok(previous?.kind === 'product_review');
  const updates = [assignment.design, assignment.plan, assignment.detailedPlanTask, assignment.feature!];
  const source = (item: typeof previous.sourceRefs[number]) => {
    const replacement = item.record && updates.find(ref => ref.id === item.record!.id);
    return replacement ? { ...item, record: replacement } : item;
  };
  const results = ['result-general', 'result-second'].map(id => {
    const result = flow.store.get(projectId, id); assert.ok(result?.kind === 'criterion_result');
    return { ...result, revision: result.revision + 1, updatedAt: at, assignment: ref(assignment) };
  });
  const review = { ...previous, revision: previous.revision + 1, updatedAt: at, feature: assignment.feature,
    design: assignment.design, plan: assignment.plan, detailedPlanTasks: [assignment.detailedPlanTask], assignments: [ref(assignment)],
    sourceRefs: previous.sourceRefs.map(source), results: results.map(ref),
    sourceComparison: { ...previous.sourceComparison, sourceRefs: previous.sourceComparison.sourceRefs.map(source) },
    instructionFidelity: { ...previous.instructionFidelity, sourceRefs: previous.instructionFidelity.sourceRefs.map(source) },
    planConformance: { ...previous.planConformance, sourceRefs: previous.planConformance.sourceRefs.map(source) } };
  commitReviewFixture(flow, [...results, review], 'review-checked-successor-evidence');
  return review;
}

test('review 1214-1 integration: regenerated brief retains the correction and checked incorporation clears completion', t => {
  const flow = setup(t); const queued = flow.queue('amended_scope', { changedOutcome: 'Deliver corrected connected-system behavior' });
  flow.deliver(queued.correction.id); const delivered = flow.observation(queued.correction.id).correction!.assignment;
  const successor = checkedScopeSuccessor(flow);
  const sources = requiredAssignmentContext(flow.store.history(projectId), successor).sources.filter(source => !source.record);
  const request = flow.store.get(projectId, 'request-1'); assert.ok(request?.kind === 'request');
  const sourceFiles = sources.map((source, index) => {
    const path = join(flow.directory, `successor-source-${index}.txt`);
    writeFileSync(path, source.uri === request.source.uri ? request.originalText : source.uri === 'fixture://source/1' ?
      queued.correction.correction!.originalText : 'Existing common connected-system interface.');
    return { source, path };
  });
  const briefPath = join(flow.directory, 'successor-brief.md');
  writeFileSync(briefPath, readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url), 'utf8'));
  const prepared = prepareWorkerBrief(flow.store, { projectId, assignmentId: successor.id, attemptId: successor.attemptId,
    expectedRevision: successor.revision, idempotencyKey: 'regenerate-corrected-brief', issuedAt: new Date().toISOString(),
    detailedPlanTask: successor.detailedPlanTask, plan: successor.plan, firstMateTaskId: successor.firstMateTaskId,
    returnLocation: successor.returnLocation, briefPath, sourceFiles });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const current = flow.assignment();
  assert.equal(current.correctionContext?.requiresReplan, false);
  assert.ok(current.correctionContext?.corrections.some(item => item.id === queued.correction.id));
  assert.ok(current.selectedContext.some(item => item.source.record?.id === queued.correction.id), 'Regenerated instructions receive the original correction');
  const check = checkWorkerBrief(flow.store, projectId, ref(current), briefPath, fakeJudge);
  assert.equal(check.ok, true, JSON.stringify(check));
  const review = recordSuccessorEvidence(flow, current);
  const producer = flow.store.get(projectId, 'mapping-1'); assert.ok(producer?.kind === 'task_mapping');
  const consumer = { ...producer, id: 'successor-consumer', firstMateTaskId: 'successor-consumer',
    management: { operationId: '', requirements: [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'consumer-task',
      reason: 'Need the incorporated corrected behavior', needs: { kind: 'criterion' as const, criterion: current.criteria[0]! } }],
      readiness: [], paused: false, managedDependencies: [], holdReason: 'Corrected prerequisite' } };
  assert.match(taskReadinessReasons(flow.store.records(projectId), consumer).join('\n'), /Product prerequisite not met/);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), ref(review)).ok, false);
  const recorded = recordCorrectionFact(flow.store, incorporationInput(flow, queued.correction.id));
  assert.deepEqual(recorded.correction!.deliveryRecipient!.assignment, delivered);
  assert.deepEqual(recorded.correction!.incorporationAssignment, ref(current));
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), ref(review)).ok, true);
  assert.deepEqual(taskReadinessReasons(flow.store.records(projectId), consumer), []);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
});

for (const invalid of ['missing-correction', 'unchecked', 'replacement'] as const) test(`review 1214-1 rejects ${invalid} successor incorporation`, t => {
  const flow = setup(t); const queued = flow.queue('amended_scope', { changedOutcome: 'Revised outcome' });
  flow.deliver(queued.correction.id); const successor = checkedScopeSuccessor(flow); const at = new Date().toISOString();
  const { correctionContext, ...withoutContext } = successor;
  const next = invalid === 'missing-correction' ? { ...withoutContext, revision: successor.revision + 1, updatedAt: at } :
    invalid === 'unchecked' ? { ...successor, revision: successor.revision + 1, updatedAt: at,
      instructionFidelity: { ...successor.instructionFidelity, result: 'untested' as const } } :
      { ...successor, revision: successor.revision + 1, updatedAt: at, attemptId: 'replacement' };
  assert.ok(correctionContext);
  commitReviewFixture(flow, [next], `invalid-successor-${invalid}`);
  assert.throws(() => recordCorrectionFact(flow.store, incorporationInput(flow, queued.correction.id)), /incorporation_requires/);
});

test('review 1214-2 rejects changed-and-reverted feature scope despite the final state matching', t => {
  const flow = setup(t); const feature = flow.store.get(projectId, 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  const at = new Date().toISOString();
  commitReviewFixture(flow, [{ ...feature, revision: 2, previousRevision: 1, updatedAt: at,
    outcome: 'A different requested outcome', changeReason: 'Explicit changed scope' }], 'temporary-scope-change');
  commitReviewFixture(flow, [{ ...feature, revision: 3, previousRevision: 2, updatedAt: at,
    state: 'in_review', changeReason: 'Return to the former outcome' }], 'reverted-scope');
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
});

test('review 1214-3 preserves the pre-call receipt when the same attempt advances during delivery', t => {
  const flow = setup(t); const queued = flow.queue(); const original = flow.assignment();
  const executable = join(flow.directory, 'advance-during-send.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import { ProjectStore, ref } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
const store = new ProjectStore(${JSON.stringify(flow.database)});
const previous = store.get('project-1', 'assignment-1');
const correction = store.get('project-1', 'correction-1');
if (JSON.stringify(correction.correction.deliveryRecipient) !== JSON.stringify({ assignment: ref(previous), attemptId: previous.attemptId, firstMateTaskId: previous.firstMateTaskId })) {
  throw new Error('Recipient was not captured durably before invoking the wrapper');
}
const at = new Date().toISOString();
const successor = { ...previous, revision: previous.revision + 1, updatedAt: at };
const decision = { kind: 'decision_change', id: 'wrapper-successor', projectId: 'project-1', schemaVersion: 1, revision: 1,
createdAt: at, updatedAt: at, questionOrChange: 'Advance the same attempt concurrently', affectedRecords: [ref(previous)],
rationale: 'Deterministic revision while fm-send runs', disposition: 'selected', sourceRefs: [{ uri: 'fixture://race' }], scopeChanges: [] };
store.mutate({ schemaVersion: 1, id: decision.id, projectId: 'project-1', issuedAt: at, idempotencyKey: decision.id,
command: 'record_decision_suggestion', targetId: previous.id, expectedRevision: previous.revision, payload: { decision } }, () => [decision, successor]);
store.close(); process.stdout.write('accepted');
`); chmodSync(executable, 0o755);
  const options = flow.options(); options.sendExecutable = executable;
  assert.equal(flow.deliver(queued.correction.id, options).state, 'succeeded');
  const correction = flow.observation(queued.correction.id).correction!;
  assert.equal(flow.assignment().revision, original.revision + 1);
  assert.deepEqual(correction.assignment, ref(original));
  assert.deepEqual(correction.deliveryRecipient, { assignment: ref(original), attemptId: original.attemptId, firstMateTaskId: original.firstMateTaskId });
  assert.ok(correction.facts.some(item => item.fact === 'delivered'));
});

function replacementAssignment(flow: ReturnType<typeof setup>) {
  const at = new Date(Date.now() + 1).toISOString();
  const replacement = { ...flow.assignment(), id: 'review-1245-replacement', attemptId: 'replacement-attempt',
    revision: 1, createdAt: at, updatedAt: at };
  commitReviewFixture(flow, [replacement], 'review-1245-replace');
  return replacement;
}

test('review 1245-4: replacement dispatch requires outstanding task corrections in its context', t => {
  const flow = setup(t); flow.queue(); const replacement = replacementAssignment(flow);
  const result = validateAssignmentForDispatch(flow.store.history(projectId), ref(replacement));
  assert.equal(result.ok, false, 'An unchanged mapping does not excuse missing outstanding task corrections');
});

test('review 1245-4: replacement results cannot bypass outstanding task corrections at completion or readiness', t => {
  const flow = setup(t); flow.queue(); const replacement = replacementAssignment(flow);
  const review = recordSuccessorEvidence(flow, replacement);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), ref(review)).ok, false);
  const producer = flow.store.get(projectId, 'mapping-1'); assert.ok(producer?.kind === 'task_mapping');
  const consumer = { ...producer, id: 'replacement-consumer', firstMateTaskId: 'replacement-consumer', management: {
    operationId: '', requirements: [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'consumer-task', reason: 'Need corrected output',
      needs: { kind: 'criterion' as const, criterion: replacement.criteria[0]! } }],
    readiness: [], paused: false, managedDependencies: [], holdReason: 'Corrected prerequisite' } };
  assert.match(taskReadinessReasons(flow.store.records(projectId), consumer).join('\n'), /Product prerequisite not met/);
});

function prepareReplacement(flow: ReturnType<typeof setup>, assignmentId = 'prepared-replacement', expectedRevision = 0, attemptId = 'replacement-attempt') {
  const assignment = flow.assignment(); const request = flow.store.get(projectId, 'request-1'); assert.ok(request?.kind === 'request');
  const sources = requiredAssignmentContext(flow.store.history(projectId), assignment).sources.filter(source => !source.record);
  const sourceFiles = sources.map((source, index) => {
    const path = join(flow.directory, `replacement-source-${index}.txt`);
    writeFileSync(path, source.uri === request.source.uri ? request.originalText : 'Existing common connected-system interface.');
    return { source, path };
  });
  const briefPath = join(flow.directory, `${assignmentId}-brief.md`);
  writeFileSync(briefPath, readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url), 'utf8'));
  const input = { projectId, assignmentId, attemptId,
    expectedRevision, idempotencyKey: `prepare-${assignmentId}-${expectedRevision}`, issuedAt: new Date(Date.now() + 2).toISOString(),
    detailedPlanTask: assignment.detailedPlanTask, plan: assignment.plan, firstMateTaskId: assignment.firstMateTaskId,
    returnLocation: assignment.returnLocation, briefPath, sourceFiles };
  const prepared = prepareWorkerBrief(flow.store, input);
  const replacement = flow.store.get(projectId, prepared.assignment.id); assert.ok(replacement?.kind === 'assignment');
  return { prepared, replacement, briefPath, input };
}

test('review 1245-4: replacement briefs preserve the outstanding correction from the previous assignment', t => {
  const flow = setup(t); const source = flow.queue();
  const { replacement } = prepareReplacement(flow);
  assert.ok(replacement.selectedContext.some(item => item.source.record?.id === source.correction.id));
});

function queuedCancellation(flow: ReturnType<typeof setup>, urgentStop: boolean) {
  const fake = fakeTaskWrapper(flow.directory, false, flow.database);
  fake.edit(state => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'in_flight' }); });
  const command = flow.command('cancellation', { urgentStop, taskCommand: {
    schemaVersion: 1, id: 'ordered-cancel', projectId, issuedAt: new Date().toISOString(), idempotencyKey: 'ordered-cancel',
    command: 'map_manage_execution_task', targetId: 'mapping-1', expectedRevision: 1,
    payload: { task: { kind: 'existing', firstMateTaskId: 'pilot-build' }, action: 'cancel', feature: { id: 'feature-1', revision: 1 },
      criteria: flow.assignment().criteria, detailedPlanTask: flow.assignment().detailedPlanTask, dependencies: [], reason: 'Explicit cancellation' } } });
  const correction = queueCorrection(flow.store, command);
  const options = flow.options(); options.taskAdapter = { fmHome: flow.directory, tasksExecutable: fake.executable,
    controlExecutable: options.controlExecutable, snapshotExecutable: options.snapshotExecutable! };
  return { fake, correction, options, command };
}

test('review 1245-6: ordinary task cancellation waits for earlier steering before calling BUILD-08', t => {
  const flow = setup(t); const earlier = flow.queue(); const cancel = queuedCancellation(flow, false);
  assert.equal(flow.deliver(cancel.correction.correction.id, cancel.options).state, 'pending');
  assert.equal(cancel.fake.read().calls.length, 0); assert.equal(flow.calls().length, 0);
  assert.equal(flow.deliver(earlier.correction.id).state, 'succeeded');
  assert.equal(flow.deliver(cancel.correction.correction.id, cancel.options).state, 'succeeded');
  assert.deepEqual(flow.calls()[1]!.args, ['pilot-build', 'exit']);
});

test('review 1245-7: competing fresh runtime-task bindings make the recipient unresolved', t => {
  const flow = setup(t); const correction = flow.queue(); const options = flow.options();
  options.recipients.push({ ...options.recipients[0]!, assignment: { id: 'competing-assignment', revision: 1 }, attemptId: 'competing-attempt' });
  assert.equal(flow.deliver(correction.correction.id, options).state, 'pending');
  assert.equal(flow.calls().length, 0);
});

test('review 1245-9: consolidated payload labels active and superseded amendments explicitly', t => {
  const flow = setup(t); const ids = [1, 2, 3].map(n => flow.queue('amended_scope', {
    changedOutcome: `Outcome ${n}`, compatibilityKey: 'same-outcome-edit' }).correction.id);
  assert.equal(flow.deliver(ids[2]!).state, 'succeeded');
  const delivered = JSON.parse(flow.calls()[0]!.args[1]!).corrections;
  assert.deepEqual(delivered.map((item: { active: boolean }) => item.active), [false, false, true]);
  assert.deepEqual(delivered[0].supersededBy, { id: ids[1], revision: 1 });
  assert.deepEqual(delivered[1].supersededBy, { id: ids[2], revision: 1 });
  assert.deepEqual(delivered[2].supersedes.map((item: { id: string }) => item.id), [ids[1]]);
  assert.equal(delivered[2].supersededBy, null);
});

for (const deliveredBeforeReplacement of [false, true]) test(`review 1245-4: replacement explicitly re-addresses and incorporates a ${deliveredBeforeReplacement ? 'previously delivered' : 'pending'} correction`, t => {
  const flow = setup(t); const source = flow.queue();
  if (deliveredBeforeReplacement) { flow.deliver(source.correction.id); flow.fact(source.correction.id, 'acknowledged'); }
  const original = structuredClone(flow.observation(source.correction.id));
  const { prepared, replacement, briefPath } = prepareReplacement(flow);
  assert.equal(prepared.unresolvedCorrections.length, 1);
  assert.equal(correctionCount(flow), 1);
  assert.equal(checkWorkerBrief(flow.store, projectId, ref(replacement), briefPath, fakeJudge).ok, false);
  assert.equal(correctionDeliveryStatus(flow.store, projectId, source.correction.id).state, 'unresolved');
  assert.throws(() => recordCorrectionFact(flow.store, incorporationInput(flow, source.correction.id, replacement)), /delivered|incorporation_requires/);
  queueCorrection(flow.store, readdressInput(flow, source.correction.id, replacement));
  assert.equal(checkWorkerBrief(flow.store, projectId, ref(replacement), briefPath, fakeJudge).ok, false, 'Addressing alone does not confirm delivery');
  assert.equal(flow.deliver(source.correction.id, replacementOptions(flow, replacement)).state, 'succeeded');
  assert.equal(checkWorkerBrief(flow.store, projectId, ref(replacement), briefPath, fakeJudge).ok, true);
  const receipt = flow.observation(source.correction.id).correction!.deliveryRecipient!;
  assert.deepEqual(receipt.assignment, ref(replacement));
  const review = recordSuccessorEvidence(flow, replacement);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), ref(review)).ok, false);
  recordCorrectionFact(flow.store, incorporationInput(flow, source.correction.id, replacement));
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), ref(review)).ok, true);
  assert.deepEqual(flow.store.get(projectId, original.id, original.revision), original);
  assert.deepEqual(flow.observation(source.correction.id).correction!.deliveryHistory![0]!.facts, original.correction!.facts);
  const producer = flow.store.get(projectId, 'mapping-1'); assert.ok(producer?.kind === 'task_mapping');
  const consumer = { ...producer, id: 'replacement-consumer', firstMateTaskId: 'replacement-consumer', management: {
    operationId: '', requirements: [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'consumer-task', reason: 'Need corrected output',
      needs: { kind: 'criterion' as const, criterion: replacement.criteria[0]! } }],
    readiness: [], paused: false, managedDependencies: [], holdReason: 'Corrected prerequisite' } };
  assert.deepEqual(taskReadinessReasons(flow.store.records(projectId), consumer), []);
});

test('review 1245-4: same-ID replacement drains re-addressed steering without an ordering cycle', t => {
  const flow = setup(t); const source = flow.queue(); const previous = flow.assignment();
  const { prepared, replacement } = prepareReplacement(flow, previous.id, previous.revision);
  assert.equal(prepared.unresolvedCorrections.length, 1);
  queueCorrection(flow.store, readdressInput(flow, source.correction.id, replacement));
  const options = flow.options('stopped');
  assert.equal(flow.deliver(source.correction.id, options).state, 'succeeded');
  const next = flow.queue('clarification', { sequence: 2 });
  assert.equal(flow.deliver(next.correction.id, options).state, 'succeeded');
  assert.deepEqual(flow.calls().map(call => JSON.parse(call.args[1]!).attemptId), [replacement.attemptId, replacement.attemptId]);
  assert.equal(correctionCount(flow), 2);
});

test('review 1245-6: urgent cancellation bypasses earlier pending steering', t => {
  const flow = setup(t); flow.queue(); const cancel = queuedCancellation(flow, true);
  assert.equal(flow.deliver(cancel.correction.correction.id, cancel.options).state, 'succeeded');
  assert.deepEqual(flow.calls()[0]!.args, ['pilot-build', 'exit']);
});

for (const conflict of ['unknown-state', 'different-state', 'same-assignment-different-attempt'] as const) test(`review 1245-7: fresh ${conflict} observation prevents delivery`, t => {
  const flow = setup(t); const correction = flow.queue(); const options = flow.options();
  options.recipients.push({ ...options.recipients[0]!, ...(conflict === 'same-assignment-different-attempt' ?
    { attemptId: 'other-attempt' } : { state: conflict === 'unknown-state' ? 'unknown' as const : 'stopped' as const }) });
  assert.equal(flow.deliver(correction.correction.id, options).state, 'pending');
  assert.equal(flow.calls().length, 0);
});

test('review 1245-7: a stale competing observation does not defeat a unique fresh recipient', t => {
  const flow = setup(t); const correction = flow.queue(); const options = flow.options();
  options.recipients.push({ ...options.recipients[0]!, assignment: { id: 'old-assignment', revision: 1 }, attemptId: 'old-attempt',
    observedAt: '2020-01-01T00:00:00Z' });
  assert.equal(flow.deliver(correction.correction.id, options).state, 'succeeded');
  assert.equal(flow.calls().length, 1);
});

test('review 1245-4: explicit re-addressing preserves source sequence rather than lexical ID order', t => {
  const flow = setup(t); const sources = Array.from({ length: 12 }, () => flow.queue());
  const { prepared, replacement } = prepareReplacement(flow);
  assert.equal(prepared.unresolvedCorrections.length, sources.length);
  assert.equal(correctionCount(flow), sources.length);
  const options = replacementOptions(flow, replacement);
  for (const source of sources) queueCorrection(flow.store, readdressInput(flow, source.correction.id, replacement));
  assert.equal(flow.deliver(sources.at(-1)!.correction.id, options).state, 'pending');
  for (const source of sources) assert.equal(flow.deliver(source.correction.id, options).state, 'succeeded');
  assert.deepEqual(flow.calls().map(call => JSON.parse(call.args[1]!).corrections[0].originalText),
    sources.map(source => source.correction.correction!.originalText));
});

function readdressInput(flow: ReturnType<typeof setup>, id: string, replacement: Assignment) {
  const source = flow.observation(id); const correction = source.correction!;
  return { schemaVersion: 1, id: `address-${id}-${replacement.id}-${replacement.attemptId}-${replacement.revision}`, projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: `address-${id}-${replacement.id}-${replacement.attemptId}-${replacement.revision}`, command: 'deliver_correction', targetId: id, expectedRevision: source.revision,
    payload: { readdress: true, affectedRevision: correction.affectedRevision, assignment: ref(replacement),
      originalCorrection: correction.originalText, action: correction.action, sequence: correction.sequence,
      supersedes: correction.supersedes, sourceRefs: correction.sourceRefs, urgentStop: correction.urgentStop,
      compatibilityKey: correction.compatibilityKey } };
}
const correctionCount = (flow: ReturnType<typeof setup>) => flow.store.records(projectId)
  .filter(record => record.kind === 'observation' && record.correction).length;
function replacementOptions(flow: ReturnType<typeof setup>, replacement: Assignment): CorrectionAdapterOptions {
  return { ...flow.options('stopped'), recipients: [{ assignment: ref(replacement), attemptId: replacement.attemptId,
    firstMateTaskId: replacement.firstMateTaskId, state: 'stopped', observedAt: new Date().toISOString() }] };
}

test('review 1270: same-ID replacement keeps several pending corrections on their original records and preserves delivery order', t => {
  const flow = setup(t); const sources = [flow.queue(), flow.queue(), flow.queue()]; const previous = flow.assignment();
  const { replacement, prepared } = prepareReplacement(flow, previous.id, previous.revision);
  assert.equal(correctionCount(flow), 3, 'Replacement preparation must not create correction copies');
  assert.equal(validateAssignmentForDispatch(flow.store.history(projectId), ref(replacement)).ok, false);
  const unresolved = (prepared as unknown as { unresolvedCorrections: { earlier: { attemptId: string }; replacement: { attemptId: string } }[] }).unresolvedCorrections;
  assert.equal(unresolved.length, 3);
  assert.ok(unresolved.every(item => item.earlier.attemptId === previous.attemptId && item.replacement.attemptId === replacement.attemptId));
  const options = replacementOptions(flow, replacement);
  for (const source of sources) {
    const intent = queueCorrection(flow.store, readdressInput(flow, source.correction.id, replacement));
    assert.equal(intent.correction.id, source.correction.id);
    assert.equal(flow.deliver(source.correction.id, options).state, 'succeeded');
  }
  assert.equal(correctionCount(flow), 3);
  assert.deepEqual(flow.calls().map(call => JSON.parse(call.args[1]!).corrections[0].sequence), [1, 2, 3]);
  assert.ok(flow.calls().every(call => JSON.parse(call.args[1]!).attemptId === replacement.attemptId));
});

test('review 1270: two successive replacements still require only one delivery per logical correction', t => {
  const flow = setup(t); const sources = [flow.queue(), flow.queue()];
  prepareReplacement(flow, 'replacement-one');
  const { replacement } = prepareReplacement(flow, 'replacement-two');
  assert.equal(correctionCount(flow), 2);
  const options = replacementOptions(flow, replacement);
  for (const source of sources) {
    queueCorrection(flow.store, readdressInput(flow, source.correction.id, replacement));
    assert.equal(flow.deliver(source.correction.id, options).state, 'succeeded');
    recordCorrectionFact(flow.store, incorporationInput(flow, source.correction.id, replacement));
  }
  assert.equal(flow.calls().length, 2);
  assert.equal(correctionCount(flow), 2);
  const review = recordSuccessorEvidence(flow, replacement);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), ref(review)).ok, true);
});

test('review 1270: replacement preparation replay repairs files from the receipt without recomputing changed correction context', t => {
  const flow = setup(t); flow.queue(); const { prepared, replacement, input, briefPath } = prepareReplacement(flow);
  const sidecarPath = replacement.brief!.sidecarPath;
  const brief = readFileSync(briefPath, 'utf8'); const sidecar = readFileSync(sidecarPath, 'utf8');
  const sequence = Math.max(0, ...flow.store.records(projectId).filter(record => record.kind === 'observation' && record.correction?.assignment.id === replacement.id)
    .map(record => record.kind === 'observation' ? record.correction!.sequence : 0)) + 1;
  queueCorrection(flow.store, { schemaVersion: 1, id: 'later-source', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'later-source', command: 'deliver_correction', targetId: 'later-source', expectedRevision: 0,
    payload: { affectedRevision: replacement.feature!, assignment: ref(replacement), originalCorrection: 'A later correction after preparation',
      action: 'clarification', sequence, supersedes: [], sourceRefs: [{ uri: 'fixture://later-source' }] } });
  const count = correctionCount(flow);
  writeFileSync(briefPath, 'damaged output'); rmSync(sidecarPath);
  assert.deepEqual(prepareWorkerBrief(flow.store, input), prepared);
  assert.equal(readFileSync(briefPath, 'utf8'), brief);
  assert.equal(readFileSync(sidecarPath, 'utf8'), sidecar);
  assert.equal(correctionCount(flow), count);
  assert.deepEqual(prepareWorkerBrief(flow.store, input), prepared);
});

test('review 1270: repeated re-addressing names the most recent earlier attempt and archives each receipt on the same record', t => {
  const flow = setup(t); const source = flow.queue(); const first = prepareReplacement(flow, 'replacement-one', 0, 'first-replacement');
  const firstIntent = readdressInput(flow, source.correction.id, first.replacement);
  queueCorrection(flow.store, firstIntent);
  assert.equal(flow.deliver(source.correction.id, replacementOptions(flow, first.replacement)).state, 'succeeded');
  const firstReceipt = structuredClone(flow.observation(source.correction.id));
  const second = prepareReplacement(flow, 'replacement-two', 0, 'second-replacement');
  const unresolved = correctionDeliveryStatus(flow.store, projectId, source.correction.id);
  assert.equal(unresolved.state, 'unresolved');
  assert.equal(unresolved.earlier!.attemptId, first.replacement.attemptId);
  assert.equal(unresolved.replacement!.attemptId, second.replacement.attemptId);
  const secondIntent = readdressInput(flow, source.correction.id, second.replacement);
  const addressed = queueCorrection(flow.store, secondIntent);
  assert.deepEqual(queueCorrection(flow.store, secondIntent), addressed, 'Re-addressing replay uses the existing command receipt');
  const historical = flow.observation(source.correction.id).correction!.deliveryHistory!;
  assert.equal(historical.length, 2);
  assert.deepEqual(historical[1]!.facts, firstReceipt.correction!.facts);
  assert.deepEqual(historical[1]!.deliveryRecipient, firstReceipt.correction!.deliveryRecipient);
  assert.equal(flow.deliver(source.correction.id, replacementOptions(flow, second.replacement)).state, 'succeeded');
  recordCorrectionFact(flow.store, incorporationInput(flow, source.correction.id, second.replacement));
  assert.equal(correctionCount(flow), 1);
  assert.equal(flow.calls().length, 2);
  assert.deepEqual(flow.store.get(projectId, firstReceipt.id, firstReceipt.revision), firstReceipt);
});

test('review 1270: explicit re-addressing cannot change a correction source, action, scope or order', t => {
  const flow = setup(t); const source = flow.queue(); const { replacement } = prepareReplacement(flow);
  const input = readdressInput(flow, source.correction.id, replacement); const count = flow.store.history(projectId).length;
  for (const patch of [{ originalCorrection: 'A rewritten request' }, { sequence: 99 }, { action: 'resume' },
    { affectedRevision: { id: 'request-1', revision: 1 } }, { sourceRefs: [{ uri: 'fixture://rewritten-source' }] }]) {
    assert.throws(() => queueCorrection(flow.store, { ...input, payload: { ...input.payload, ...patch } }), /preserve_pending_correction/);
    assert.equal(flow.store.history(projectId).length, count);
  }
  const next = queueCorrection(flow.store, input).correction;
  assert.equal(next.id, source.correction.id);
  assert.equal(next.correction!.originalText, source.correction.correction!.originalText);
  assert.equal(next.correction!.sequence, source.correction.correction!.sequence);
  assert.deepEqual(next.correction!.sourceRefs, source.correction.correction!.sourceRefs);
  assert.throws(() => assertRevisionTransition(next, { ...next, revision: next.revision + 1,
    correction: { ...next.correction, deliveryHistory: [] } }), /correction_history_mutation/);
});

test('review 1270: CLI exposes unresolved recipients and re-addresses the same correction through the existing queue and delivery path', t => {
  const flow = setup(t); const source = flow.queue(); const { replacement } = prepareReplacement(flow);
  const inputPath = join(flow.directory, 'readdress-input.json'); const optionsPath = join(flow.directory, 'readdress-adapter.json');
  const cli = (args: string[]) => spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname,
    ...args, '--db', flow.database], { encoding: 'utf8' });
  const status = () => {
    const result = cli(['correction-status', '--project', projectId, '--correction', source.correction.id]);
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.equal(status().state, 'unresolved');
  assert.equal(status().earlier.attemptId, 'attempt-1');
  assert.equal(status().replacement.attemptId, replacement.attemptId);
  writeFileSync(inputPath, JSON.stringify(readdressInput(flow, source.correction.id, replacement)));
  const queued = cli(['queue-correction', '--input', inputPath]); assert.equal(queued.status, 0, queued.stderr);
  assert.equal(JSON.parse(queued.stdout).correction.id, source.correction.id);
  assert.equal(status().state, 'unresolved');
  writeFileSync(optionsPath, JSON.stringify(replacementOptions(flow, replacement)));
  const delivered = cli(['deliver-correction', '--project', projectId, '--correction', source.correction.id, '--adapter-config', optionsPath]);
  assert.equal(delivered.status, 0, delivered.stderr);
  assert.equal(status().state, 'delivered');
  assert.equal(correctionCount(flow), 1);
  assert.equal(flow.calls().length, 1);
});

function queueForAttempt(flow: ReturnType<typeof setup>, assignment: Assignment, action: CorrectionAction, id: string, extra: Record<string, unknown> = {}) {
  const sequence = Math.max(0, ...flow.store.records(projectId).filter(record => record.kind === 'observation' && record.correction?.assignment.id === assignment.id)
    .map(record => record.kind === 'observation' ? record.correction!.sequence : 0)) + 1;
  return queueCorrection(flow.store, { schemaVersion: 1, id, projectId, issuedAt: new Date().toISOString(), idempotencyKey: id,
    command: 'deliver_correction', targetId: id, expectedRevision: 0, payload: {
      affectedRevision: ref(flow.store.get(projectId, assignment.feature!.id)!), assignment: ref(assignment), action,
      originalCorrection: `Original source ${id}`, sequence, supersedes: [], sourceRefs: [{ uri: `fixture://${id}` }], ...extra,
    } });
}
function assignmentById(flow: ReturnType<typeof setup>, id: string) {
  const record = flow.store.get(projectId, id); assert.ok(record?.kind === 'assignment'); return record;
}
function pendingNewWork(flow: ReturnType<typeof setup>) {
  const fake = fakeTaskWrapper(flow.directory, false, flow.database);
  const command = flow.command('new_work', { taskCommand: {
    schemaVersion: 1, id: 'review-new-work-task', projectId, issuedAt: new Date().toISOString(), idempotencyKey: 'review-new-work-task',
    command: 'map_manage_execution_task', targetId: 'review-new-work-mapping', expectedRevision: 0,
    payload: { task: { kind: 'new', firstMateTaskId: 'followup', title: 'Planned followup', repo: 'sample' }, action: 'create',
      feature: { id: 'feature-1', revision: 1 }, criteria: flow.assignment().criteria, detailedPlanTask: flow.assignment().detailedPlanTask,
      dependencies: [], readiness: [{ id: 'hold-for-check', reason: 'Check before execution', evidence: [] }], reason: 'Explicit new work' } } });
  const correction = queueCorrection(flow.store, command);
  const options = flow.options(); options.taskAdapter = { fmHome: flow.directory, tasksExecutable: fake.executable, guardTaskId: 'permanent-guard' };
  return { fake, command, correction, options };
}

test('review 1277-2: a consolidated amendment retains original supersession lineage when re-addressed to another assignment', t => {
  const flow = setup(t); const first = flow.queue('amended_scope', { changedOutcome: 'First amended outcome', compatibilityKey: 'outcome' });
  const second = flow.queue('amended_scope', { changedOutcome: 'Final amended outcome', compatibilityKey: 'outcome' });
  checkedScopeSuccessor(flow);
  const { replacement } = prepareReplacement(flow);
  const links = structuredClone(flow.observation(second.correction.id).correction!.supersedes);
  const addressed = queueCorrection(flow.store, readdressInput(flow, second.correction.id, replacement));
  assert.deepEqual(addressed.correction.correction!.supersedes, links);
  assert.equal(flow.deliver(second.correction.id, replacementOptions(flow, replacement)).state, 'succeeded');
  const payload = JSON.parse(flow.calls()[0]!.args[1]!);
  assert.deepEqual(payload.corrections.map((item: { id: string }) => item.id), [first.correction.id, second.correction.id]);
  assert.deepEqual(payload.corrections.map((item: { active: boolean }) => item.active), [false, true]);
});

for (const action of ['resume', 'status', 'new_work'] as const) test(`review 1277-3: delivered ${action} is complete across replacement without incorporation`, t => {
  const flow = setup(t);
  const source = action === 'new_work' ? pendingNewWork(flow) : { correction: flow.queue(action), options: flow.options(action === 'resume' ? 'stopped' : 'active') };
  if (action === 'status') {
    const executable = join(flow.directory, 'completed-status');
    writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write("state: active\\n");\n'); chmodSync(executable, 0o755);
    source.options.stateExecutable = executable;
  }
  assert.equal(flow.deliver(source.correction.correction.id, source.options).state, 'succeeded');
  const { replacement } = prepareReplacement(flow);
  const next = queueForAttempt(flow, replacement, 'clarification', `after-completed-${action}`);
  assert.equal(flow.deliver(next.correction.id, replacementOptions(flow, replacement)).state, 'succeeded');
  const original = flow.observation(source.correction.correction.id);
  assert.equal(original.correction!.facts.some(item => item.fact === 'incorporated'), false);
  assert.equal(correctionDeliveryStatus(flow.store, projectId, original.id).state, 'delivered');
});

for (const action of ['cancellation', 'new_work'] as const) test(`review 1277-4: re-addressed ${action} requires its task command before committing`, t => {
  const flow = setup(t); const source = action === 'cancellation' ? queuedCancellation(flow, false) : pendingNewWork(flow);
  const { replacement } = prepareReplacement(flow); const input = readdressInput(flow, source.correction.correction.id, replacement);
  const before = flow.store.history(projectId);
  assert.throws(() => queueCorrection(flow.store, input), /matching_BUILD08_task_command/);
  assert.deepEqual(flow.store.history(projectId), before);
  assert.equal(flow.store.receipt(projectId, input.idempotencyKey), undefined);
  const complete = { ...input, payload: { ...input.payload, taskCommand: (source.command.payload as unknown as { taskCommand: unknown }).taskCommand } };
  const intent = queueCorrection(flow.store, complete);
  const options = { ...replacementOptions(flow, replacement), taskAdapter: source.options.taskAdapter! };
  assert.equal(flow.deliver(intent.correction.id, options).state, 'succeeded');
  assert.equal(correctionCount(flow), 1);
});

function firstPendingAmendment(flow: ReturnType<typeof setup>) {
  const clarified = flow.queue(); flow.deliver(clarified.correction.id); flow.fact(clarified.correction.id, 'incorporated');
  const amendment = flow.queue('amended_scope', { changedOutcome: 'First requested amendment', compatibilityKey: 'outcome' });
  checkedScopeSuccessor(flow);
  return amendment;
}

test('review 1277-6: a newer clarification is a consolidation barrier even when its local sequence is smaller', t => {
  const flow = setup(t); const original = firstPendingAmendment(flow); const { replacement } = prepareReplacement(flow);
  const clarification = queueForAttempt(flow, replacement, 'clarification', 'newer-clarification');
  queueCorrection(flow.store, readdressInput(flow, original.correction.id, replacement));
  const last = queueForAttempt(flow, replacement, 'amended_scope', 'after-clarification-amendment', {
    changedOutcome: 'Newest requested amendment', compatibilityKey: 'outcome' });
  assert.equal(flow.observation(original.correction.id).correction!.supersededBy, undefined);
  assert.deepEqual(last.correction.correction!.supersedes, []);
  const current = assignmentById(flow, replacement.id); const options = replacementOptions(flow, current);
  assert.equal(flow.deliver(original.correction.id, options).state, 'succeeded');
  assert.equal(flow.deliver(clarification.correction.id, options).state, 'succeeded');
  assert.equal(flow.deliver(last.correction.id, options).state, 'succeeded');
});

test('review 1277-6: consolidated payloads follow canonical task order while retaining original local sequence values', t => {
  const flow = setup(t); const first = firstPendingAmendment(flow);
  const secondAttempt = prepareReplacement(flow, 'second-amendment-author', 0, 'second-author').replacement;
  const second = queueForAttempt(flow, secondAttempt, 'amended_scope', 'second-author-amendment', {
    changedOutcome: 'Second requested amendment', compatibilityKey: 'outcome' });
  checkedScopeSuccessor(flow, 'second-checked-plan');
  const replacement = prepareReplacement(flow, 'final-amendment-author', 0, 'final-author').replacement;
  queueCorrection(flow.store, readdressInput(flow, first.correction.id, replacement));
  queueCorrection(flow.store, readdressInput(flow, second.correction.id, replacement));
  const last = queueForAttempt(flow, replacement, 'amended_scope', 'final-consolidated-amendment', {
    changedOutcome: 'Final requested amendment', compatibilityKey: 'outcome' });
  const current = assignmentById(flow, replacement.id);
  assert.equal(flow.deliver(last.correction.id, replacementOptions(flow, current)).state, 'succeeded');
  const payload = JSON.parse(flow.calls().at(-1)!.args[1]!);
  assert.deepEqual(payload.corrections.map((item: { id: string }) => item.id), [first.correction.id, second.correction.id, last.correction.id]);
  assert.deepEqual(payload.corrections.map((item: { sequence: number }) => item.sequence), [2, 1, 3]);
});
