import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { applyCommand, manageExecutionTask, taskReadinessReasons, projectView, ref,
  captureLearning, consolidateLearning, learningContext, activeGuidance, validateRecords, readFleetSnapshot, importLegacyTasks,
  type CaptureLearningInput } from '../../src/index.js';
import { fakeJudge } from '../judge-helper.js';
import { fakeTask } from '../task-wrapper-helper.js';
import { setup, projectId, at, cases, taskCommand } from './helper.js';

test('CHECK-07 — native done without required product output keeps dependent work blocked', t => {
  const flow = setup(t, 'CHECK-07', records => {
    const plan = records.find(r => r.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
    const task = records.find(r => r.kind === 'detailed_plan_task'); assert.ok(task?.kind === 'detailed_plan_task');
    const consumer = { ...task, id: 'consumer-task' };
    plan.deliverySequence.push(ref(consumer));
    plan.dependencies.push({ prerequisiteTaskId: task.id, consumerTaskId: consumer.id,
      reason: 'Second-system acceptance needs the verified common interface output',
      needs: { kind: 'artifact', artifact: { uri: 'fixture:common-interface-output', revision: 'required-revision' } } });
    records.push(consumer);
  }, false);
  flow.tasks.edit(s => { s.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done' }); });
  const command = taskCommand('consumer'); command.payload.detailedPlanTask = { id: 'consumer-task', revision: 1 };
  const result = manageExecutionTask(flow.store, command, flow.adapter);
  assert.equal(result.operation.state, 'succeeded', result.operation.reconciliation?.note);
  assert.equal(flow.tasks.read().tasks.consumer?.held, true);
  const reasons = taskReadinessReasons(flow.store.records(projectId), result.mapping);
  assert.ok(reasons.some(r => /Product prerequisite not met.*verified common interface output/.test(r)), JSON.stringify(reasons));
  assert.ok(JSON.parse(result.operation.reconciliation!.note).unresolved.some((reason: string) => reason.includes('verified common interface output')), 'The operation exposes the exact missing output; native hold text is an ownership marker');
});

test('CHECK-09 — stale and omitted observations remain uncertain in the UI', async t => {
  const flow = setup(t, 'CHECK-09', undefined, false);
  const result = manageExecutionTask(flow.store, taskCommand(), flow.adapter);
  assert.equal(result.operation.state, 'succeeded');
  const view = projectView(flow.store, { projectId }, Date.now() + 120_000);
  const task = view.features[0]!.tasks.find(r => r.mapping.firstMateTaskId === 'release-task');
  assert.ok(task?.stale); assert.match(task.label, /^Stale/);
  assert.ok(view.features[0]!.criteria.every(c => c.label.includes('Missing evidence')));
  assert.match(view.features[0]!.completeness, /^Incomplete/);
  const fleet = readFleetSnapshot(flow.runtimeAdapter);
  fleet.backlog.records.push({ id: null, structured: false, raw: 'Unstructured current work has no trustworthy task identity' });
  fleet.main_inventory = { valid: false, reason: 'unstructured current row', orphan_in_flight: [], unstructured_current_count: 1 };
  const snapshot = flow.executable('incomplete-fleet.cjs', `process.stdout.write(${JSON.stringify(JSON.stringify(fleet))});`);
  const imported = importLegacyTasks(flow.store, projectId, { ...flow.runtimeAdapter, snapshotExecutable: snapshot });
  assert.equal(imported.omissions.length, 1);
  const http = await flow.http();
  const overview = await http('GET', '/projects/project-1/overview'); assert.equal(overview.status, 200);
  const data = JSON.parse(overview.text);
  assert.match(data.features[0].tasks[0].label, /Unknown/);
  assert.equal(JSON.parse(data.project.integration.observation).snapshot.main_inventory.unstructured_current_count, 1);
  assert.equal(data.features[0].requests[0].record.originalText, cases['CHECK-09']!.originalRequest);
  const work = await http('GET', '/projects/project-1/work');
  await t.test('CHECK-09 unresolved — fleet omission presentation', { todo: 'BUILD-13 Work view absent; see docs/release-checks.md' }, () => {
    assert.equal(work.status, 200, 'No Work view to disclose fleet omissions');
  });
});

test('CHECK-10 — local correction acts immediately while conflicting general lessons remain explicit', t => {
  const flow = setup(t, 'CHECK-10');
  const feature = flow.store.get(projectId, 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  const evidence = [{ artifact: { uri: 'fixture:retrospective', revision: 'supplied' }, description: 'Original correction transcript', observedAt: at }];
  const observation = (id: string, finding: string): CaptureLearningInput => ({ projectId, id, idempotencyKey: id, issuedAt: at,
    identity: { scope: { kind: 'project' }, topic: 'retry' }, finding, proposedGeneralization: finding,
    evidence, inputKind: 'inferred', captureReason: 'stow' });
  captureLearning(flow.store, { ...observation('local-correction', 'Keep ERPNext as an example; preserve every connected system.'),
    inputKind: 'local_correction', captureReason: 'correction', identity: { scope: { kind: 'feature', featureId: feature.id }, topic: 'scope' },
    feature: { ...feature, revision: 2, previousRevision: 1, updatedAt: at, changeReason: 'Keep ERPNext as an example; preserve every connected system.',
      outcome: cases['CHECK-10']!.originalRequest } });
  assert.equal(flow.store.get(projectId, feature.id)?.revision, 2);
  assert.equal(flow.assignment().revision, 2); assert.equal(flow.assignment().instructionFidelity.result, 'blocked');
  assert.ok(flow.assignment().instructionText.includes('Keep ERPNext as an example'));
  captureLearning(flow.store, observation('always-retry', 'Always retry.'));
  captureLearning(flow.store, observation('never-retry', 'Never retry.'));
  const module = new URL('../../../fixtures/fake-learning-agent.mjs', import.meta.url);
  const calls = join(flow.directory, 'learning-calls.jsonl');
  const agent = flow.executable('learning.mjs', `process.env.SF_FAKE_LEARNING_OPTIONS=${JSON.stringify(JSON.stringify({ outcome: 'conflict', record: calls }))};await import(${JSON.stringify(module.href)});`);
  const config = { ...structuredClone(fakeJudge), executables: { codex: agent, claude: agent } };
  consolidateLearning(flow.store, { projectId, id: 'consolidation', idempotencyKey: 'consolidation', issuedAt: at,
    scheduledWindowId: 'daily', scheduledFor: at, scheduleDigest: 'daily-v1', timezone: 'Asia/Jerusalem' }, config);
  assert.equal(activeGuidance(flow.store.history(projectId)).filter(g => g.learning).length, 0);
  const conflicts = learningContext(flow.store.history(projectId)).conflicts;
  assert.ok(conflicts.some(c => c.id === 'always-retry')); assert.ok(conflicts.some(c => c.id === 'never-retry'));
  assert.notEqual(JSON.parse(readFileSync(calls, 'utf8')).pid, process.pid);
});

test('CHECK-11 — UI and agent writes share canonical records and task operations', async t => {
  const flow = setup(t, 'CHECK-11'); const http = await flow.http();
  const original = flow.store.get(projectId, 'request-1');
  const create = taskCommand(); const created = await http('POST', '/canonical', create);
  assert.equal(created.status, 200, created.text);
  const mapping = flow.store.get(projectId, create.targetId)!;
  const priority = { ...create, id: 'ui-priority', idempotencyKey: 'ui-priority', issuedAt: new Date().toISOString(), expectedRevision: mapping.revision,
    payload: { ...create.payload, action: 'set_priority', task: { kind: 'existing', firstMateTaskId: 'release-task' }, priority: 0 } };
  const ui = await http('POST', '/canonical', priority); assert.equal(ui.status, 200, ui.text);
  const afterUi = flow.store.exportProject(projectId); const count = flow.tasks.read().calls.length;
  assert.deepEqual(applyCommand(flow.store, priority, flow.adapter), JSON.parse(ui.text));
  assert.deepEqual(flow.store.exportProject(projectId), afterUi); assert.equal(flow.tasks.read().calls.length, count);
  assert.equal(flow.tasks.read().tasks['release-task']?.priority, 0);
  const agent = { ...priority, id: 'agent-priority', idempotencyKey: 'agent-priority', issuedAt: new Date().toISOString(),
    expectedRevision: flow.store.get(projectId, create.targetId)!.revision, payload: { ...priority.payload, priority: 3 } };
  applyCommand(flow.store, agent, flow.adapter);
  assert.equal(flow.tasks.read().tasks['release-task']?.priority, 3);
  const view = JSON.parse((await http('GET', '/projects/project-1/overview')).text);
  assert.equal(view.features[0].tasks.find((r: { mapping: { id: string } }) => r.mapping.id === create.targetId).priority, 3);
  assert.deepEqual(flow.store.get(projectId, 'request-1'), original);
  const decisions = await http('GET', '/projects/project-1/decisions');
  await t.test('CHECK-11 unresolved — Decisions view', { todo: 'BUILD-14 Decisions view absent; see docs/release-checks.md' }, () => {
    assert.equal(decisions.status, 200, 'No Decisions view for canonical decision edits');
  });
});

test('CHECK-14 — wrong fixture cannot support a checked count', async t => {
  const flow = setup(t, 'CHECK-14');
  const claim = { kind: 'measurement_claim', id: 'wrong-count', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
    claim: 'There are 99 supported systems.', definition: 'Count distinct supported system IDs', unit: 'systems', population: 'production fixture', filters: [],
    inputs: [{ uri: 'fixture:production-systems', revision: 'production-v1' }], computationRef: { uri: 'fixture:count-system-ids' },
    observedAt: at, state: 'checked', evidence: [{ artifact: { uri: 'fixture:unrelated-demo', revision: 'demo-v9' },
      description: 'Wrong demonstration fixture; never ran the declared production count', observedAt: at }] };
  const validation = validateRecords([...flow.store.history(projectId), claim]);
  await t.test('CHECK-14 unresolved — checked count with mismatched inputs', { todo: 'Wrong input evidence accepted; see docs/release-checks.md' }, () => {
    assert.equal(validation.ok, false, 'Wrong fixture/method must withhold checked status without guessing another number');
  });
});
