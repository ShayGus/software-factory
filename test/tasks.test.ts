import { fakeRuntime } from './runtime-helper.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  ProjectStore, RecordsSchema, MapManageExecutionTaskCommandSchema, queueManagedTask, manageExecutionTask,
  reconcileManagedTask, taskReadinessReasons, ref, validateAssignmentForDispatch, parseFirstMateTaskDetail,
  FirstMateTaskMutationSchema, importLegacyTasks, type FactoryRecord, type TaskMapping, type TaskAdapterOptions,
} from '../src/index.js';
import { fakeTask, fakeTaskWrapper, type FakeState } from './task-wrapper-helper.js';

const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const projectId = 'project-1';
type TaskCommand = ReturnType<typeof MapManageExecutionTaskCommandSchema.parse>;
function setup(t: TestContext, atomic = false, editRecords?: (records: FactoryRecord[]) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-tasks-'));
  const database = join(directory, 'store.sqlite');
  const store = new ProjectStore(database);
  const records = structuredClone(baseline.filter((record) => ['project', 'request', 'feature_revision', 'criterion',
    'design_revision', 'implementation_plan_revision', 'detailed_plan_task'].includes(record.kind)));
  editRecords?.(records);
  store.importProject({ schemaVersion: 1, projectId, history: records, receipts: [] });
  const fake = fakeTaskWrapper(directory, atomic, database);
  const runtime = fakeRuntime(directory, ['managed-task']);
  const options: TaskAdapterOptions = { snapshotExecutable: runtime.executable, fmHome: directory, tasksExecutable: fake.executable, guardTaskId: 'permanent-guard' };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const command = (payload: Partial<TaskCommand['payload']> = {}, mappingId = 'mapping-managed'): TaskCommand => {
    const previous = store.get(projectId, mappingId);
    const task = records.find((record) => record.kind === 'detailed_plan_task')!;
    return MapManageExecutionTaskCommandSchema.parse({ schemaVersion: 1, id: `command-${++sequence}`, projectId,
      issuedAt: new Date().toISOString(), idempotencyKey: `key-${sequence}`, command: 'map_manage_execution_task',
      targetId: mappingId, expectedRevision: previous?.revision ?? 0,
      payload: { feature: { id: 'feature-1', revision: 1 }, criteria: task.kind === 'detailed_plan_task' ? task.criteria : [],
        detailedPlanTask: ref(task), task: { kind: 'new', firstMateTaskId: 'managed-task', title: 'Common integration', repo: 'sample' },
        action: 'create', dependencies: [], reason: 'Deliver the requested common behavior', ...payload } });
  };
  const existing = (patch: Partial<TaskCommand['payload']> = {}) => command({ task: { kind: 'existing', firstMateTaskId: 'managed-task' }, action: 'map', ...patch });
  const mapping = (): TaskMapping => { const value = store.get(projectId, 'mapping-managed'); assert.equal(value?.kind, 'task_mapping'); return value as TaskMapping; };
  const manage = (input: TaskCommand) => manageExecutionTask(store, input, options);
  const succeeded = (input: TaskCommand) => { const result = manage(input); assert.equal(result.operation.state, 'succeeded', result.operation.reconciliation?.note); return result; };
  return { directory, database, store, records, fake, options, command, existing, mapping, manage, succeeded };
}
const pendingCondition = [{ id: 'integration-review', reason: 'Verified integration criterion required', evidence: [] }];
const evidence = [{ artifact: { uri: 'fixture://acceptance', revision: 'run-1' }, description: 'Condition confirmed', observedAt: '2026-11-11T19:00:00Z' }];
function assertNeverReady(state: FakeState, id = 'managed-task') {
  const trace = state.trace.filter((event) => event.task.id === id);
  assert.ok(trace.length > 0);
  assert.ok(trace.every((event) => !event.ready.includes(id)), JSON.stringify(trace));
  assert.ok(trace.every((event) => event.mappingSaved), 'Mapping must be committed before each external mutation');
}

for (const atomic of [false, true]) test(`create and hold is never runnable (${atomic ? 'atomic add' : 'permanent guard'})`, (t) => {
  const flow = setup(t, atomic);
  flow.succeeded(flow.command({ readiness: pendingCondition }));
  const state = flow.fake.read();
  assertNeverReady(state);
  assert.equal(state.tasks['managed-task']!.held, true);
  assert.deepEqual(state.tasks['managed-task']!.deps, []);
  assert.equal(state.calls.filter((call) => call.args[0] === 'add' && call.args[1] !== '--help').length, 1);
  assert.equal(state.calls.some((call) => call.args.includes('--hold-reason')), atomic);
  assert.equal(state.calls.some((call) => call.args[0] === 'unblock'), !atomic);
  flow.succeeded(flow.existing({ readiness: [{ ...pendingCondition[0]!, evidence }] }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false);
});

test('a mapped prerequisite blocks dispatch until native completion; missing IDs remain held', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command({ dependencies: ['prerequisite'] }));
  assertNeverReady(flow.fake.read());
  assert.match(flow.store.operations(projectId).at(-1)!.reconciliation!.note, /Missing prerequisite/);
  flow.fake.edit((state) => { state.tasks.prerequisite = fakeTask('prerequisite'); });
  flow.succeeded(flow.existing({ dependencies: ['prerequisite'] }));
  assertNeverReady(flow.fake.read());
  let task = flow.fake.read().tasks['managed-task']!;
  assert.equal(task.held, false); assert.equal(task.blocked, true);
  flow.fake.edit((state) => { state.tasks.prerequisite!.state = 'done'; });
  flow.succeeded(flow.existing({ dependencies: ['prerequisite'] }));
  task = flow.fake.read().tasks['managed-task']!;
  assert.equal(task.held, false); assert.equal(task.blocked, false);
});

test('a local cycle fails atomically before changing the backlog', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command({ dependencies: ['second-task'] }));
  const before = flow.fake.read().calls.length;
  const second = flow.command({ task: { kind: 'new', firstMateTaskId: 'second-task', title: 'Second task', repo: 'sample' },
    dependencies: ['managed-task'] }, 'second-mapping');
  assert.throws(() => flow.manage(second), /cycle/);
  assert.equal(flow.fake.read().calls.length, before);
  assert.equal(flow.store.get(projectId, 'second-mapping'), undefined);
});

test('a cycle through unmanaged native tasks is refused before creation', (t) => {
  const flow = setup(t);
  flow.fake.edit((state) => { state.tasks.native = fakeTask('native', { deps: [{ type: 'blocked-by', id: 'managed-task' }] }); });
  const result = flow.manage(flow.command({ dependencies: ['native'] }));
  assert.equal(result.operation.state, 'failed');
  assert.match(result.operation.reconciliation!.note, /cycle/);
  assert.equal(flow.fake.read().tasks['managed-task'], undefined);
});

for (const when of ['after', 'timeout', 'wrong-receipt'] as const) test(`ambiguous add reconciles by stable ID without duplicate (${when})`, (t) => {
  const flow = setup(t);
  flow.options.timeoutMs = 600;
  flow.fake.edit((state) => { state.failure = { action: 'add', when }; });
  const input = flow.command({ readiness: pendingCondition });
  const first = flow.manage(input);
  assert.equal(first.operation.state, 'unknown');
  assert.ok(flow.fake.read().tasks['managed-task']);
  assertNeverReady(flow.fake.read());
  // A new connection proves reconciliation uses persisted intent, not process memory.
  const reopened = new ProjectStore(flow.database);
  try {
    const result = reconcileManagedTask(reopened, projectId, first.operation.id, flow.options);
    assert.equal(result.state, 'succeeded', result.reconciliation?.note);
  } finally { reopened.close(); }
  assertNeverReady(flow.fake.read());
  assert.equal(flow.fake.read().calls.filter((call) => call.args[0] === 'add' && call.args[1] !== '--help').length, 1);
  const calls = flow.fake.read().calls.length;
  flow.succeeded(input);
  assert.equal(flow.fake.read().calls.length, calls, 'Successful replay does no new mutation');
  assert.throws(() => flow.manage({ ...input, payload: { ...input.payload, reason: 'Different intent' } }), /idempotency/);
});

for (const action of ['hold', 'unblock', 'unhold', 'update', 'block'] as const) test(`lost ${action} output is observed before retry`, (t) => {
  const flow = setup(t);
  let input: TaskCommand;
  if (['hold', 'unblock'].includes(action)) input = flow.command({ readiness: pendingCondition });
  else {
    flow.succeeded(flow.command({ readiness: pendingCondition }));
    if (action === 'unhold') input = flow.existing({ readiness: [] });
    else if (action === 'update') input = flow.existing({ action: 'set_priority', priority: 4 });
    else {
      flow.fake.edit((state) => { state.tasks.prerequisite = fakeTask('prerequisite'); });
      input = flow.existing({ action: 'edit_dependencies', dependencies: ['prerequisite'] });
    }
  }
  flow.fake.edit((state) => { state.failure = { action, when: 'after' }; });
  const first = flow.manage(input);
  assert.equal(first.operation.state, 'unknown');
  const before = flow.fake.read().calls.length;
  const result = reconcileManagedTask(flow.store, projectId, first.operation.id, flow.options);
  assert.equal(result.state, 'succeeded', result.reconciliation?.note);
  const retry = flow.fake.read().calls.slice(before);
  assert.deepEqual(retry[0]!.args, ['show', 'managed-task', '--full']);
  assert.equal(retry.filter((call) => call.args[0] === action).length, 0, 'Already-applied mutation is not repeated');
});

test('a malformed read never proves absence or causes an add', (t) => {
  const flow = setup(t);
  flow.fake.edit((state) => { state.failure = { action: 'show', when: 'bad-read' }; });
  const result = flow.manage(flow.command());
  assert.equal(result.operation.state, 'unknown');
  assert.equal(flow.fake.read().calls.some((call) => call.args[0] === 'add'), false);
  assert.throws(() => flow.manage(flow.existing()), /reconcile_previous/);
});

test('an existing stable ID belonging to someone else is never adopted as a new task', (t) => {
  const flow = setup(t);
  flow.fake.edit((state) => { state.tasks['managed-task'] = fakeTask('managed-task', { body: 'Someone else owns this' }); });
  const result = flow.manage(flow.command());
  assert.equal(result.operation.state, 'failed');
  assert.match(result.operation.reconciliation!.note, /stable_task_id_collision/);
  assert.equal(flow.fake.read().trace.length, 0);
});

test('priority, update, pause, resume and dependency changes use existing mutations', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  flow.succeeded(flow.existing({ action: 'pause' }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, true);
  flow.succeeded(flow.existing({ action: 'set_priority', priority: 0 }));
  assert.equal(flow.fake.read().tasks['managed-task']!.priority, 0);
  assert.equal(flow.fake.read().tasks['managed-task']!.held, true, 'Priority does not resume a paused task');
  flow.succeeded(flow.existing({ action: 'update', update: { title: 'New "quoted" title', body: 'First line\nSecond line', repo: 'other', kind: 'docs' } }));
  assert.equal(flow.fake.read().tasks['managed-task']!.body, 'First line\nSecond line');
  flow.fake.edit((state) => { state.tasks.first = fakeTask('first'); state.tasks.second = fakeTask('second'); state.tasks.foreign = fakeTask('foreign');
    state.tasks['managed-task']!.deps.push({ type: 'blocked-by', id: 'foreign' }); });
  flow.succeeded(flow.existing({ action: 'edit_dependencies', dependencies: ['first'] }));
  flow.succeeded(flow.existing({ action: 'edit_dependencies', dependencies: ['second'] }));
  assert.deepEqual(flow.fake.read().tasks['managed-task']!.deps.map((dep) => dep.id).sort(), ['foreign', 'second']);
  flow.succeeded(flow.existing({ action: 'resume', dependencies: ['second'] }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false);
  assert.ok(flow.fake.read().calls.every((call) => !['start', 'done', 'reopen'].includes(call.args[0]!)));
});

test('a foreign hold is retained when toolkit product readiness clears', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command({ readiness: pendingCondition }));
  flow.fake.edit((state) => { state.tasks['managed-task']!.hold = { reason: 'Operator decision', kind: 'captain', until: null }; });
  flow.succeeded(flow.existing({ readiness: [] }));
  assert.equal(flow.fake.read().tasks['managed-task']!.hold!.reason, 'Operator decision');
});

test('an expiring foreign hold has an independent permanent blocker for toolkit conditions', (t) => {
  const flow = setup(t);
  flow.fake.edit((state) => { state.tasks['managed-task'] = fakeTask('managed-task', {
    hold: { reason: 'Independent dated condition', kind: 'future', until: '2026-11-12' }, held: true,
  }); });
  flow.succeeded(flow.existing({ readiness: pendingCondition }));
  let task = flow.fake.read().tasks['managed-task']!;
  assert.equal(task.deps[0]!.id, 'permanent-guard');
  assert.equal(task.hold!.reason, 'Independent dated condition');
  assertNeverReady(flow.fake.read());
  flow.succeeded(flow.existing({ readiness: [] }));
  task = flow.fake.read().tasks['managed-task']!;
  assert.deepEqual(task.deps, []); assert.equal(task.hold!.until, '2026-11-12');
});

test('queued cancellation keeps dependents blocked and never marks the prerequisite done', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  flow.succeeded(flow.command({ task: { kind: 'new', firstMateTaskId: 'consumer', title: 'Consumer', repo: 'sample' },
    dependencies: ['managed-task'] }, 'consumer-mapping'));
  flow.succeeded(flow.existing({ action: 'cancel', reason: 'Scope withdrawn' }));
  const task = flow.fake.read().tasks['managed-task']!;
  assert.equal(task.state, 'queued'); assert.equal(task.held, true);
  assert.equal(flow.mapping().disposition.state, 'cancelled');
  const consumer = flow.store.get(projectId, 'consumer-mapping'); assert.equal(consumer?.kind, 'task_mapping');
  if (consumer?.kind !== 'task_mapping') assert.fail();
  assert.match(taskReadinessReasons(flow.store.records(projectId), consumer).join('\n'), /Cancelled prerequisite/);
  assert.equal(flow.fake.read().tasks.consumer!.blocked, true);
  assert.throws(() => flow.manage(flow.existing({ action: 'resume' })), /explicit_replanning/);
  assert.equal(flow.fake.read().calls.some((call) => call.args[0] === 'done'), false);
});

test('active cancellation invokes the configured idempotent exit wrapper and retains the hold', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  flow.fake.edit((state) => { state.tasks['managed-task']!.state = 'in_flight'; });
  const control = join(flow.directory, 'fm-control-fake.cjs');
  writeFileSync(control, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(flow.directory, 'exit.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(control, 0o755); flow.options.controlExecutable = control;
  flow.succeeded(flow.existing({ action: 'cancel' }));
  assert.deepEqual(JSON.parse(readFileSync(join(flow.directory, 'exit.json'), 'utf8')), ['managed-task', 'exit']);
  assert.equal(flow.fake.read().tasks['managed-task']!.held, true);
  assert.equal(flow.fake.read().tasks['managed-task']!.state, 'in_flight', 'Cancellation never fabricates a done transition');
});

test('adapter strips inherited addressing overrides and refuses relative configured paths', (t) => {
  const flow = setup(t);
  const oldFM = process.env.FM_DATA_OVERRIDE; const oldTasks = process.env.TASKS_AXI_FILE;
  process.env.FM_DATA_OVERRIDE = '/wrong/home'; process.env.TASKS_AXI_FILE = '/wrong/backlog';
  try { flow.succeeded(flow.command()); }
  finally {
    if (oldFM === undefined) delete process.env.FM_DATA_OVERRIDE; else process.env.FM_DATA_OVERRIDE = oldFM;
    if (oldTasks === undefined) delete process.env.TASKS_AXI_FILE; else process.env.TASKS_AXI_FILE = oldTasks;
  }
  assert.ok(flow.fake.read().calls.every((call) => call.fmHome === flow.directory && !call.inheritedOverride));
  const intent = queueManagedTask(flow.store, flow.existing());
  assert.throws(() => reconcileManagedTask(flow.store, projectId, intent.operation.id, { ...flow.options, tasksExecutable: './wrapper' }), /absolute/);
});

test('legacy fallback refuses absent, done or expiring guards before creating managed work', (t) => {
  const flow = setup(t);
  flow.fake.edit((state) => { state.tasks['permanent-guard']!.state = 'done'; });
  const first = flow.manage(flow.command());
  assert.equal(first.operation.state, 'failed');
  assert.equal(flow.fake.read().tasks['managed-task'], undefined);
  assert.match(first.operation.reconciliation!.note, /guard_must_be_permanently/);
});

test('installed TOON detail and JSON mutation contracts reject partial or mismatched shapes', () => {
  const raw = 'task:\n  id: task\n  title: "a, quoted title"\n  state: queued\n  blocked: yes\n  blocked_by: dependency\n  held: yes\n  hold_reason: waiting\n  hold_kind: external\n  hold_until: "-"\n  kind: ship\n  repo: sample\n  priority: 2\n  created: 2026-11-11\n  closed: "-"\n  deps: "blocked-by:dependency"\n  links: none\n  body: "line one\\nline two"\nhelp[1]:\n  - ignored\n';
  const task = parseFirstMateTaskDetail(raw);
  assert.equal(task.body, 'line one\nline two'); assert.equal(task.priority, 2);
  assert.equal(parseFirstMateTaskDetail(raw.replace('hold_reason: waiting', 'hold_reason: "-"')).hold!.reason, '-');
  assert.throws(() => parseFirstMateTaskDetail(raw.replace('  held: yes\n', '')));
  assert.equal(FirstMateTaskMutationSchema.safeParse({ ok: true, action: 'update', task, changed: ['title'], already: true }).success, true);
  assert.equal(FirstMateTaskMutationSchema.safeParse({ ok: true, action: 'cancel', task }).success, false);
});

test('dispatch gate refuses a mapped task with pending intent or unresolved product condition', (t) => {
  const flow = setup(t, false, (records) => {
    records.push(...structuredClone(baseline.filter((record) => ['task_mapping', 'assignment'].includes(record.kind))));
  });
  const input = flow.command({ task: { kind: 'existing', firstMateTaskId: 'pilot-build' }, action: 'map', readiness: pendingCondition }, 'mapping-1');
  const intent = queueManagedTask(flow.store, input);
  const result = validateAssignmentForDispatch(flow.store.history(projectId), { id: 'assignment-1', revision: 1 });
  assert.equal(intent.operation.state, 'pending');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === 'task_mutation_unconfirmed'));
    assert.ok(result.issues.some((issue) => issue.code === 'task_not_ready'));
  }
});

function productPrerequisiteRecords(records: FactoryRecord[], need: 'artifact' | 'criterion', passing: boolean, mapped = true) {
  const task = records.find((record) => record.kind === 'detailed_plan_task')!;
  const plan = records.find((record) => record.kind === 'implementation_plan_revision');
  assert.equal(plan?.kind, 'implementation_plan_revision');
  if (plan?.kind !== 'implementation_plan_revision') assert.fail();
  const consumer = { ...structuredClone(task), id: 'consumer-task' };
  records.push(consumer); plan.deliverySequence.push(ref(consumer));
  const results = structuredClone(baseline.filter((record) => record.kind === 'criterion_result'));
  const result = results[0]!;
  assert.equal(result.kind, 'criterion_result');
  if (result.kind !== 'criterion_result' || !result.artifact || !result.criterion) assert.fail();
  if (!passing) for (const entry of results) if (entry.kind === 'criterion_result') entry.result = 'failed';
  plan.dependencies = [{ prerequisiteTaskId: mapped ? task.id : 'unknown-detailed-task', consumerTaskId: consumer.id,
    reason: 'Reuse the specific common-interface output', needs: need === 'artifact' ? { kind: 'artifact', artifact: result.artifact } :
      { kind: 'criterion', criterion: result.criterion } }];
  if (!mapped) {
    // Missing detailed IDs are supported on runtime requirements; planning's
    // closed delivery sequence correctly rejects them inside a plan.
    plan.dependencies = [];
  }
  records.push(...structuredClone(baseline.filter((record) => ['task_mapping', 'assignment'].includes(record.kind))), ...results);
  return { consumer, result };
}

for (const need of ['artifact', 'criterion'] as const) test(`plan dependencies resolve a particular producer and distinguish ${need} readiness`, (t) => {
  const flow = setup(t, false, (records) => { productPrerequisiteRecords(records, need, false); });
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done', closed: '2026-11-11' }); });
  const result = flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  const mapping = result.mapping;
  assert.equal(mapping.management!.requirements[0]!.prerequisiteTaskId, 'task-1');
  assert.equal(mapping.management!.requirements[0]!.needs.kind, need);
  assert.equal(flow.fake.read().tasks['managed-task']!.deps[0]!.id, 'pilot-build');
  assert.equal(flow.fake.read().tasks['managed-task']!.held, need === 'criterion', 'Availability does not require passing the criterion');
  if (need === 'criterion') assertNeverReady(flow.fake.read());
});

test('a passing criterion with current producer evidence clears the product hold', (t) => {
  const flow = setup(t, false, (records) => { productPrerequisiteRecords(records, 'criterion', true); });
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done', closed: '2026-11-11' }); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false);
});

test('a newer producer attempt prevents an old passing result from clearing readiness', (t) => {
  const flow = setup(t, false, (records) => {
    productPrerequisiteRecords(records, 'criterion', true);
    const assignment = records.find((record) => record.kind === 'assignment')!;
    records.push({ ...structuredClone(assignment), id: 'assignment-new-attempt',
      createdAt: '2026-11-11T18:00:00Z', updatedAt: '2026-11-11T18:00:00Z' });
  });
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done', closed: '2026-11-11' }); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assertNeverReady(flow.fake.read());
});

test('cycles made only from mapped product requirements fail before mutation', (t) => {
  const flow = setup(t, false, (records) => {
    const task = records.find((record) => record.kind === 'detailed_plan_task')!;
    const consumer = { ...structuredClone(task), id: 'consumer-task' }; records.push(consumer);
    const plan = records.find((record) => record.kind === 'implementation_plan_revision');
    if (plan?.kind !== 'implementation_plan_revision') assert.fail();
    plan.deliverySequence.push(ref(consumer));
  });
  flow.succeeded(flow.command({ requirements: [{ prerequisiteTaskId: 'consumer-task', consumerTaskId: 'task-1', reason: 'Requires consumer output',
    needs: { kind: 'criterion', criterion: { id: 'criterion-general', revision: 1 } } }] }));
  const before = flow.fake.read().calls.length;
  const second = flow.command({ task: { kind: 'new', firstMateTaskId: 'second-task', title: 'Second', repo: 'sample' },
    detailedPlanTask: { id: 'consumer-task', revision: 1 }, requirements: [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'consumer-task',
      reason: 'Requires first task output', needs: { kind: 'criterion', criterion: { id: 'criterion-general', revision: 1 } } }] }, 'second-mapping');
  assert.throws(() => flow.manage(second), /cycle/);
  assert.equal(flow.fake.read().calls.length, before);
});

test('an unmapped product prerequisite stays unresolved instead of broadening to its feature', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command({ requirements: [{ prerequisiteTaskId: 'not-mapped', consumerTaskId: 'task-1', reason: 'Need this output only',
    needs: { kind: 'criterion', criterion: { id: 'criterion-general', revision: 1 } } }] }));
  assertNeverReady(flow.fake.read());
  assert.match(taskReadinessReasons(flow.store.records(projectId), flow.mapping()).join('\n'), /Unresolved prerequisite not-mapped/);
});

test('a cancelled product prerequisite remains unresolved even with an old passing result and native done observation', (t) => {
  const flow = setup(t, false, (records) => { productPrerequisiteRecords(records, 'criterion', true); });
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done', closed: '2026-11-11' }); });
  const cancel = flow.command({ task: { kind: 'existing', firstMateTaskId: 'pilot-build' }, action: 'cancel' }, 'mapping-1');
  flow.succeeded(cancel);
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assertNeverReady(flow.fake.read());
  assert.match(taskReadinessReasons(flow.store.records(projectId), flow.mapping()).join('\n'), /Unresolved prerequisite task-1/);
});

test('task creation refuses draft plans and scope omitted from the managed mapping', (t) => {
  const flow = setup(t);
  assert.throws(() => flow.manage(flow.command({ detailedPlanTask: null })), /ready_detailed_plan/);
  assert.throws(() => flow.manage(flow.command({ criteria: [] })), /preserve_plan_scope/);
  assert.equal(flow.fake.read().calls.length, 0);
});

test('CLI queues, reconciles and manages through the configured fake wrapper', (t) => {
  const flow = setup(t);
  const inputPath = join(flow.directory, 'command.json');
  const configPath = join(flow.directory, 'adapter.json');
  writeFileSync(inputPath, JSON.stringify(flow.command({ readiness: pendingCondition })));
  writeFileSync(configPath, JSON.stringify(flow.options));
  const cli = (args: string[]) => spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname,
    ...args, '--db', flow.database], { encoding: 'utf8' });
  const queued = cli(['queue-task', '--input', inputPath]);
  assert.equal(queued.status, 0, queued.stderr);
  const intent = JSON.parse(queued.stdout);
  assert.equal(intent.operation.state, 'pending');
  assert.equal(flow.fake.read().calls.length, 0);
  const reconciled = cli(['reconcile-task', '--project', projectId, '--operation', intent.operation.id, '--adapter-config', configPath]);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.equal(JSON.parse(reconciled.stdout).state, 'succeeded');
  assertNeverReady(flow.fake.read());
  writeFileSync(inputPath, JSON.stringify(flow.existing({ readiness: [] })));
  const managed = cli(['manage-task', '--input', inputPath, '--adapter-config', configPath]);
  assert.equal(managed.status, 0, managed.stderr);
  assert.equal(JSON.parse(managed.stdout).operation.state, 'succeeded');
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false);
});

function reviseRecord(flow: ReturnType<typeof setup>, id: string, change: (record: FactoryRecord) => void) {
  const previous = flow.store.get(projectId, id); assert.ok(previous);
  const next = structuredClone(previous); change(next);
  next.revision++; next.updatedAt = new Date().toISOString();
  const tasks: FactoryRecord[] = [];
  if (next.kind === 'implementation_plan_revision') {
    next.deliverySequence = next.deliverySequence.map((entry) => {
      const task = flow.store.get(projectId, entry.id, entry.revision); assert.ok(task?.kind === 'detailed_plan_task');
      const revised = { ...task, revision: task.revision + 1, updatedAt: next.updatedAt, plan: ref(next) };
      tasks.push(revised); return ref(revised);
    });
  }
  const key = `test-revision-${id}-${next.revision}`;
  const decision = { kind: 'decision_change', id: key, projectId, schemaVersion: 1, revision: 1,
    createdAt: next.updatedAt, updatedAt: next.updatedAt, questionOrChange: 'Explicit test replan or new attempt',
    affectedRecords: [ref(previous)], rationale: 'Exercise current canonical records', disposition: 'selected',
    sourceRefs: [{ uri: 'fixture://revision' }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: key, projectId, issuedAt: next.updatedAt, idempotencyKey: key,
    command: 'record_decision_suggestion', targetId: id, expectedRevision: previous.revision, payload: { decision } },
  () => [decision, next, ...tasks]);
}

async function until(predicate: () => boolean, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('Timed out waiting for test rendezvous'); await delay(10); }
}
function childResult(child: ChildProcess) {
  let stderr = ''; child.stderr?.on('data', (data) => { stderr += String(data); });
  return new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('exit', (code) => resolve({ code, stderr })));
}

test('review 1: overlapping reconciliation cannot clear a later pause across processes', async (t) => {
  const flow = setup(t);
  flow.options.timeoutMs = 25000;
  flow.succeeded(flow.command({ readiness: pendingCondition }));
  const intent = queueManagedTask(flow.store, flow.existing({ readiness: [] }));
  const pause = flow.existing({ action: 'pause' });
  const inputPath = join(flow.directory, 'concurrent-input.json');
  writeFileSync(inputPath, JSON.stringify({ operationId: intent.operation.id, options: flow.options, pause }));
  writeFileSync(join(flow.directory, 'gate-action'), 'unhold');
  const moduleUrl = new URL('../src/index.js', import.meta.url).href;
  const common = `import { ProjectStore, reconcileManagedTask, manageExecutionTask } from ${JSON.stringify(moduleUrl)};
    import { readFileSync, writeFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, 'utf8'));
    const store = new ProjectStore(${JSON.stringify(flow.database)});
    const reconcile = () => reconcileManagedTask(store, 'project-1', input.operationId, input.options);`;
  const first = spawn(process.execPath, ['--input-type=module', '-e', common + `try { reconcile(); } finally { store.close(); }`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const firstDone = childResult(first);
  t.after(() => first.kill());
  await until(() => existsSync(join(flow.directory, 'gate-entered')));
  const second = spawn(process.execPath, ['--input-type=module', '-e', common + `
    writeFileSync(${JSON.stringify(join(flow.directory, 'second-started'))}, 'started');
    try {
      reconcile();
      input.pause.expectedRevision = store.get('project-1', input.pause.targetId).revision;
      input.pause.issuedAt = new Date().toISOString();
      const result = manageExecutionTask(store, input.pause, input.options);
      if (result.operation.state !== 'succeeded') throw new Error(JSON.stringify(result));
      writeFileSync(${JSON.stringify(join(flow.directory, 'second-finished'))}, 'finished');
    } finally { store.close(); }`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const secondDone = childResult(second);
  t.after(() => second.kill());
  try {
    await until(() => existsSync(join(flow.directory, 'second-started')));
    // Without serialization the second process finishes the same intent and
    // pauses while the first is still just before its stale unhold.
    const deadline = Date.now() + 1200;
    while (!existsSync(join(flow.directory, 'second-finished')) && Date.now() < deadline) await delay(10);
  } finally { writeFileSync(join(flow.directory, 'gate-release'), 'release'); }
  const [one, two] = await Promise.all([firstDone, secondDone]);
  assert.equal(flow.fake.read().tasks['managed-task']!.held, true, 'Later pause must survive stale reconciliation');
  assert.equal(one.code, 0, one.stderr); assert.equal(two.code, 0, two.stderr);
});

test('review 2: cancelling a completed prerequisite protects existing consumers through cleanup', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  flow.fake.edit((state) => { state.tasks['managed-task']!.state = 'done'; });
  flow.succeeded(flow.command({ task: { kind: 'new', firstMateTaskId: 'consumer', title: 'Consumer', repo: 'sample' },
    dependencies: ['managed-task'] }, 'consumer-mapping'));
  flow.fake.edit((state) => { state.tasks.consumer!.state = 'done'; });
  flow.succeeded(flow.command({ task: { kind: 'new', firstMateTaskId: 'downstream', title: 'Downstream', repo: 'sample' },
    dependencies: ['consumer'] }, 'downstream-mapping'));
  assert.equal(flow.fake.read().tasks.downstream!.held, false);
  flow.succeeded(flow.existing({ action: 'cancel' }));
  assert.equal(flow.fake.read().tasks.consumer!.hold?.reason.startsWith('Software Factory '), true);
  assert.equal(flow.fake.read().tasks.downstream!.held, true);
  const downstream = flow.store.get(projectId, 'downstream-mapping'); assert.equal(downstream?.kind, 'task_mapping');
  if (downstream?.kind !== 'task_mapping') assert.fail();
  assert.match(taskReadinessReasons(flow.store.records(projectId), downstream).join('\n'), /Cancelled prerequisite managed-task/);
});

test('review 3: a revised older assignment is the current attempt and needs exact-revision evidence', (t) => {
  const flow = setup(t, false, (records) => {
    productPrerequisiteRecords(records, 'criterion', true);
    const assignment = records.find((record) => record.kind === 'assignment')!;
    const newer = { ...structuredClone(assignment), id: 'assignment-newer-id', createdAt: '2026-11-11T18:00:00Z', updatedAt: '2026-11-11T18:00:00Z' };
    records.push(newer);
    const result = records.find((record) => record.kind === 'criterion_result');
    if (result?.kind !== 'criterion_result') assert.fail();
    records.push({ ...structuredClone(result), id: 'result-newer-id', assignment: ref(newer) });
  });
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done' }); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false);
  reviseRecord(flow, 'assignment-1', (record) => { if (record.kind === 'assignment') record.attemptId = 'revised-current-attempt'; });
  flow.succeeded(flow.existing({ detailedPlanTask: ref(flow.store.get(projectId, 'consumer-task')!) }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, true, 'Neither old revision nor superseded assignment ID can supply evidence');
  const resultId = flow.store.records(projectId).find((record) => record.kind === 'criterion_result')!.id;
  reviseRecord(flow, resultId, (record) => {
    if (record.kind !== 'criterion_result') assert.fail();
    record.assignment = ref(flow.store.get(projectId, 'assignment-1')!);
  });
  flow.succeeded(flow.existing({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false, 'Evidence for the exact current assignment revision clears readiness');
});

for (const replace of [false, true]) test(`review 5: current plan alone supplies ${replace ? 'replaced' : 'removed'} plan requirements`, (t) => {
  const flow = setup(t, false, (records) => { productPrerequisiteRecords(records, 'criterion', false); });
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done' }); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 },
    requirements: [{ prerequisiteTaskId: 'explicit-extra', consumerTaskId: 'consumer-task', reason: 'Keep this explicit additional requirement',
      needs: { kind: 'criterion', criterion: { id: 'criterion-general', revision: 1 } } }] }));
  reviseRecord(flow, 'plan-1', (record) => {
    if (record.kind !== 'implementation_plan_revision') assert.fail();
    record.dependencies = replace ? [{ ...record.dependencies[0]!, needs: { kind: 'criterion', criterion: { id: 'criterion-second-system', revision: 1 } } }] : [];
  });
  flow.succeeded(flow.existing({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  const requirements = flow.mapping().management!.requirements;
  if (replace) assert.equal(requirements.some((edge) => edge.prerequisiteTaskId === 'task-1' && edge.needs.kind === 'criterion' && edge.needs.criterion.id === 'criterion-general'), false);
  assert.equal(requirements.some((edge) => edge.prerequisiteTaskId === 'explicit-extra'), true);
  assert.equal(requirements.filter((edge) => edge.prerequisiteTaskId === 'task-1').length, replace ? 1 : 0);
});

test('review 6: installed dependency ownership survives producer ambiguity until explicit removal', (t) => {
  const flow = setup(t, false, (records) => { productPrerequisiteRecords(records, 'criterion', true); });
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build'); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assert.deepEqual(flow.mapping().management!.managedDependencies, ['pilot-build'], 'Persist successful installed IDs');
  const producer = flow.store.get(projectId, 'mapping-1'); assert.ok(producer?.kind === 'task_mapping');
  const other = { ...structuredClone(producer), id: 'ambiguous-producer', firstMateTaskId: 'another-producer' };
  const key = 'introduce-ambiguous-producer';
  const decision = { kind: 'decision_change', id: key, projectId, schemaVersion: 1, revision: 1,
    createdAt: other.createdAt, updatedAt: other.updatedAt, questionOrChange: 'Introduce ambiguity', affectedRecords: [ref(producer)],
    rationale: 'Exact installed dependency ownership must survive changed resolution', disposition: 'selected', sourceRefs: [{ uri: 'fixture://ambiguity' }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: key, projectId, issuedAt: other.updatedAt, idempotencyKey: key,
    command: 'record_decision_suggestion', targetId: other.id, expectedRevision: 0, payload: { decision } }, () => [decision, other]);
  reviseRecord(flow, 'plan-1', (record) => { if (record.kind === 'implementation_plan_revision') record.dependencies = []; });
  flow.succeeded(flow.existing({ detailedPlanTask: ref(flow.store.get(projectId, 'consumer-task')!), requirements: [] }));
  assert.deepEqual(flow.fake.read().tasks['managed-task']!.deps, []);
  assert.deepEqual(flow.mapping().management!.managedDependencies, []);
});

test('review 7: a definitive native cycle rejection accepts a corrected new intent', (t) => {
  const flow = setup(t);
  flow.fake.edit((state) => { state.tasks.native = fakeTask('native', { deps: [{ type: 'blocked-by', id: 'managed-task' }] }); });
  const rejected = flow.manage(flow.command({ dependencies: ['native'] }));
  assert.equal(rejected.operation.state, 'failed');
  assert.equal(flow.fake.read().trace.length, 0);
  flow.succeeded(flow.command({ dependencies: [] }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false);
});

test('review 8: padded title receipts converge and allow a later pause', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  flow.succeeded(flow.existing({ action: 'update', update: { title: '  Normalized title  ' } }));
  assert.equal(flow.fake.read().tasks['managed-task']!.title, 'Normalized title');
  flow.succeeded(flow.existing({ action: 'pause' }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, true);
});

function equalTimeAttemptRecords(records: FactoryRecord[], competingId: boolean) {
  const { result } = productPrerequisiteRecords(records, 'criterion', true);
  const first = records.find((record) => record.kind === 'assignment');
  if (first?.kind !== 'assignment') assert.fail();
  const at = '2026-11-11T18:00:00Z';
  first.updatedAt = at;
  const revised = { ...structuredClone(first), revision: 2, attemptId: 'attempt-revision-2', updatedAt: at };
  records.push(revised, { ...structuredClone(result), id: 'result-revision-2', assignment: ref(revised) });
  if (competingId) records.push({ ...structuredClone(first), id: 'competing-assignment', attemptId: 'competing-attempt',
    createdAt: at, updatedAt: at });
}

test('review 1176 finding 6: tied assignment IDs stay unresolved despite different local revisions', (t) => {
  const flow = setup(t, false, (records) => equalTimeAttemptRecords(records, true));
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done' }); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, true, 'A@2 cannot outrank competing B@1 at the same time');
  assertNeverReady(flow.fake.read());
});

test('review 1176 finding 6: revisions are collapsed within one assignment ID before comparing attempts', (t) => {
  const flow = setup(t, false, (records) => equalTimeAttemptRecords(records, false));
  flow.fake.edit((state) => { state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'done' }); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assert.equal(flow.fake.read().tasks['managed-task']!.held, false, 'Evidence for the sole current assignment revision is sufficient');
  const records = flow.store.records(projectId);
  records.push(flow.store.get(projectId, 'assignment-1', 1)!);
  assert.deepEqual(taskReadinessReasons(records, flow.mapping()), [], 'An older revision of the same ID is not a competing attempt');
});


test('undefined-only updates are rejected and accepted commands survive JSON persistence', (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  assert.throws(() => flow.existing({ action: 'update', update: { title: undefined } }), /at least one field/);
  const input = flow.existing({ action: 'update', update: { title: undefined, body: 'Defined body' } });
  assert.deepEqual(MapManageExecutionTaskCommandSchema.parse(JSON.parse(JSON.stringify(input))), JSON.parse(JSON.stringify(input)));
  flow.succeeded(input);
  assert.doesNotThrow(() => flow.store.exportProject(projectId));
  flow.succeeded(flow.existing({ action: 'pause' }));
});

for (const intermediary of ['native', 'legacy'] as const) test(`cancellation protects a consumer through ${intermediary} dependencies`, (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  flow.fake.edit((state) => {
    state.tasks['managed-task']!.state = 'done';
    state.tasks.native = fakeTask('native', { state: 'done' });
    state.tasks.legacy = fakeTask('legacy');
  });
  const consumer = intermediary === 'native' ? flow.command({
    task: { kind: 'new', firstMateTaskId: 'consumer', title: 'Consumer', repo: 'sample' }, dependencies: ['native'],
  }, 'consumer-mapping') : flow.command({ task: { kind: 'existing', firstMateTaskId: 'legacy' },
    action: 'map', feature: null, criteria: [], detailedPlanTask: null, dependencies: ['managed-task'],
  }, 'consumer-mapping');
  flow.succeeded(consumer);
  flow.fake.edit((state) => { state.tasks.native!.deps = [{ type: 'blocked-by', id: 'managed-task' }]; });
  flow.succeeded(flow.existing({ action: 'cancel' }));
  const id = intermediary === 'native' ? 'consumer' : 'legacy';
  assert.equal(flow.fake.read().tasks[id]!.held, true);
  const mapping = flow.store.get(projectId, 'consumer-mapping'); assert.ok(mapping?.kind === 'task_mapping');
  assert.match(taskReadinessReasons(flow.store.records(projectId), mapping).join('\n'), /Cancelled prerequisite managed-task/);
  // Native cleanup cannot erase the durable cancellation fact on reconciliation.
  flow.fake.edit((state) => { delete state.tasks.native; });
  const refresh = { ...consumer, issuedAt: new Date().toISOString(), id: 'refresh-consumer', idempotencyKey: 'refresh-consumer', expectedRevision: mapping.revision,
    payload: { ...consumer.payload, action: 'map' as const, task: { kind: 'existing' as const, firstMateTaskId: id } } };
  flow.succeeded(refresh);
  assert.equal(flow.fake.read().tasks[id]!.held, true);
  const refreshed = flow.store.get(projectId, 'consumer-mapping'); assert.ok(refreshed?.kind === 'task_mapping');
  assert.match(taskReadinessReasons(flow.store.records(projectId), refreshed).join('\n'), /Cancelled prerequisite managed-task/);
});

for (const metadata of ['durable', 'historical'] as const) test(`lost dependency receipt followed by a rejected retry cannot replace a partly applied intent (${metadata})`, (t) => {
  const flow = setup(t);
  flow.succeeded(flow.command());
  flow.fake.edit((state) => { state.tasks.prerequisite = fakeTask('prerequisite'); state.failure = { action: 'block', when: 'after' }; });
  const result = flow.manage(flow.existing({ dependencies: ['prerequisite'] }));
  assert.equal(result.operation.state, 'unknown');
  assert.ok(flow.fake.read().tasks['managed-task']!.deps.some((edge) => edge.id === 'prerequisite'));
  flow.fake.edit((state) => { state.tasks.prerequisite!.deps = [{ type: 'blocked-by', id: 'managed-task' }]; });
  const reopened = new ProjectStore(metadata === 'durable' ? flow.database : join(flow.directory, 'historical.sqlite'));
  try {
    if (metadata === 'historical') {
      const snapshot = flow.store.exportProject(projectId);
      for (const record of snapshot.history) if (record.kind === 'operation') delete record.taskMutationAttempted;
      reopened.importProject(snapshot);
    }
    const retry = reconcileManagedTask(reopened, projectId, result.operation.id, flow.options);
    assert.equal(retry.taskRejection, undefined, 'A previous write prevents definitive pre-mutation rejection');
    const replacement = { ...flow.existing({ dependencies: [] }), expectedRevision: reopened.get(projectId, 'mapping-managed')!.revision };
    assert.throws(() => queueManagedTask(reopened, replacement), /reconcile_previous/);
  } finally { reopened.close(); }
});

test('attempted dependency ownership survives a lost receipt and changed producer resolution', (t) => {
  const flow = setup(t, true, (records) => { productPrerequisiteRecords(records, 'criterion', true); });
  flow.succeeded(flow.command({ detailedPlanTask: { id: 'consumer-task', revision: 1 }, requirements: [] }));
  // Reinstall the planned edge so its next write loses its receipt.
  flow.fake.edit((state) => {
    state.tasks['managed-task']!.deps = [];
    state.tasks['pilot-build'] = fakeTask('pilot-build');
    state.failure = { action: 'block', when: 'after' };
  });
  const pending = flow.manage(flow.existing({ detailedPlanTask: { id: 'consumer-task', revision: 1 } }));
  assert.equal(pending.operation.state, 'unknown');
  reviseRecord(flow, 'mapping-1', (record) => { if (record.kind === 'task_mapping') record.firstMateTaskId = 'replacement-producer'; });
  const retry = reconcileManagedTask(flow.store, projectId, pending.operation.id, flow.options);
  assert.equal(retry.state, 'succeeded', retry.reconciliation?.note);
  assert.equal(flow.fake.read().tasks['managed-task']!.deps.some((edge) => edge.id === 'pilot-build'), false);
  reviseRecord(flow, 'plan-1', (record) => { if (record.kind === 'implementation_plan_revision') record.dependencies = []; });
  flow.succeeded(flow.existing({ detailedPlanTask: { id: 'consumer-task', revision: 1 }, requirements: [] }));
  assert.deepEqual(flow.fake.read().tasks['managed-task']!.deps, []);
});


for (const problem of ['absent-cycle', 'existing-cycle', 'read-failure'] as const) test(`review 1459 finding 1: cancellation protects and stops before unrelated ${problem}`, (t) => {
  const flow = setup(t, true);
  flow.succeeded(flow.command());
  flow.fake.edit((state) => {
    state.tasks['managed-task']!.state = 'done';
    state.tasks['broken-native'] = fakeTask('broken-native', { deps: [{ type: 'blocked-by', id: 'broken-task' }] });
  });
  const rejected = flow.manage(flow.command({ task: { kind: 'new', firstMateTaskId: 'broken-task', title: 'Unrelated rejected work', repo: 'sample' },
    dependencies: ['broken-native'] }, 'broken-mapping'));
  assert.equal(rejected.operation.state, 'failed');
  flow.succeeded(flow.command({ task: { kind: 'new', firstMateTaskId: 'consumer', title: 'Affected consumer', repo: 'sample' },
    dependencies: ['managed-task'] }, 'consumer-mapping'));
  flow.fake.edit((state) => {
    state.tasks['managed-task']!.state = 'in_flight';
    if (problem !== 'absent-cycle') state.tasks['broken-task'] = fakeTask('broken-task', { deps: [{ type: 'blocked-by', id: 'broken-native' }] });
  });
  if (problem === 'read-failure') {
    const wrapper = readFileSync(flow.fake.executable, 'utf8');
    writeFileSync(flow.fake.executable, wrapper.replace('const fs =',
      `if (process.argv[2] === 'show' && process.argv[3] === 'broken-native') { process.stdout.write('incomplete observation'); process.exit(0); }\nconst fs =`));
  }
  const control = join(flow.directory, 'cancel-control.cjs');
  const stopped = join(flow.directory, 'stopped.json');
  writeFileSync(control, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(stopped)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  flow.options.controlExecutable = control;
  const before = flow.fake.read().calls.length;
  const result = flow.manage(flow.existing({ action: 'cancel' }));
  const state = flow.fake.read();
  assert.equal(state.tasks['managed-task']!.held, true, 'Cancellation protects its target despite unrelated graphs');
  assert.equal(state.tasks.consumer!.held, true, 'Known affected consumers are protected before unrelated observations');
  assert.deepEqual(JSON.parse(readFileSync(stopped, 'utf8')), ['managed-task', 'exit']);
  if (problem === 'absent-cycle') {
    assert.equal(result.operation.state, 'succeeded', result.operation.reconciliation?.note);
    assert.equal(state.calls.slice(before).some((call) => call.args[0] === 'show' && call.args[1] === 'broken-native'), false);
  } else {
    assert.equal(result.operation.state, 'unknown', 'Unresolved native observations withhold synchronization success');
    assert.match(result.operation.reconciliation?.note ?? '', /observationErrors/);
    const calls = state.calls.slice(before);
    const brokenRead = calls.findIndex((call) => call.args[0] === 'show' && call.args[1] === 'broken-native');
    const consumerHold = calls.findIndex((call) => call.args[0] === 'hold' && call.args[1] === 'consumer');
    if (problem === 'existing-cycle') assert.ok(consumerHold >= 0 && brokenRead > consumerHold);
  }
});

test('review 1459 finding 2: downstream traversal uses each mapped intermediary retained native evidence', (t) => {
  const flow = setup(t, true);
  flow.succeeded(flow.command());
  flow.fake.edit((state) => {
    state.tasks['managed-task']!.state = 'done';
    state.tasks.native = fakeTask('native', { state: 'done', deps: [{ type: 'blocked-by', id: 'managed-task' }] });
  });
  flow.succeeded(flow.command({ task: { kind: 'new', firstMateTaskId: 'middle', title: 'Middle', repo: 'sample' },
    dependencies: ['native'] }, 'middle-mapping'));
  flow.fake.edit((state) => { state.tasks.middle!.state = 'done'; delete state.tasks.native; });
  flow.succeeded(flow.command({ task: { kind: 'new', firstMateTaskId: 'consumer', title: 'Downstream', repo: 'sample' },
    dependencies: ['middle'] }, 'consumer-mapping'));
  flow.succeeded(flow.existing({ action: 'cancel' }));
  assert.equal(flow.fake.read().tasks.consumer!.held, true);
  const consumer = flow.store.get(projectId, 'consumer-mapping'); assert.ok(consumer?.kind === 'task_mapping');
  assert.match(taskReadinessReasons(flow.store.records(projectId), consumer).join('\n'), /Cancelled prerequisite managed-task/);
  flow.succeeded(flow.command({ task: { kind: 'existing', firstMateTaskId: 'consumer' }, action: 'map', dependencies: ['middle'] }, 'consumer-mapping'));
  assert.equal(flow.fake.read().tasks.consumer!.held, true, 'Completed middle work cannot release a downstream consumer');
});

test('review 1459 finding 3: imported legacy intermediaries preserve their observed native edges', (t) => {
  const flow = setup(t, true);
  flow.succeeded(flow.command());
  flow.fake.edit((state) => {
    state.tasks['managed-task']!.state = 'done';
    state.tasks['legacy-middle'] = fakeTask('legacy-middle', { state: 'done', deps: [{ type: 'blocked-by', id: 'managed-task' }] });
  });
  const runtime = fakeRuntime(flow.directory, ['managed-task', 'legacy-middle']);
  const imported = importLegacyTasks(flow.store, projectId, { fmHome: flow.directory, snapshotExecutable: runtime.executable });
  assert.equal(imported.mappings.length, 1); assert.equal(imported.mappings[0]!.legacy, true);
  assert.deepEqual(imported.mappings[0]!.dependencies, []);
  flow.succeeded(flow.command({ task: { kind: 'new', firstMateTaskId: 'consumer', title: 'Downstream', repo: 'sample' },
    dependencies: ['legacy-middle'] }, 'consumer-mapping'));
  flow.succeeded(flow.existing({ action: 'cancel' }));
  assert.equal(flow.fake.read().tasks.consumer!.held, true);
  const consumer = flow.store.get(projectId, 'consumer-mapping'); assert.ok(consumer?.kind === 'task_mapping');
  assert.match(taskReadinessReasons(flow.store.records(projectId), consumer).join('\n'), /Cancelled prerequisite managed-task/);
});
