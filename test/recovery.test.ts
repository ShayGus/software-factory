import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ProjectStore, RecordsSchema, queueManagedTask, reconcileManagedTask, queueCorrection, deliverCorrection,
  startManagedWorker, importLegacyTasks, disableProject, reconcileProject, backupProject, restoreProjectBackup,
  initializeProject, ref, checkStartingWorker, captureRequest, manageExecutionTask, parseFirstMateInboxBody, type Assignment, type CorrectionAdapterOptions } from '../src/index.js';
import { fakeTask, fakeTaskWrapper } from './task-wrapper-helper.js';
import { fakeRuntime } from './runtime-helper.js';
const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const projectId = 'project-1';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function setup(t: TestContext, onlyProject = false) {
  const home = mkdtempSync(join(tmpdir(), 'sf-recovery-'));
  const database = join(home, 'store.sqlite'); let store = new ProjectStore(database);
  if (onlyProject) initializeProject(store, baseline.find((record) => record.kind === 'project'));
  else store.importProject({ schemaVersion: 1, projectId, history: baseline.filter((record) => !['observation', 'guidance_revision'].includes(record.kind)), receipts: [] });
  const tasks = fakeTaskWrapper(home, true, database);
  const runtime = fakeRuntime(home);
  const adapter = { fmHome: home, tasksExecutable: tasks.executable, snapshotExecutable: runtime.executable };
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const save = (name: string, value: unknown) => { const path = join(home, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const executable = (name: string, body: string) => { const path = join(home, name); writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o755 }); return path; };
  return { home, database, get store() { return store; }, reopen: () => { store.close(); store = new ProjectStore(database); },
    tasks, runtime, adapter, save, executable };
}
function taskCommand(id = 'new-task', action = 'create') {
  return { schemaVersion: 1, id: `command-${id}`, projectId, issuedAt: new Date().toISOString(), idempotencyKey: `key-${id}`,
    command: 'map_manage_execution_task', targetId: `mapping-${id}`, expectedRevision: 0,
    payload: { action, task: action === 'create' ? { kind: 'new', firstMateTaskId: id, title: 'Deliver the common integration', repo: 'sample' } :
      { kind: 'existing', firstMateTaskId: id }, feature: { id: 'feature-1', revision: 1 },
      criteria: [{ id: 'criterion-general', revision: 1 }, { id: 'criterion-second-system', revision: 1 }],
      detailedPlanTask: { id: 'task-1', revision: 1 }, dependencies: [], reason: 'Acceptance test' } };
}
function assignment(flow: ReturnType<typeof setup>) { return flow.store.get(projectId, 'assignment-1') as Assignment; }
function correction(flow: ReturnType<typeof setup>, action = 'clarification') {
  return queueCorrection(flow.store, { schemaVersion: 1, id: 'correction-command', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'correction-key', command: 'deliver_correction', targetId: 'correction-1', expectedRevision: 0,
    payload: { affectedRevision: { id: 'feature-1', revision: 1 }, assignment: ref(assignment(flow)),
      originalCorrection: 'Preserve every system, including the second system.', action, sequence: 1, supersedes: [], sourceRefs: [{ uri: 'fixture:original' }] } });
}

test('process death after task creation is recovered by stable backlog ID without another add', t => {
  const flow = setup(t);
  const intent = queueManagedTask(flow.store, taskCommand());
  const crash = flow.executable('task-crash.cjs', `const cp=require('node:child_process');
const out=cp.spawnSync(${JSON.stringify(flow.tasks.executable)},process.argv.slice(2));
if(out.status!==0){process.stdout.write(out.stdout);process.stderr.write(out.stderr);process.exit(out.status??2);}
if(process.argv[2]==='add'&&process.argv[3]!=='--help'){process.kill(process.ppid,'SIGKILL');process.exit(0);}
process.stdout.write(out.stdout);`);
  const config = flow.save('task-adapter.json', { ...flow.adapter, tasksExecutable: crash });
  const result = spawnSync(process.execPath, [cli, 'reconcile-task', '--db', flow.database, '--project', projectId,
    '--operation', intent.operation.id, '--adapter-config', config], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  flow.reopen();
  assert.equal(flow.store.get(projectId, intent.operation.id)?.kind, 'operation');
  assert.equal(reconcileManagedTask(flow.store, projectId, intent.operation.id, flow.adapter).state, 'succeeded');
  assert.equal(flow.tasks.read().calls.filter((call) => call.args[0] === 'add' && call.args[1] !== '--help').length, 1);
});

test('process death after worker start is recovered from fleet generation without another spawn', t => {
  const flow = setup(t);
  const start = flow.executable('spawn-crash.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'starts'))},'start\\n');
fs.writeFileSync(${JSON.stringify(flow.runtime.statePath)},JSON.stringify([{id:'pilot-build',spawn_gen:'new-generation',project:${JSON.stringify(flow.home)},current_state:{state:'active',freshness:'fresh',observed_at:''}}]));
process.kill(process.ppid,'SIGKILL');`);
  const input = { projectId, idempotencyKey: 'start-once', assignment: ref(assignment(flow)), repository: flow.home,
    executable: start, args: ['pilot-build', flow.home] };
  const result = spawnSync(process.execPath, [cli, 'start-worker', '--db', flow.database, '--input', flow.save('start.json', input),
    '--adapter-config', flow.save('runtime-adapter.json', { fmHome: flow.home, snapshotExecutable: flow.runtime.executable })], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  flow.reopen();
  const recovered = startManagedWorker(flow.store, input, { fmHome: flow.home, snapshotExecutable: flow.runtime.executable });
  assert.equal(recovered.state, 'succeeded', recovered.reconciliation?.note);
  assert.match(recovered.reconciliation!.note, /worker_start/);
  assert.equal(readFileSync(join(flow.home, 'starts'), 'utf8'), 'start\n');
});

test('ambiguous worker timeout plus an empty fleet never authorizes a second launch', t => {
  const flow = setup(t);
  const start = flow.executable('spawn-lost.cjs', `require('node:fs').appendFileSync(${JSON.stringify(join(flow.home, 'starts'))},'start\\n'); setTimeout(()=>process.exit(0),10000);`);
  const input = { projectId, idempotencyKey: 'start-lost', assignment: ref(assignment(flow)), repository: flow.home,
    executable: start, args: ['pilot-build', flow.home] };
  const adapter = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable, timeoutMs: 500 };
  assert.equal(startManagedWorker(flow.store, input, adapter).state, 'unknown');
  flow.reopen(); assert.equal(startManagedWorker(flow.store, input, adapter).state, 'unknown');
  const result = spawnSync(process.execPath, [cli, 'start-worker', '--db', flow.database, '--input', flow.save('unknown-start.json', input),
    '--adapter-config', flow.save('unknown-adapter.json', adapter)], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).state, 'unknown');
  assert.equal(readFileSync(join(flow.home, 'starts'), 'utf8'), 'start\n');
});

test('process death after durable steering is recovered from handled inbox without resending or claiming incorporation', t => {
  const flow = setup(t); const queued = correction(flow);
  const inbox = join(flow.home, 'state', 'pilot-build.inbox'); mkdirSync(inbox, { recursive: true });
  const send = flow.executable('send-crash.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'sends'))},'send\\n');
fs.writeFileSync(${JSON.stringify(join(inbox, '001.msg'))},'schema=fm-task-inbox.v1\\nat=2026-11-12T12:00:00Z\\nbody-terminator=1\\n--\\n'+process.argv[3]+'\\n');
process.kill(process.ppid,'SIGKILL');`);
  const options: CorrectionAdapterOptions = { fmHome: flow.home, sendExecutable: send, controlExecutable: send,
    snapshotExecutable: flow.runtime.executable, recipients: [{ assignment: ref(assignment(flow)), attemptId: assignment(flow).attemptId,
      firstMateTaskId: 'pilot-build', state: 'active', observedAt: new Date().toISOString() }] };
  const result = spawnSync(process.execPath, [cli, 'deliver-correction', '--db', flow.database, '--project', projectId,
    '--correction', queued.correction.id, '--adapter-config', flow.save('correction-adapter.json', options)], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  mkdirSync(join(inbox, 'handled')); renameSync(join(inbox, '001.msg'), join(inbox, 'handled', '001.msg'));
  flow.reopen();
  const recovered = deliverCorrection(flow.store, projectId, queued.correction.id, options);
  assert.equal(recovered.state, 'succeeded', recovered.reconciliation?.note);
  const record = flow.store.get(projectId, queued.correction.id);
  assert.ok(record?.kind === 'observation');
  assert.deepEqual(record.correction!.facts.map((fact) => fact.fact), ['recorded', 'delivered']);
  assert.equal(readFileSync(join(flow.home, 'sends'), 'utf8'), 'send\n');
});

test('legacy import and progressive linking never verify old completed work', t => {
  const flow = setup(t);
  flow.runtime.save([{ id: 'old-task', spawn_gen: 'old-generation', project: flow.home, current_state: { state: 'done', freshness: 'fresh', observed_at: '' } }]);
  const resultsBefore = flow.store.records(projectId).filter((record) => ['criterion_result', 'product_review'].includes(record.kind));
  const [mapping] = importLegacyTasks(flow.store, projectId, { fmHome: flow.home, snapshotExecutable: flow.runtime.executable });
  assert.ok(mapping); assert.equal(mapping.legacy, true); assert.equal(mapping.importedExecution?.verification, 'unverified');
  flow.tasks.edit((state) => { state.tasks['old-task'] = fakeTask('old-task', { state: 'done' }); });
  const command = taskCommand('old-task', 'map'); command.targetId = mapping.id; command.expectedRevision = 1;
  queueManagedTask(flow.store, command);
  const linked = flow.store.get(projectId, mapping.id);
  assert.ok(linked?.kind === 'task_mapping'); assert.equal(linked.legacy, false);
  assert.equal(linked.importedExecution?.verification, 'unverified');
  assert.deepEqual(flow.store.records(projectId).filter((record) => ['criterion_result', 'product_review'].includes(record.kind)), resultsBefore);
});

test('backup restores store and artifact bytes, reports missing and changed names, and gates wrappers before reconciliation', t => {
  const flow = setup(t, true);
  const artifact = join(flow.home, 'evidence.txt'); writeFileSync(artifact, 'evidence');
  const missing = join(flow.home, 'missing.txt');
  const project = flow.store.get(projectId, projectId)!;
  const at = new Date().toISOString();
  const decision = { kind: 'decision_change', id: 'artifact-decision', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
    questionOrChange: 'Retain evidence', affectedRecords: [ref(project)], rationale: 'Artifact references', disposition: 'selected',
    sourceRefs: [{ uri: artifact }, { uri: missing }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: 'save', projectId, issuedAt: at, idempotencyKey: 'save', command: 'record_decision_suggestion',
    targetId: decision.id, expectedRevision: 0, payload: { decision } }, () => [decision]);
  const backup = backupProject(flow.store, projectId);
  rmSync(artifact);
  const restored = new ProjectStore(join(flow.home, 'restored.sqlite'));
  try {
    const report = restoreProjectBackup(restored, backup, flow.home);
    assert.equal(readFileSync(artifact, 'utf8'), 'evidence');
    assert.ok(report.artifacts.some((item) => item.path === missing && item.issue === 'missing'));
    assert.throws(() => restored.assertExternalOperationsAllowed(projectId), /reconciling/);
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'reconciling');
    assert.equal(existsSync(join(flow.home, 'runtime-reads')), false);
  } finally { restored.close(); }
  const changedBackup = structuredClone(backup); writeFileSync(artifact, 'other');
  const another = new ProjectStore(join(flow.home, 'another.sqlite'));
  try { assert.ok(restoreProjectBackup(another, changedBackup, flow.home).artifacts.some((entry) => entry.path === artifact && entry.issue === 'changed')); }
  finally { another.close(); }
});

for (const mode of ['pause', 'hand_back'] as const) test(`disable ${mode} leaves active execution and unrelated holds; re-enable observes before fresh work`, t => {
  const flow = setup(t); const queued = queueManagedTask(flow.store, taskCommand());
  assert.equal(reconcileManagedTask(flow.store, projectId, queued.operation.id, flow.adapter).state, 'succeeded');
  const next = taskCommand('pending'); const pending = queueManagedTask(flow.store, next);
  flow.tasks.edit((state) => {
    state.tasks['new-task']!.state = 'in_flight';
    const mapping = flow.store.get(projectId, 'mapping-new-task'); assert.ok(mapping?.kind === 'task_mapping');
    state.tasks['new-task']!.hold = { reason: mapping.management!.holdReason, kind: 'external', until: null };
    state.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'in_flight', hold: { reason: 'Owner decision', kind: 'captain', until: null } });
  });
  const disabled = disableProject(flow.store, projectId, mode, flow.adapter);
  assert.deepEqual(disabled.errors, []);
  assert.equal(flow.tasks.read().tasks['new-task']!.state, 'in_flight');
  assert.equal(flow.tasks.read().tasks['new-task']!.hold !== null, mode === 'pause');
  assert.equal(flow.tasks.read().tasks['pilot-build']!.hold!.reason, 'Owner decision');
  assert.equal(flow.tasks.read().calls.some((call) => call.args.includes('exit') || call.args.includes('done')), false);
  assert.throws(() => reconcileManagedTask(flow.store, projectId, pending.operation.id, flow.adapter), /disabled/);
  assert.deepEqual(checkStartingWorker({ version: 1, projects: [{ home: flow.home, projectId, database: flow.database,
    agentConfig: join(flow.home, 'unused.json') }] }, { version: 1, event: 'worker.start.before', home: flow.home,
    task_id: 'pilot-build', source_brief_path: null, brief_path: null, brief_sha256: null }), { ok: true, managed: false });
  // A malformed observation keeps the gate closed.
  const broken = flow.executable('bad-snapshot.cjs', "process.stdout.write('{}');");
  assert.throws(() => reconcileProject(flow.store, projectId, { ...flow.adapter, snapshotExecutable: broken }));
  assert.throws(() => reconcileManagedTask(flow.store, projectId, pending.operation.id, flow.adapter), /reconciling/);
  assert.equal(reconcileProject(flow.store, projectId, flow.adapter).state, 'enabled');
  assert.ok(readFileSync(join(flow.home, 'runtime-reads'), 'utf8').length > 0);
  assert.throws(() => reconcileManagedTask(flow.store, projectId, pending.operation.id, flow.adapter), /permanently_suspended/);
  assert.equal(flow.tasks.read().tasks.pending, undefined);
});

test('lost cancellation exit result observes the recorded generation before completing without a second exit', t => {
  const flow = setup(t);
  flow.tasks.edit((state) => { state.tasks['active-task'] = fakeTask('active-task', { state: 'in_flight' }); });
  flow.runtime.save([{ id: 'active-task', spawn_gen: 'active-generation', project: flow.home,
    current_state: { state: 'active', freshness: 'fresh', observed_at: '' } }]);
  const queued = queueManagedTask(flow.store, taskCommand('active-task', 'cancel'));
  const control = flow.executable('control-crash.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'exits'))},'exit\\n');
const tasks=JSON.parse(fs.readFileSync(${JSON.stringify(flow.runtime.statePath)},'utf8'));tasks[0].current_state.state='stopped';
fs.writeFileSync(${JSON.stringify(flow.runtime.statePath)},JSON.stringify(tasks));process.kill(process.ppid,'SIGKILL');`);
  const adapter = { ...flow.adapter, controlExecutable: control };
  const result = spawnSync(process.execPath, [cli, 'reconcile-task', '--db', flow.database, '--project', projectId,
    '--operation', queued.operation.id, '--adapter-config', flow.save('cancel-adapter.json', adapter)], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  flow.reopen();
  assert.equal(reconcileManagedTask(flow.store, projectId, queued.operation.id, adapter).state, 'succeeded');
  assert.equal(readFileSync(join(flow.home, 'exits'), 'utf8'), 'exit\n');
  assert.equal(flow.tasks.read().tasks['active-task']!.state, 'in_flight');
});

test('complete restore reconciles both interfaces before a pending operation can run and preserves disabled state', t => {
  const flow = setup(t, true);
  const captured = captureRequest(flow.store, { projectId, clientRequestId: 'restore-request', channel: 'cli',
    source: { uri: 'fixture:request' }, originalText: 'Keep the complete source request', attachments: [] });
  const bundle = backupProject(flow.store, projectId);
  const restored = new ProjectStore(join(flow.home, 'complete-restore.sqlite'));
  try {
    assert.deepEqual(restoreProjectBackup(restored, bundle, flow.home).artifacts, []);
    assert.throws(() => restored.assertExternalOperationsAllowed(projectId), /reconciling/);
    assert.equal(reconcileProject(restored, projectId, flow.adapter, false).state, 'enabled');
    restored.assertExternalOperationsAllowed(projectId);
    assert.equal(restored.get(projectId, captured.request.id)?.kind, 'request');
    assert.equal(restored.operations(projectId)[0]!.state, 'pending');
  } finally { restored.close(); }
  disableProject(flow.store, projectId, 'pause');
  const disabledBundle = backupProject(flow.store, projectId);
  const disabledRestore = new ProjectStore(join(flow.home, 'disabled-restore.sqlite'));
  try {
    restoreProjectBackup(disabledRestore, disabledBundle, flow.home);
    assert.equal(reconcileProject(disabledRestore, projectId, flow.adapter, false).state, 'disabled');
    assert.equal(reconcileProject(disabledRestore, projectId, flow.adapter).state, 'enabled');
    assert.ok(disabledRestore.operations(projectId)[0]!.suspended);
  } finally { disabledRestore.close(); }
});

test('handback removes a proven toolkit guard while retaining the unrelated owner hold and dependency', t => {
  const flow = setup(t);
  flow.tasks.edit((state) => {
    state.tasks['guarded-task'] = fakeTask('guarded-task', {
      hold: { reason: 'Owner condition', kind: 'captain', until: null }, deps: [{ type: 'blocked-by', id: 'foreign-dep' }] });
    state.tasks['foreign-dep'] = fakeTask('foreign-dep');
  });
  const command = taskCommand('guarded-task', 'map');
  const result = manageExecutionTask(flow.store, { ...command, payload: { ...command.payload,
    readiness: [{ id: 'condition', reason: 'Independent product condition', evidence: [] }] } }, { ...flow.adapter, guardTaskId: 'permanent-guard' });
  assert.equal(result.operation.state, 'succeeded');
  assert.ok(flow.tasks.read().tasks['guarded-task']!.deps.some((edge) => edge.id === 'permanent-guard'));
  const report = disableProject(flow.store, projectId, 'hand_back', { ...flow.adapter, guardTaskId: 'permanent-guard' });
  assert.ok(report.outstandingConditions.some((condition) => condition.includes('Independent product condition')));
  assert.deepEqual(report.errors, []);
  const task = flow.tasks.read().tasks['guarded-task']!;
  assert.equal(task.hold?.reason, 'Owner condition');
  assert.deepEqual(task.deps, [{ type: 'blocked-by', id: 'foreign-dep' }]);
});


test('durable inbox parsing preserves exact message bytes and rejects header and quoted-body matches', () => {
  const header = 'schema=fm-task-inbox.v1\nat=2026-11-12T12:00:00Z\n';
  assert.equal(parseFirstMateInboxBody(header + '--\nlegacy without newline'), 'legacy without newline');
  assert.equal(parseFirstMateInboxBody(header + '--\nintentional\n\n'), 'intentional\n\n');
  assert.equal(parseFirstMateInboxBody(header + 'body-terminator=1\n--\nbody\n'), 'body');
  assert.equal(parseFirstMateInboxBody(header + 'body-terminator=1\n--\nbody\n\n'), 'body\n');
  assert.throws(() => parseFirstMateInboxBody(header + 'body-terminator=1\n--\nbody'), /terminator_missing/);
  assert.throws(() => parseFirstMateInboxBody('payload-only'), /unsupported/);
  assert.notEqual(parseFirstMateInboxBody(header + 'payload\n--\nother body'), 'payload');
  assert.notEqual(parseFirstMateInboxBody(header + '--\nquoted payload\npayload\n'), 'payload');
});


test('backup, restore, disable and re-enable CLI round trip retains source bytes and never executes pending work', t => {
  const flow = setup(t, true);
  const artifact = join(flow.home, 'request-attachment.txt'); writeFileSync(artifact, 'Exact attachment bytes\n');
  captureRequest(flow.store, { projectId, clientRequestId: 'cli-request', channel: 'cli', source: { uri: 'fixture:cli' },
    originalText: 'Preserve the full original request', attachments: [{ uri: artifact, revision: 'v1' }] });
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const exported = run('backup', '--db', flow.database, '--project', projectId);
  assert.equal(exported.status, 0, exported.stderr);
  const bundle = flow.save('cli-backup.json', JSON.parse(exported.stdout)); rmSync(artifact);
  const database = join(flow.home, 'cli-restored.sqlite');
  const adapter = flow.save('cli-task-adapter.json', flow.adapter);
  const restored = run('restore', '--db', database, '--input', bundle, '--artifact-root', flow.home, '--adapter-config', adapter);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).reconciliation.state, 'enabled');
  assert.equal(readFileSync(artifact, 'utf8'), 'Exact attachment bytes\n');
  assert.equal(run('disable-project', '--db', database, '--project', projectId, '--mode', 'pause').status, 0);
  assert.equal(run('reconcile-project', '--db', database, '--project', projectId, '--adapter-config', adapter).status, 0);
  const store = new ProjectStore(database);
  try {
    assert.equal(store.operations(projectId)[0]!.state, 'pending');
    assert.ok(store.operations(projectId)[0]!.suspended);
    assert.throws(() => store.assertExternalOperationsAllowed(projectId, store.operations(projectId)[0]!), /suspended/);
  } finally { store.close(); }
  assert.equal(flow.tasks.read().calls.length, 0);
});
