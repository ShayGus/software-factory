import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ProjectStore, RecordsSchema, queueManagedTask, reconcileManagedTask, queueCorrection, deliverCorrection,
  startManagedWorker, importLegacyTasks, disableProject, reconcileProject, backupProject, restoreProjectBackup,
  recoverTaskCorrection, stableId, captureLearning, readLegacySection, checkConfiguredWorkerStart, initializeProject, ref, checkStartingWorker, captureRequest, manageExecutionTask, parseFirstMateInboxBody, prepareWorkerBrief, requiredAssignmentContext, verifyRestoredArtifact, resolveRestoredReference, commandDigest, digestText, type Assignment, type CorrectionAdapterOptions } from '../src/index.js';
import { fakeJudge } from './judge-helper.js';
import { fakeTask, fakeTaskWrapper } from './task-wrapper-helper.js';
import { fakeRuntime } from './runtime-helper.js';
const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const projectId = 'project-1';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function setup(t: TestContext, onlyProject = false) {
  const home = mkdtempSync(join(tmpdir(), 'sf-recovery-'));
  writeFileSync(join(home, 'Software_Factory_Design.md'), 'Recorded design source');
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
function readyWorkerStart(flow: ReturnType<typeof setup>) {
  const a = assignment(flow); const history = flow.store.history(projectId);
  const request = history.find((record) => record.kind === 'request')!;
  const sources = requiredAssignmentContext(history, a).sources.filter((source) => !source.record).map((source, index) => {
    const path = join(flow.home, `launch-source-${index}.txt`);
    writeFileSync(path, request.kind === 'request' && source.uri === request.source.uri ? request.originalText : 'Existing common interface');
    return { source, path };
  });
  const briefPath = join(flow.home, 'launch-brief.md');
  writeFileSync(briefPath, readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url)));
  const prepared = prepareWorkerBrief(flow.store, { projectId, assignmentId: a.id, attemptId: a.attemptId, expectedRevision: a.revision,
    idempotencyKey: 'launch-prepare', issuedAt: new Date().toISOString(), detailedPlanTask: a.detailedPlanTask, plan: a.plan,
    firstMateTaskId: a.firstMateTaskId, returnLocation: a.returnLocation, briefPath, sourceFiles: sources });
  assert.equal(prepared.ok, true);
  const agentConfig = flow.save('launch-agents.json', fakeJudge);
  const hookRegistry = flow.save('launch-registry.json', { version: 1, projects: [{ home: flow.home, projectId, database: flow.database, agentConfig }] });
  mkdirSync(join(flow.home, 'config'), { recursive: true });
  flow.save('config/hooks.json', { version: 1, hooks: [{ event: 'worker.start.before',
    argv: [fileURLToPath(new URL('../../scripts/worker-start-before.mjs', import.meta.url)), hookRegistry] }] });
  return hookRegistry;
}
function correction(flow: ReturnType<typeof setup>, action = 'clarification') {
  return queueCorrection(flow.store, { schemaVersion: 1, id: 'correction-command', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'correction-key', command: 'deliver_correction', targetId: 'correction-1', expectedRevision: 0,
    payload: { affectedRevision: { id: 'feature-1', revision: 1 }, assignment: ref(assignment(flow)),
      originalCorrection: 'Preserve every system, including the second system.', action, sequence: 1, supersedes: [], sourceRefs: [{ uri: 'fixture:original' }],
      ...(action === 'amended_scope' ? { changedOutcome: 'Updated requested outcome' } : {}) } });
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
  const flow = setup(t); const hookRegistry = readyWorkerStart(flow);
  const start = flow.executable('spawn-crash.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'starts'))},'start\\n');
fs.writeFileSync(${JSON.stringify(flow.runtime.statePath)},JSON.stringify([{id:'pilot-build',spawn_gen:'new-generation',project:${JSON.stringify(flow.home)},current_state:{state:'active',freshness:'fresh',observed_at:''}}]));
process.kill(process.ppid,'SIGKILL');`);
  const input = { projectId, idempotencyKey: 'start-once', assignment: ref(assignment(flow)), repository: flow.home,
    executable: start, hookRegistry, args: ['pilot-build', flow.home] };
  const result = spawnSync(process.execPath, [cli, 'start-worker', '--db', flow.database, '--input', flow.save('start.json', input),
    '--adapter-config', flow.save('runtime-adapter.json', { fmHome: flow.home, snapshotExecutable: flow.runtime.executable })], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  flow.reopen();
  correction(flow, 'amended_scope');
  assert.ok(assignment(flow).revision > input.assignment.revision);
  const recovered = startManagedWorker(flow.store, input, { fmHome: flow.home, snapshotExecutable: flow.runtime.executable });
  assert.equal(recovered.state, 'succeeded', recovered.reconciliation?.note);
  assert.match(recovered.reconciliation!.note, /worker_start/);
  assert.equal(readFileSync(join(flow.home, 'starts'), 'utf8'), 'start\n');
});

test('ambiguous worker timeout plus an empty fleet never authorizes a second launch', t => {
  const flow = setup(t); const hookRegistry = readyWorkerStart(flow);
  const start = flow.executable('spawn-lost.cjs', `require('node:fs').appendFileSync(${JSON.stringify(join(flow.home, 'starts'))},'start\\n'); setTimeout(()=>process.exit(0),10000);`);
  const input = { projectId, idempotencyKey: 'start-lost', assignment: ref(assignment(flow)), repository: flow.home,
    executable: start, hookRegistry, args: ['pilot-build', flow.home] };
  const adapter = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable, timeoutMs: 500 };
  assert.equal(startManagedWorker(flow.store, input, adapter).state, 'unknown');
  flow.reopen(); assert.equal(startManagedWorker(flow.store, input, adapter).state, 'unknown');
  const result = spawnSync(process.execPath, [cli, 'start-worker', '--db', flow.database, '--input', flow.save('unknown-start.json', input),
    '--adapter-config', flow.save('unknown-adapter.json', adapter)], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).state, 'unknown');
  assert.equal(readFileSync(join(flow.home, 'starts'), 'utf8'), 'start\n');
});

test('a refused start rechecks the re-prepared assignment under the original start key', t => {
  const flow = setup(t); const hookRegistry = readyWorkerStart(flow);
  const original = assignment(flow);
  const brief = original.brief!;
  const starts = join(flow.home, 'starts');
  const executable = flow.executable('retry-start.cjs',
    `require('node:fs').appendFileSync(${JSON.stringify(starts)}, 'start\\n');`);
  const input = { projectId, idempotencyKey: 'retry-refused-start', assignment: ref(original), repository: flow.home,
    executable, hookRegistry, args: ['pilot-build', flow.home] };
  const adapter = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable };
  writeFileSync(brief.path, 'Unprepared launch candidate');
  const refused = startManagedWorker(flow.store, input, adapter);
  assert.equal(refused.state, 'pending');
  assert.match(refused.reconciliation!.note, /worker_start_check_failed/);
  assert.equal(refused.externalAttempt, undefined);
  assert.equal(existsSync(starts), false);
  const receipt = flow.store.receipt(projectId, input.idempotencyKey);

  const scaffoldPath = join(flow.home, 'retry-scaffold.md');
  const scaffold = brief.scaffold + '\nFresh delivery scaffold.\n';
  writeFileSync(scaffoldPath, scaffold);
  const sourceFiles = requiredAssignmentContext(flow.store.history(projectId), original).sources
    .filter(source => !source.record).map((source, index) => ({ source, path: join(flow.home, `launch-source-${index}.txt`) }));
  const preparation = { projectId, assignmentId: original.id, attemptId: original.attemptId, expectedRevision: original.revision,
    idempotencyKey: 'reprepare-refused-start', issuedAt: new Date().toISOString(), detailedPlanTask: original.detailedPlanTask,
    plan: original.plan, firstMateTaskId: original.firstMateTaskId, returnLocation: original.returnLocation, briefPath: brief.path,
    scaffoldPath, sourceFiles };
  const current = prepareWorkerBrief(flow.store, preparation);
  assert.equal(current.ok, true);
  assert.match(readFileSync(brief.path, 'utf8'), /Fresh delivery scaffold/);
  writeFileSync(scaffoldPath, 'Discarded after preparation');
  assert.deepEqual(prepareWorkerBrief(flow.store, preparation), current);
  flow.reopen();
  const started = startManagedWorker(flow.store, input, adapter);
  assert.equal(started.state, 'succeeded', started.reconciliation?.note);
  assert.equal(started.id, refused.id);
  assert.deepEqual(started.externalAttempt?.assignment, current.assignment);
  assert.deepEqual(flow.store.receipt(projectId, input.idempotencyKey), receipt);
  assert.deepEqual(startManagedWorker(flow.store, input, adapter), started);
  assert.equal(readFileSync(starts, 'utf8'), 'start\n');
});

for (const replacementId of ['assignment-1', 'replacement-assignment']) test(`review 1453-3: a timed-out start cannot claim a replacement generation (${replacementId})`, t => {
  const flow = setup(t); const hookRegistry = readyWorkerStart(flow);
  const timeout = flow.executable('start-timeout.cjs', `setTimeout(()=>process.exit(0),10000);`);
  const input = { projectId, idempotencyKey: 'original-start', assignment: ref(assignment(flow)), repository: flow.home,
    executable: timeout, hookRegistry, args: ['pilot-build', flow.home] };
  const adapter = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable, timeoutMs: 500 };
  const original = startManagedWorker(flow.store, input, adapter);
  assert.equal(original.state, 'unknown'); assert.ok(original.externalAttempt);
  const previous = assignment(flow); const at = new Date().toISOString();
  const replacement = { ...previous, id: replacementId, revision: replacementId === previous.id ? previous.revision + 1 : 1,
    updatedAt: at, attemptId: 'replacement-attempt', brief: undefined };
  const decision = { kind: 'decision_change', id: 'replace-start-attempt', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
    questionOrChange: 'Replace the timed-out worker attempt', affectedRecords: [ref(previous)], rationale: 'Fresh explicit attempt',
    disposition: 'selected', sourceRefs: [{ uri: 'fixture:replacement' }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
    command: 'record_decision_suggestion', targetId: replacement.id, expectedRevision: replacement.revision - 1, payload: { decision } }, () => [decision, replacement]);
  // Prepare the replacement through the same checked-start path, including a new assignment ID.
  const history = flow.store.history(projectId);
  const sourceFiles = requiredAssignmentContext(history, replacement).sources.filter(source => !source.record).map((source, index) =>
    ({ source, path: join(flow.home, `launch-source-${index}.txt`) }));
  const replacementBrief = join(flow.home, 'replacement-brief.md');
  writeFileSync(replacementBrief, readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url)));
  assert.equal(prepareWorkerBrief(flow.store, { projectId, assignmentId: replacement.id, attemptId: replacement.attemptId,
    expectedRevision: replacement.revision, idempotencyKey: 'replacement-prepare', issuedAt: new Date().toISOString(),
    detailedPlanTask: replacement.detailedPlanTask, plan: replacement.plan, firstMateTaskId: replacement.firstMateTaskId,
    returnLocation: replacement.returnLocation, briefPath: replacementBrief, sourceFiles }).ok, true);
  const start = flow.executable('replacement-start.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'replacement-starts'))},'start\\n');
fs.writeFileSync(${JSON.stringify(flow.runtime.statePath)},JSON.stringify([{id:'pilot-build',spawn_gen:'replacement-generation',project:${JSON.stringify(flow.home)},current_state:{state:'active',freshness:'fresh',observed_at:''}}]));`);
  const current = flow.store.get(projectId, replacement.id)!;
  assert.equal(startManagedWorker(flow.store, { ...input, idempotencyKey: 'replacement-start', assignment: ref(current), executable: start },
    { ...adapter, timeoutMs: 5000 }).state, 'succeeded');
  const replayed = startManagedWorker(flow.store, input, adapter);
  assert.equal(replayed.state, 'unknown', replayed.reconciliation?.note);
  assert.deepEqual(replayed.externalAttempt, original.externalAttempt);
  assert.equal(flow.store.history(projectId).some(record => record.id === original.id && record.kind === 'operation' && record.state === 'succeeded'), false);
  assert.equal(readFileSync(join(flow.home, 'replacement-starts'), 'utf8'), 'start\n');
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
  const { mappings: [mapping] } = importLegacyTasks(flow.store, projectId, { fmHome: flow.home, snapshotExecutable: flow.runtime.executable });
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
  const backup = backupProject(flow.store, projectId, flow.home);
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
  flow.runtime.save([{ id: 'active-task', spawn_gen: 'active-generation', project: flow.home, endpoint: { exists: true, agent_alive: 'alive', freshness: 'fresh', observed_at: '' },
    current_state: { state: 'active', freshness: 'fresh', observed_at: '' } }]);
  const queued = queueManagedTask(flow.store, taskCommand('active-task', 'cancel'));
  const control = flow.executable('control-crash.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'exits'))},'exit\\n');
const tasks=JSON.parse(fs.readFileSync(${JSON.stringify(flow.runtime.statePath)},'utf8'));tasks[0].current_state.state='unknown';tasks[0].endpoint.exists=true;tasks[0].endpoint.agent_alive='dead';
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
  const bundle = backupProject(flow.store, projectId, flow.home);
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
  const disabledBundle = backupProject(flow.store, projectId, flow.home);
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
  const exported = run('backup', '--db', flow.database, '--project', projectId, '--artifact-base', flow.home);
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

// Review 1299 regression tests: added before their implementation fixes.
test('review 1299-1: standalone start refuses launch without the shared instruction and dispatch check', t => {
  const flow = setup(t);
  const marker = join(flow.home, 'unchecked-start');
  const executable = flow.executable('unchecked.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
  const operation = startManagedWorker(flow.store, { projectId, idempotencyKey: 'unchecked', assignment: ref(assignment(flow)),
    repository: flow.home, executable, args: ['pilot-build', flow.home] }, { fmHome: flow.home, snapshotExecutable: flow.runtime.executable });
  assert.notEqual(operation.state, 'succeeded'); assert.equal(existsSync(marker), false);
});

test('review 1299-2: incomplete target inventory never authorizes an initial launch', async () => {
  const { FleetSnapshotSchema, runtimeTask } = await import('../src/index.js');
  const at = new Date().toISOString();
  const snapshot = FleetSnapshotSchema.parse({ schema: 'fm-fleet-snapshot.v1', generated: at, fm_home: '/fake',
    backlog: { present: true, records: [{ id: 'orphan', state: 'in_flight' }] }, tasks: [],
    main_inventory: { valid: false, orphan_in_flight: ['orphan'] } });
  assert.throws(() => runtimeTask(snapshot, 'orphan'), /inventory|metadata/);
});

test('a queued worker can start when inventory gaps identify only other in-flight tasks', async () => {
  const { FleetSnapshotSchema, runtimeTask } = await import('../src/index.js');
  const snapshot = FleetSnapshotSchema.parse({ schema: 'fm-fleet-snapshot.v1', generated: new Date().toISOString(), fm_home: '/fake',
    backlog: { present: true, records: [{ id: 'orphan', state: 'in_flight' }, { id: 'target', state: 'queued' }] }, tasks: [],
    main_inventory: { valid: false, orphan_in_flight: ['orphan'], unstructured_current_count: 0 } });
  assert.equal(runtimeTask(snapshot, 'target'), undefined);
  assert.throws(() => runtimeTask(snapshot, 'orphan'), /inventory|metadata/);
  assert.throws(() => runtimeTask(snapshot, 'unlisted'), /inventory|metadata/);
  for (const inventory of [
    { valid: false, orphan_in_flight: ['orphan'], unstructured_current_count: 1 },
    { valid: false, orphan_in_flight: ['unaccounted'], unstructured_current_count: 0 },
  ]) {
    assert.throws(() => runtimeTask({ ...snapshot, main_inventory: inventory }, 'target'), /inventory|metadata/);
  }
});

test('review 1299-3: unchanged failed crew state with a live endpoint cannot prove an interrupt succeeded', t => {
  const flow = setup(t);
  const a = assignment(flow);
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'stop', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'stop', command: 'deliver_correction', targetId: 'stop-correction', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Stop immediately', action: 'clarification', urgentStop: true,
      sequence: 1, supersedes: [] } });
  flow.runtime.save([{ id: a.firstMateTaskId, spawn_gen: 'same-gen', project: flow.home, endpoint: { exists: true, agent_alive: 'alive', freshness: 'fresh', observed_at: '' },
    current_state: { state: 'failed', freshness: 'fresh', observed_at: '' } }]);
  const control = flow.executable('refused.cjs', 'process.exit(2);');
  const options: CorrectionAdapterOptions = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable,
    sendExecutable: control, controlExecutable: control, recipients: [{ assignment: ref(a), attemptId: a.attemptId,
      firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
});

test('review 1299-4: integration disable between queue entry and lock acquisition cannot create a correction', t => {
  const flow = setup(t);
  const originalLock = flow.store.withTaskLock.bind(flow.store);
  flow.store.withTaskLock = (id, body) => originalLock(id, () => {
    const project = flow.store.get(projectId, projectId)!; const at = new Date().toISOString();
    const decision = { kind: 'decision_change', id: 'race-disable', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
      questionOrChange: 'Disable race', affectedRecords: [ref(project)], rationale: 'Concurrent disable before acquiring the lock', disposition: 'selected',
      sourceRefs: [{ uri: 'fixture:race' }], scopeChanges: [] };
    flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
      command: 'record_decision_suggestion', targetId: project.id, expectedRevision: project.revision, payload: { decision } }, () =>
      [decision, { ...project, revision: project.revision + 1, updatedAt: at, integration: { state: 'disabled', outstandingConditions: [] } }]);
    return body();
  });
  assert.throws(() => correction(flow), /disabled/);
  assert.equal(flow.store.records(projectId).some((record) => record.kind === 'observation' && record.correction), false);
});

test('review 1299-5: explicit replacement of an unattempted suspended correction retains recipient and queue identity', t => {
  const flow = setup(t); const queued = correction(flow);
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const old = flow.store.get(projectId, queued.correction.id); assert.ok(old?.kind === 'observation' && old.correction);
  const c = old.correction;
  const replacement = queueCorrection(flow.store, { schemaVersion: 1, id: 'replace', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'replace', command: 'deliver_correction', targetId: old.id, expectedRevision: old.revision,
    payload: { affectedRevision: c.affectedRevision, assignment: c.assignment, originalCorrection: c.originalText, action: c.action,
      sequence: c.sequence, supersedes: c.supersedes, sourceRefs: c.sourceRefs, readdress: true } });
  assert.equal(replacement.correction.id, old.id);
  assert.equal(replacement.correction.correction!.sequence, c.sequence);
  assert.notEqual(replacement.operation.id, queued.operation.id);
  const send = flow.executable('replacement-send.cjs', `require('node:fs').appendFileSync(${JSON.stringify(join(flow.home, 'replaced-sends'))},process.argv[3]+'\\n');`);
  const options = { fmHome: flow.home, sendExecutable: send, controlExecutable: send, recipients: [{ assignment: ref(assignment(flow)),
    attemptId: assignment(flow).attemptId, firstMateTaskId: assignment(flow).firstMateTaskId, state: 'active' as const, observedAt: new Date().toISOString() }] };
  assert.equal(deliverCorrection(flow.store, projectId, old.id, options).state, 'succeeded');
  deliverCorrection(flow.store, projectId, old.id, options);
  const sent = readFileSync(join(flow.home, 'replaced-sends'), 'utf8').trim().split('\n');
  assert.equal(sent.length, 1); assert.equal(JSON.parse(sent[0]!).corrections[0].originalText, c.originalText);
  const updated = flow.store.get(projectId, old.id); assert.ok(updated?.kind === 'observation');
  assert.equal(updated.correction!.deliveryHistory![0]!.operationId, queued.operation.id);
});

test('review 1299-6: absent worker return destination is not a retained backup artifact', t => {
  const flow = setup(t); const a = assignment(flow); const at = new Date().toISOString();
  const decision = { kind: 'decision_change', id: 'return-path', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
    questionOrChange: 'Set output destination', affectedRecords: [ref(a)], rationale: 'Future output', disposition: 'selected',
    sourceRefs: [{ uri: 'fixture:destination' }], scopeChanges: [] };
  const output = join(flow.home, 'future-worker-return.json');
  flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
    command: 'record_decision_suggestion', targetId: a.id, expectedRevision: a.revision, payload: { decision } }, () =>
    [decision, { ...a, revision: a.revision + 1, updatedAt: at, returnLocation: output }]);
  assert.equal(backupProject(flow.store, projectId, flow.home).artifacts.some((artifact) => artifact.path === output), false);
});

test('review 1299-7: supplying a missing file without a saved digest requests explicit verification', t => {
  const flow = setup(t, true); const path = join(flow.home, 'supplied.txt');
  captureRequest(flow.store, { projectId, clientRequestId: 'supplied', channel: 'cli', source: { uri: 'fixture:request' }, originalText: 'Source',
    attachments: [{ uri: path, revision: 'original-v1' }] });
  const bundle = backupProject(flow.store, projectId, flow.home); const restored = new ProjectStore(join(flow.home, 'verify.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home); writeFileSync(path, 'Supplied bytes');
    const result = reconcileProject(restored, projectId, flow.adapter);
    assert.ok('artifacts' in result && result.artifacts?.some((issue) => issue.path === path && String(issue.issue) === 'verification_required'));
    const digest = digestText('Supplied bytes');
    verifyRestoredArtifact(restored, { projectId, path, digest, evidence: [{ artifact: { uri: path, digest },
      description: 'Operator checked supplied bytes against retained source revision', observedAt: new Date().toISOString() }] });
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
    assert.ok(restored.history(projectId).some((record) => record.kind === 'project' && record.integration?.observation?.includes('verifiedSuppliedArtifact')));
  } finally { restored.close(); }
});

test('review 1299-8: successful restore retires its artifact gate before normal evidence regeneration', t => {
  const flow = setup(t, true); const path = join(flow.home, 'retained.txt'); writeFileSync(path, 'Original bytes');
  captureRequest(flow.store, { projectId, clientRequestId: 'retained', channel: 'cli', source: { uri: 'fixture:request' }, originalText: 'Source',
    attachments: [{ uri: path, revision: 'original-v1' }] });
  const bundle = backupProject(flow.store, projectId, flow.home); const restored = new ProjectStore(join(flow.home, 'retire.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home);
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
    writeFileSync(path, 'Regenerated after restore'); disableProject(restored, projectId, 'pause');
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
  } finally { restored.close(); }
});

test('review 1299-10: a reconciling project does not block unmanaged tasks in its FirstMate home', t => {
  const flow = setup(t); const broken = flow.executable('broken.cjs', "process.stdout.write('{}');");
  assert.throws(() => reconcileProject(flow.store, projectId, { ...flow.adapter, snapshotExecutable: broken }));
  assert.deepEqual(checkStartingWorker({ version: 1, projects: [{ home: flow.home, projectId, database: flow.database,
    agentConfig: join(flow.home, 'unused.json') }] }, { version: 1, event: 'worker.start.before', home: flow.home,
    task_id: 'unmanaged-task', source_brief_path: null, brief_path: null, brief_sha256: null }), { ok: true, managed: false });
});



test('review 1299-15: relative local attachments are bundled or disclosed as unresolved', t => {
  const flow = setup(t, true);
  captureRequest(flow.store, { projectId, clientRequestId: 'relative', channel: 'cli', source: { uri: 'fixture:request' },
    originalText: 'Keep this attachment', attachments: [{ uri: 'evidence/relative.txt', revision: 'v1' }] });
  const bundle = backupProject(flow.store, projectId);
  assert.ok('unresolvedReferences' in bundle && Array.isArray(bundle.unresolvedReferences) && bundle.unresolvedReferences.includes('evidence/relative.txt'));
});


test('review 1299-1: configured direct start reuses dispatch validation for pending corrections and hook removal', t => {
  const flow = setup(t); const hookRegistry = readyWorkerStart(flow);
  const executable = flow.executable('checked-start.cjs', `require('node:fs').writeFileSync(${JSON.stringify(join(flow.home, 'checked-started'))},'started');`);
  const input = { projectId, idempotencyKey: 'checked-start', assignment: ref(assignment(flow)), repository: flow.home,
    executable, hookRegistry, args: ['pilot-build', flow.home] };
  const queued = correction(flow);
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const old = flow.store.get(projectId, queued.correction.id); assert.ok(old?.kind === 'observation' && old.correction); const c = old.correction;
  queueCorrection(flow.store, { schemaVersion: 1, id: 'start-replace', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'start-replace', command: 'deliver_correction', targetId: old.id, expectedRevision: old.revision,
    payload: { affectedRevision: c.affectedRevision, assignment: c.assignment, originalCorrection: c.originalText, action: c.action,
      sequence: c.sequence, supersedes: c.supersedes, sourceRefs: c.sourceRefs, readdress: true } });
  const result = startManagedWorker(flow.store, input, { fmHome: flow.home, snapshotExecutable: flow.runtime.executable });
  assert.notEqual(result.state, 'succeeded'); assert.equal(existsSync(join(flow.home, 'checked-started')), false);
  flow.save('config/hooks.json', { version: 1, hooks: [] });
  const removed = startManagedWorker(flow.store, { ...input, idempotencyKey: 'missing-hook' }, { fmHome: flow.home, snapshotExecutable: flow.runtime.executable });
  assert.notEqual(removed.state, 'succeeded'); assert.match(removed.reconciliation!.note, /hook_not_configured/);
  assert.equal(existsSync(join(flow.home, 'checked-started')), false);
});

test('review 1299-5: a suspended ambiguous send is observed without resending before any replacement', t => {
  const flow = setup(t); const queued = correction(flow); const a = assignment(flow);
  const inbox = join(flow.home, 'state', 'pilot-build.inbox'); mkdirSync(inbox, { recursive: true });
  const send = flow.executable('ambiguous-send.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'ambiguous-sends'))},'sent\\n');
fs.writeFileSync(${JSON.stringify(join(inbox, '001.msg'))},'schema=fm-task-inbox.v1\\nbody-terminator=1\\n--\\n'+process.argv[3]+'\\n');process.exit(2);`);
  const options: CorrectionAdapterOptions = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable, sendExecutable: send, controlExecutable: send,
    recipients: [{ assignment: ref(a), attemptId: a.attemptId, firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const old = flow.store.get(projectId, queued.correction.id); assert.ok(old?.kind === 'observation' && old.correction); const c = old.correction;
  assert.throws(() => queueCorrection(flow.store, { schemaVersion: 1, id: 'unsafe-replace', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'unsafe-replace', command: 'deliver_correction', targetId: old.id, expectedRevision: old.revision,
    payload: { affectedRevision: c.affectedRevision, assignment: c.assignment, originalCorrection: c.originalText, action: c.action,
      sequence: c.sequence, supersedes: c.supersedes, sourceRefs: c.sourceRefs, readdress: true } }), /outcome_must_be_resolved/);
  assert.equal(deliverCorrection(flow.store, projectId, old.id, options).state, 'succeeded');
  assert.equal(readFileSync(join(flow.home, 'ambiguous-sends'), 'utf8'), 'sent\n');
});

test('review 1299-14: legacy import discloses unstructured omissions and maps only trustworthy IDs', t => {
  const flow = setup(t, true);
  const snapshot = flow.executable('legacy-snapshot.cjs', `process.stdout.write(JSON.stringify({schema:'fm-fleet-snapshot.v1',generated:new Date().toISOString(),
fm_home:${JSON.stringify(flow.home)},backlog:{present:true,records:[{id:'old',structured:true,state:'done'},{id:null,structured:false,raw:'legacy note'}]},tasks:[]}));`);
  const result = importLegacyTasks(flow.store, projectId, { fmHome: flow.home, snapshotExecutable: snapshot });
  assert.equal(result.mappings.length, 1); assert.equal(result.omissions.length, 1);
  assert.equal(result.mappings[0]!.firstMateTaskId, 'old');
  assert.equal(JSON.parse(JSON.stringify(result)).omissions[0].raw, 'legacy note');
});

test('review 1299-15: relative sources use the backup recorded base, while unresolved sources keep restore gated', t => {
  const flow = setup(t, true); const path = join(flow.home, 'relative-evidence.txt'); writeFileSync(path, 'Relative evidence');
  captureRequest(flow.store, { projectId, clientRequestId: 'relative-base', channel: 'cli', source: { uri: 'fixture:request' },
    originalText: 'Retain relative evidence', attachments: [{ uri: 'relative-evidence.txt', revision: 'v1' }] });
  const unresolved = backupProject(flow.store, projectId);
  const gated = new ProjectStore(join(flow.home, 'relative-unresolved.sqlite'));
  try {
    const restored = restoreProjectBackup(gated, unresolved, flow.home);
    assert.ok(restored.artifacts.some((issue) => issue.path === 'relative-evidence.txt' && issue.issue === 'unresolved_reference'));
    assert.equal(reconcileProject(gated, projectId, flow.adapter).state, 'reconciling');
  } finally { gated.close(); }
  const resolved = backupProject(flow.store, projectId, flow.home); assert.deepEqual(resolved.unresolvedReferences, []);
  assert.equal(resolved.artifactBase, flow.home); rmSync(path);
  const restored = new ProjectStore(join(flow.home, 'relative-restored.sqlite'));
  try {
    restoreProjectBackup(restored, resolved, flow.home); assert.equal(readFileSync(path, 'utf8'), 'Relative evidence');
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
  } finally { restored.close(); }
});

test('review 1299-5: transport replacement cannot authorize a task-producing correction again', t => {
  const flow = setup(t); const a = assignment(flow);
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'task-producing', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'task-producing', command: 'deliver_correction', targetId: 'task-producing', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Create the separately planned work', action: 'new_work',
      sequence: 1, supersedes: [], taskCommand: taskCommand('extra-work') } });
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const old = flow.store.get(projectId, queued.correction.id); assert.ok(old?.kind === 'observation' && old.correction); const c = old.correction;
  assert.throws(() => queueCorrection(flow.store, { schemaVersion: 1, id: 'replaced-task-producing', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'replaced-task-producing', command: 'deliver_correction', targetId: old.id, expectedRevision: old.revision,
    payload: { affectedRevision: c.affectedRevision, assignment: c.assignment, originalCorrection: c.originalText, action: c.action,
      sequence: c.sequence, supersedes: c.supersedes, sourceRefs: c.sourceRefs, readdress: true, taskCommand: taskCommand('different-extra-work') } }),
    /suspended_delivery_outcome/);
});

// Review 1321: these regressions are added before the assigned fixes.
test('review 1321-2: FirstMate alive/dead observations are independent of endpoint presence', async () => {
  const { FleetSnapshotSchema, endpointAlive } = await import('../src/index.js');
  const now = new Date().toISOString();
  const snapshot = FleetSnapshotSchema.parse({ schema: 'fm-fleet-snapshot.v1', generated: now, fm_home: '/fake',
    backlog: { present: true, records: [] }, tasks: [{ id: 'task', spawn_gen: 'gen', project: '/fake',
      current_state: { state: 'failed', observed_at: now, freshness: 'fresh' },
      endpoint: { target: 'terminal', exists: true, agent_alive: 'alive', status: 'alive', observed_at: now, freshness: 'fresh' } }] });
  assert.equal(endpointAlive(snapshot, 'task'), true);
  snapshot.tasks[0]!.endpoint = { target: 'terminal', exists: true, agent_alive: 'dead', status: 'dead', observed_at: now, freshness: 'fresh' };
  assert.equal(endpointAlive(snapshot, 'task'), false);
  for (const state of ['unknown', 'not_checked'] as const) {
    snapshot.tasks[0]!.endpoint = { exists: false, agent_alive: state, status: 'absent', observed_at: now, freshness: 'fresh' };
    assert.equal(endpointAlive(snapshot, 'task'), undefined);
  }
});

test('review 1321-3: interrupt delivery without its own cancellation acknowledgement remains unknown', t => {
  const flow = setup(t); const a = assignment(flow);
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'interrupt-unconfirmed', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'interrupt-unconfirmed', command: 'deliver_correction', targetId: 'interrupt-unconfirmed', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Interrupt this turn', action: 'clarification', urgentStop: true,
      sequence: 1, supersedes: [] } });
  flow.runtime.save([{ id: a.firstMateTaskId, spawn_gen: 'interrupt-generation', project: flow.home,
    endpoint: { exists: true, agent_alive: 'alive', freshness: 'fresh', observed_at: '' },
    current_state: { state: 'active', freshness: 'fresh', observed_at: '' } }]);
  const control = flow.executable('interrupt-unconfirmed.cjs', `require('node:fs').appendFileSync(${JSON.stringify(join(flow.home, 'interrupts'))},'interrupt\\n');
process.stdout.write('interrupt-delivered pilot-build harness=codex backend=tmux verified=agent-alive cancel=unconfirmed\\n');`);
  const options: CorrectionAdapterOptions = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable,
    sendExecutable: control, controlExecutable: control, recipients: [{ assignment: ref(a), attemptId: a.attemptId,
      firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
  assert.equal(readFileSync(join(flow.home, 'interrupts'), 'utf8'), 'interrupt\n');
});

for (const action of ['cancellation', 'new_work'] as const) for (const afterTask of [false, true]) {
  test(`review 1321-4: explicit recovery of suspended ${action} (${afterTask ? 'after' : 'before'} task effect) retains identities`, t => {
    const flow = setup(t); const a = assignment(flow);
    flow.tasks.edit((state) => { state.tasks[a.firstMateTaskId] = fakeTask(a.firstMateTaskId); });
    const task = taskCommand(action === 'new_work' ? 'recovered-work' : a.firstMateTaskId, action === 'new_work' ? 'create' : 'cancel');
    if (action === 'cancellation') { task.targetId = 'mapping-1'; task.expectedRevision = 1; }
    const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'task-recovery', projectId, issuedAt: new Date().toISOString(),
      idempotencyKey: 'task-recovery', command: 'deliver_correction', targetId: 'task-recovery', expectedRevision: 0,
      payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Apply the original planned task action', action,
        sequence: 1, supersedes: [], taskCommand: task } });
    if (afterTask) {
      flow.tasks.edit((state) => { state.failure = { action: action === 'new_work' ? 'add' : 'hold', when: 'after' }; });
      assert.equal(manageExecutionTask(flow.store, task, flow.adapter).operation.state, 'unknown');
    }
    disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
    const control = flow.executable('recovery-no-control.cjs', 'throw new Error("queued tasks do not invoke control");');
    const options: CorrectionAdapterOptions = { fmHome: flow.home, sendExecutable: control, controlExecutable: control, taskAdapter: flow.adapter,
      recipients: [{ assignment: ref(a), attemptId: a.attemptId, firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
    const request = { projectId, correctionId: queued.correction.id, idempotencyKey: 'explicit-task-recovery' };
    if (action === 'new_work' && !afterTask) {
      const result = spawnSync(process.execPath, [cli, 'recover-task-correction', '--db', flow.database,
        '--input', flow.save('recover-task.json', request), '--adapter-config', flow.save('recover-task-adapter.json', options)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).state, 'succeeded');
    } else assert.equal(recoverTaskCorrection(flow.store, request, options).state, 'succeeded');
    assert.equal(recoverTaskCorrection(flow.store, request, options).state, 'succeeded');
    const saved = flow.store.get(projectId, queued.correction.id); assert.ok(saved?.kind === 'observation' && saved.correction);
    assert.equal(saved.correction.operationId, queued.operation.id);
    assert.ok(saved.correction.facts.some((fact) => fact.fact === 'delivered'));
    const effect = action === 'new_work' ? 'add' : 'hold';
    assert.equal(flow.tasks.read().calls.filter((call) => call.args[0] === effect && call.args[1] !== '--help').length, 1);
  });
}

test('review 1321-9: orphaned runtime inventory cannot hide exact durable steering delivery', t => {
  const flow = setup(t); const queued = correction(flow); const a = assignment(flow);
  const inbox = join(flow.home, 'state', 'pilot-build.inbox'); mkdirSync(inbox, { recursive: true });
  const send = flow.executable('orphan-send.cjs', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(flow.home, 'orphan-sends'))},'send\\n');
fs.writeFileSync(${JSON.stringify(join(inbox, '001.msg'))},'schema=fm-task-inbox.v1\\nbody-terminator=1\\n--\\n'+process.argv[3]+'\\n');process.exit(2);`);
  const snapshot = flow.executable('orphan-snapshot.cjs', `process.stdout.write(JSON.stringify({schema:'fm-fleet-snapshot.v1',generated:new Date().toISOString(),fm_home:${JSON.stringify(flow.home)},
backlog:{present:true,records:[{id:'pilot-build',state:'in_flight'}]},tasks:[],main_inventory:{valid:false,orphan_in_flight:['pilot-build']}}));`);
  const options: CorrectionAdapterOptions = { fmHome: flow.home, snapshotExecutable: snapshot, sendExecutable: send, controlExecutable: send,
    recipients: [{ assignment: ref(a), attemptId: a.attemptId, firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'succeeded');
  assert.equal(readFileSync(join(flow.home, 'orphan-sends'), 'utf8'), 'send\n');
});

test('review 1321-11: explicit reference resolution releases an imported unresolved-reference gate with verified bytes', t => {
  const flow = setup(t, true); const file = join(flow.home, 'resolvable.txt'); writeFileSync(file, 'Resolved source bytes');
  captureRequest(flow.store, { projectId, clientRequestId: 'resolve', channel: 'cli', source: { uri: 'fixture:request' }, originalText: 'Retain source',
    attachments: [{ uri: 'resolvable.txt', revision: 'original' }] });
  const bundle = backupProject(flow.store, projectId); const restored = new ProjectStore(join(flow.home, 'resolved-reference.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home); assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'reconciling');
    for (const reference of bundle.unresolvedReferences) {
      const digest = digestText(readFileSync(join(flow.home, reference), 'utf8'));
      const input = { projectId, reference, base: flow.home, digest,
        evidence: [{ artifact: { uri: join(flow.home, reference), digest }, description: 'Operator verified recovered source against the retained revision', observedAt: new Date().toISOString() }] };
      assert.throws(() => resolveRestoredReference(restored, { ...input, digest: digestText('wrong bytes') }), /digest_mismatch/);
      if (reference === 'resolvable.txt') {
        const result = spawnSync(process.execPath, [cli, 'resolve-restored-reference', '--db', join(flow.home, 'resolved-reference.sqlite'),
          '--input', flow.save('resolve-reference.json', input)], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).path, file);
      } else resolveRestoredReference(restored, input);
    }
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
  } finally { restored.close(); }
});

test('review 1321-4: retiring explicit recovery permission before the child task lock prevents late replay', t => {
  const flow = setup(t); const a = assignment(flow); const task = taskCommand('permission-work');
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'permission-correction', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'permission-correction', command: 'deliver_correction', targetId: 'permission-correction', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Do the original task', action: 'new_work',
      sequence: 1, supersedes: [], taskCommand: task } });
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const lock = flow.store.withTaskLock.bind(flow.store); let calls = 0;
  flow.store.withTaskLock = (id, body) => lock(id, () => {
    if (++calls === 2) {
      const permit = flow.store.get(projectId, stableId('task-correction-recovery', projectId, 'permission-recovery'));
      assert.ok(permit?.kind === 'operation');
      const at = new Date().toISOString();
      const decision = { kind: 'decision_change', id: 'retired-recovery', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
        questionOrChange: 'Recovery was disabled and integration re-enabled before child lock', affectedRecords: [ref(permit)], rationale: 'Retire the existing explicit permission',
        disposition: 'selected', sourceRefs: [{ uri: 'fixture:retirement' }], scopeChanges: [] };
      flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
        command: 'record_decision_suggestion', targetId: permit.id, expectedRevision: permit.revision, payload: { decision } }, () =>
        [decision, { ...permit, revision: permit.revision + 1, updatedAt: at, suspended: { at, reason: 'Disabled before child execution' } }]);
    }
    return body();
  });
  const executable = flow.executable('unused-permission.cjs', 'throw new Error("not a steering action");');
  assert.throws(() => recoverTaskCorrection(flow.store, { projectId, correctionId: queued.correction.id, idempotencyKey: 'permission-recovery' },
    { fmHome: flow.home, sendExecutable: executable, controlExecutable: executable, taskAdapter: flow.adapter, recipients: [] }), /permanently_suspended/);
  assert.equal(flow.tasks.read().tasks['permission-work'], undefined);
});


test('review 1321-3: the control acknowledgement confirms interruption while its agent remains alive, even after a nonzero exit', t => {
  const flow = setup(t); const a = assignment(flow);
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'acknowledged-interrupt', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'acknowledged-interrupt', command: 'deliver_correction', targetId: 'acknowledged-interrupt', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Interrupt this turn', action: 'clarification', urgentStop: true,
      sequence: 1, supersedes: [] } });
  flow.runtime.save([{ id: a.firstMateTaskId, spawn_gen: 'ack-generation', project: flow.home,
    endpoint: { exists: true, agent_alive: 'alive', freshness: 'fresh', observed_at: '' }, current_state: { state: 'active', freshness: 'fresh', observed_at: '' } }]);
  const control = flow.executable('acknowledged-interrupt.cjs', `require('node:fs').appendFileSync(${JSON.stringify(join(flow.home, 'ack-interrupts'))},'interrupt\\n');
process.stdout.write('interrupt-delivered pilot-build harness=codex backend=tmux verified=agent-alive cancel=confirmed\\n');process.exitCode=2;`);
  const options: CorrectionAdapterOptions = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable, sendExecutable: control, controlExecutable: control,
    recipients: [{ assignment: ref(a), attemptId: a.attemptId, firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'succeeded');
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'succeeded');
  assert.equal(readFileSync(join(flow.home, 'ack-interrupts'), 'utf8'), 'interrupt\n');
});

test('review 1321-3: a lost interruption response leaves the live agent and unknown outcome without repeating the interrupt', t => {
  const flow = setup(t); const a = assignment(flow);
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'lost-interrupt', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'lost-interrupt', command: 'deliver_correction', targetId: 'lost-interrupt', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Interrupt the current turn', action: 'clarification', urgentStop: true,
      sequence: 1, supersedes: [] } });
  flow.runtime.save([{ id: a.firstMateTaskId, spawn_gen: 'lost-ack-generation', project: flow.home,
    endpoint: { exists: true, agent_alive: 'alive', freshness: 'fresh', observed_at: '' }, current_state: { state: 'active', freshness: 'fresh', observed_at: '' } }]);
  const control = flow.executable('lost-interrupt.cjs', `require('node:fs').appendFileSync(${JSON.stringify(join(flow.home, 'lost-interrupts'))},'interrupt\\n');
process.stdout.write('interrupt-delivered pilot-build harness=codex backend=tmux verified=agent-alive cancel=confirmed\\n');process.kill(process.ppid,'SIGKILL');`);
  const options: CorrectionAdapterOptions = { fmHome: flow.home, snapshotExecutable: flow.runtime.executable, sendExecutable: control, controlExecutable: control,
    recipients: [{ assignment: ref(a), attemptId: a.attemptId, firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
  const result = spawnSync(process.execPath, [cli, 'deliver-correction', '--db', flow.database, '--project', projectId,
    '--correction', queued.correction.id, '--adapter-config', flow.save('lost-interrupt-adapter.json', options)], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr); flow.reopen();
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
  assert.equal(readFileSync(join(flow.home, 'lost-interrupts'), 'utf8'), 'interrupt\n');
});

test('review 1321-4: a suspended failed task correction can recover explicitly once the wrapper is available', t => {
  const flow = setup(t); const a = assignment(flow); const task = taskCommand('failed-task-recovery');
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'failed-task-correction', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'failed-task-correction', command: 'deliver_correction', targetId: 'failed-task-correction', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Create the planned task', action: 'new_work',
      sequence: 1, supersedes: [], taskCommand: task } });
  const unused = flow.executable('unused-failed-task.cjs', 'throw new Error("task action only");');
  const options: CorrectionAdapterOptions = { fmHome: flow.home, sendExecutable: unused, controlExecutable: unused,
    taskAdapter: { ...flow.adapter, tasksExecutable: join(flow.home, 'wrapper-not-installed') }, recipients: [] };
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'failed');
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const request = { projectId, correctionId: queued.correction.id, idempotencyKey: 'failed-task-explicit-recovery' };
  assert.equal(recoverTaskCorrection(flow.store, request, { ...options, taskAdapter: flow.adapter }).state, 'succeeded');
  assert.equal(recoverTaskCorrection(flow.store, request, { ...options, taskAdapter: flow.adapter }).state, 'succeeded');
  assert.equal(flow.tasks.read().calls.filter((call) => call.args[0] === 'add' && call.args[1] !== '--help').length, 1);
});

// Review 1342: regressions added before changing artifact resolution.
for (const digestLocation of ['history', 'receipt'] as const) test(`review 1342-3: resolution preserves a digest retained only in ${digestLocation}`, t => {
  const flow = setup(t, true); const reference = 'retained-identity.txt'; const path = join(flow.home, reference);
  const original = 'Original retained bytes'; const changed = 'Different recovered bytes'; const digest = digestText(original);
  writeFileSync(path, original);
  const captured = captureRequest(flow.store, { projectId, clientRequestId: 'retained-identity', channel: 'cli', source: { uri: 'fixture:source' },
    originalText: 'Preserve the attachment identity', attachments: [{ uri: reference, revision: 'source-v1', digest }] });
  // Historical imports may retain the content identity in only one of these
  // sources. Both are durable evidence, irrespective of the caller's new input.
  const exported = flow.store.exportProject(projectId);
  const request = exported.history.find((record) => record.id === captured.request.id); assert.ok(request?.kind === 'request');
  const receipt = exported.receipts.find((entry) => entry.command.command === 'capture_request');
  assert.ok(receipt?.command.command === 'capture_request');
  const withoutDigest = (artifact: (typeof request.attachments)[number]) => {
    const { digest: _digest, ...retained } = artifact; return retained;
  };
  if (digestLocation === 'receipt') request.attachments = request.attachments.map(withoutDigest);
  else {
    receipt.command.payload.attachments = receipt.command.payload.attachments.map(withoutDigest);
    for (const record of exported.history) if (record.kind === 'operation' && record.idempotencyKey === receipt.command.idempotencyKey) {
      record.payloadDigest = commandDigest(receipt.command);
    }
  }
  const source = new ProjectStore(join(flow.home, 'identity-source.sqlite'));
  let bundle;
  try { source.importProject(exported); bundle = backupProject(source, projectId); } finally { source.close(); }
  const restored = new ProjectStore(join(flow.home, 'identity-restored.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home); writeFileSync(path, changed);
    const input = { projectId, reference, base: flow.home, digest: digestText(changed), evidence: [{
      artifact: { uri: path, digest: digestText(changed) }, description: 'Operator supplied recovered bytes', observedAt: new Date().toISOString() }] };
    assert.throws(() => resolveRestoredReference(restored, input), /recorded_digest_mismatch/);
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'reconciling');
    assert.throws(() => resolveRestoredReference(restored, { ...input, digest }), /digest_mismatch/);
    writeFileSync(path, original);
    resolveRestoredReference(restored, { ...input, digest, evidence: [{ artifact: { uri: path, digest },
      description: 'Recovered bytes match the retained identity', observedAt: new Date().toISOString() }] });
    for (const other of bundle.unresolvedReferences.filter((entry) => entry !== reference)) {
      const otherPath = join(flow.home, other); const otherDigest = digestText(readFileSync(otherPath, 'utf8'));
      resolveRestoredReference(restored, { projectId, reference: other, base: flow.home, digest: otherDigest,
        evidence: [{ artifact: { uri: otherPath, digest: otherDigest }, description: 'Verified remaining local source', observedAt: new Date().toISOString() }] });
    }
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
  } finally { restored.close(); }
});

test('review 1342-5: relative repository directories resolve through exclusion without a file hash', t => {
  const flow = setup(t, true); const reference = 'repository'; const directory = join(flow.home, reference); mkdirSync(directory);
  const project = flow.store.get(projectId, projectId); assert.ok(project?.kind === 'project'); const at = new Date().toISOString();
  const decision = { kind: 'decision_change', id: 'repository-reference', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
    questionOrChange: 'Record project repository', affectedRecords: [ref(project)], rationale: 'Repository source reference', disposition: 'selected',
    sourceRefs: [{ uri: 'fixture:repository' }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
    command: 'record_decision_suggestion', targetId: project.id, expectedRevision: project.revision, payload: { decision } }, () =>
    [decision, { ...project, revision: project.revision + 1, updatedAt: at, repositories: [{ uri: reference }] }]);
  const bundle = backupProject(flow.store, projectId); const restored = new ProjectStore(join(flow.home, 'directory-restored.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home);
    const resolution = { projectId, reference, base: flow.home,
      evidence: [{ artifact: { uri: directory, revision: 'repository-present' }, description: 'Verified repository directory; excluded from file backup', observedAt: at }] };
    const resolved = spawnSync(process.execPath, [cli, 'resolve-restored-reference', '--db', join(flow.home, 'directory-restored.sqlite'),
      '--input', flow.save('directory-resolution.json', resolution)], { encoding: 'utf8' });
    assert.equal(resolved.status, 0, resolved.stderr);
    for (const other of bundle.unresolvedReferences.filter((entry) => entry !== reference)) {
      const path = join(flow.home, other); const digest = digestText(readFileSync(path, 'utf8'));
      resolveRestoredReference(restored, { projectId, reference: other, base: flow.home, digest,
        evidence: [{ artifact: { uri: path, digest }, description: 'Verified remaining local source', observedAt: at }] });
    }
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
    const next = backupProject(restored, projectId);
    assert.ok(next.excludedDirectories.includes(directory));
    assert.equal(next.artifacts.some((artifact) => artifact.path === directory), false);
  } finally { restored.close(); }
});


test('review 1342-5: directory exclusion cannot discard a retained file digest', t => {
  const flow = setup(t, true); const reference = 'file-replaced-by-directory'; const path = join(flow.home, reference); mkdirSync(path);
  const digest = digestText('Retained file content');
  captureRequest(flow.store, { projectId, clientRequestId: 'file-directory-conflict', channel: 'cli', source: { uri: 'fixture:source' },
    originalText: 'Retain file content', attachments: [{ uri: reference, digest }] });
  const bundle = backupProject(flow.store, projectId); const restored = new ProjectStore(join(flow.home, 'directory-identity-conflict.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home);
    const input = { projectId, reference, base: flow.home, evidence: [{ artifact: { uri: path, revision: 'directory-present' },
      description: 'Directory presence cannot replace retained file bytes', observedAt: new Date().toISOString() }] };
    assert.throws(() => resolveRestoredReference(restored, input), /recorded_digest_mismatch/);
    assert.throws(() => resolveRestoredReference(restored, { ...input, digest }), /directory_has_file_digest/);
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'reconciling');
  } finally { restored.close(); }
});

test('review 1356: restore verifies two adopted memory sections independently of the whole file', t => {
  const flow = setup(t, true); const reference = 'memory.md'; const path = join(flow.home, reference);
  const original = '# Project memory\n\nUnrelated introduction.\n\n## First adopted rule\nFirst retained rule.\n\n### Detail\nRetained nested detail.\n\n## Second adopted rule\nSecond retained rule.\n\n## Other content\nUnrelated notes.\n';
  writeFileSync(path, original);
  // Capture actual standing-instruction adoptions in a scratch source context;
  // the persisted section URIs remain relative, with no recorded artifact base.
  const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { ProjectStore, captureLearning, readLegacySection } from ${JSON.stringify(fileURLToPath(new URL('../src/index.js', import.meta.url)))};
const store = new ProjectStore(${JSON.stringify(flow.database)});
try {
  for (const [index, heading] of ['## First adopted rule', '## Second adopted rule'].entries()) {
    const at = new Date().toISOString();
    captureLearning(store, { projectId: 'project-1', id: 'memory-adoption-' + index, idempotencyKey: 'memory-adoption-' + index, issuedAt: at,
      identity: { scope: { kind: 'project' }, topic: 'memory-rule-' + index }, finding: 'Adopt this retained instruction ' + index,
      inputKind: 'standing_instruction', captureReason: 'direct', legacySections: [readLegacySection('memory.md', heading)],
      evidence: [{ artifact: { uri: 'memory.md', revision: 'source-v1' }, description: 'Existing memory section', observedAt: at }] });
  }
} finally { store.close(); }
`], { cwd: flow.home, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const bundle = backupProject(flow.store, projectId);
  assert.equal(bundle.project.history.filter((record) => record.kind === 'guidance_revision').flatMap((record) =>
    record.kind === 'guidance_revision' ? record.legacyReplacements ?? [] : []).length, 2);
  rmSync(path);
  for (const [name, text, valid] of [
    ['intact', original, true],
    ['unrelated', original.replace('Unrelated notes.', 'Updated unrelated notes.'), true],
    ['first-changed', original.replace('First retained rule.', 'Wrong first rule.'), false],
    ['second-changed', original.replace('Second retained rule.', 'Wrong second rule.'), false],
    ['heading-missing', original.replace('## Second adopted rule', '## Different heading'), false],
  ] as const) {
    const restored = new ProjectStore(join(flow.home, `${name}-memory-restore.sqlite`));
    try {
      restoreProjectBackup(restored, bundle, flow.home); writeFileSync(path, text);
      const digest = digestText(text);
      const input = { projectId, reference, base: flow.home, digest,
        evidence: [{ artifact: { uri: path, digest }, description: 'Recovered whole memory file', observedAt: new Date().toISOString() }] };
      if (!valid) {
        assert.throws(() => resolveRestoredReference(restored, input), /section_digest_mismatch/);
      } else {
        resolveRestoredReference(restored, input);
        for (const other of bundle.unresolvedReferences.filter((entry) => entry !== reference)) {
          const otherPath = join(flow.home, other); const otherDigest = digestText(readFileSync(otherPath, 'utf8'));
          resolveRestoredReference(restored, { projectId, reference: other, base: flow.home, digest: otherDigest,
            evidence: [{ artifact: { uri: otherPath, digest: otherDigest }, description: 'Verified remaining source', observedAt: new Date().toISOString() }] });
        }
        assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
      }
    } finally { restored.close(); }
  }
  writeFileSync(path, original);
  const based = backupProject(flow.store, projectId, flow.home);
  assert.equal(based.artifacts.find((artifact) => artifact.path === path)?.issue, undefined);
  const basedRestore = new ProjectStore(join(flow.home, 'based-memory-restore.sqlite'));
  try {
    restoreProjectBackup(basedRestore, based, flow.home);
    assert.equal(reconcileProject(basedRestore, projectId, flow.adapter).state, 'enabled');
  } finally { basedRestore.close(); }
  writeFileSync(path, original.replace('First retained rule.', 'Wrong first rule.'));
  const changed = backupProject(flow.store, projectId, flow.home);
  assert.ok(changed.artifacts.some((artifact) => artifact.path === path && artifact.issue === 'changed'));
  const changedRestore = new ProjectStore(join(flow.home, 'changed-memory-restore.sqlite'));
  try {
    assert.ok(restoreProjectBackup(changedRestore, changed, flow.home).artifacts.some((artifact) => artifact.path === path && artifact.issue === 'changed'));
    assert.equal(reconcileProject(changedRestore, projectId, flow.adapter).state, 'reconciling');
    writeFileSync(path, original);
    const digest = digestText(original);
    verifyRestoredArtifact(changedRestore, { projectId, path, digest, evidence: [{ artifact: { uri: path, digest },
      description: 'Repaired sections match retained adoptions', observedAt: new Date().toISOString() }] });
    assert.equal(reconcileProject(changedRestore, projectId, flow.adapter).state, 'enabled');
  } finally { changedRestore.close(); }
});

for (const scenario of [
  { name: 'changed section re-adoption', before: '# Memory\n\n## Rule\nOld advice.\n\n## Notes\nOther content.\n',
    after: '# Memory\n\n## Rule\nUpdated advice.\n\n## Notes\nOther content.\n', oldHeadings: ['## Rule'], heading: '## Rule' },
  { name: 'replacement by a covering parent', before: '# Memory\n\n## Parent\nOld parent.\n\n### Child\nOld child.\n\n## Notes\nOther content.\n',
    after: '# Memory\n\n## Parent\nReplacement parent without the child heading.\n\n## Notes\nOther content.\n', oldHeadings: ['## Parent', '### Child'], heading: '## Parent' },
]) test(`review 1370-3: ${scenario.name} restores using current covering adoption`, t => {
  const flow = setup(t, true); const reference = 'memory.md'; const path = join(flow.home, reference);
  const config = flow.save('adoption-scenario.json', scenario);
  const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { readFileSync, writeFileSync } from 'node:fs';
import { ProjectStore, captureLearning, readLegacySection, ref } from ${JSON.stringify(fileURLToPath(new URL('../src/index.js', import.meta.url)))};
const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
const store = new ProjectStore(${JSON.stringify(flow.database)});
const capture = (id, headings, supersedes) => {
  const at = new Date().toISOString();
  return captureLearning(store, { projectId: 'project-1', id, idempotencyKey: id, issuedAt: at,
    identity: { scope: { kind: 'project' }, topic: 'memory-policy' }, finding: id + ' explicit policy',
    inputKind: 'standing_instruction', captureReason: 'direct', supersedes,
    legacySections: headings.map(heading => readLegacySection('memory.md', heading)),
    evidence: [{ artifact: { uri: 'memory.md', revision: id }, description: 'Standing memory policy', observedAt: at }] });
};
try {
  writeFileSync('memory.md', config.before); capture('adopt-old', config.oldHeadings, []);
  writeFileSync('memory.md', config.after); capture('adopt-new', [config.heading], [ref(store.get('project-1', 'adopt-old:guidance'))]);
} finally { store.close(); }
`], { cwd: flow.home, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const bundle = backupProject(flow.store, projectId); rmSync(path);
  const restored = new ProjectStore(join(flow.home, 'current-adoption.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home); writeFileSync(path, scenario.after);
    for (const unresolved of bundle.unresolvedReferences) {
      const source = join(flow.home, unresolved); const digest = digestText(readFileSync(source, 'utf8'));
      resolveRestoredReference(restored, { projectId, reference: unresolved, base: flow.home, digest,
        evidence: [{ artifact: { uri: source, digest }, description: 'Current recovered memory source', observedAt: new Date().toISOString() }] });
    }
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
    const learningHistory = (records: ReturnType<ProjectStore['history']>) => records.filter((record) =>
      record.kind === 'observation' || record.kind === 'guidance_revision');
    assert.deepEqual(learningHistory(restored.history(projectId)), learningHistory(bundle.project.history));
  } finally { restored.close(); }
  const based = backupProject(flow.store, projectId, flow.home);
  assert.equal(based.artifacts.some((artifact) => artifact.path === path && artifact.issue === 'changed'), false);
  const basedRestore = new ProjectStore(join(flow.home, 'current-adoption-with-base.sqlite'));
  try {
    restoreProjectBackup(basedRestore, based, flow.home);
    assert.equal(reconcileProject(basedRestore, projectId, flow.adapter).state, 'enabled');
  } finally { basedRestore.close(); }
});


test('review 1299-11: a second backup preserves the original disabled restore disposition', t => {
  const flow = setup(t, true); disableProject(flow.store, projectId, 'pause');
  const first = new ProjectStore(join(flow.home, 'first-restore.sqlite'));
  const second = new ProjectStore(join(flow.home, 'second-restore.sqlite'));
  try {
    restoreProjectBackup(first, backupProject(flow.store, projectId, flow.home), flow.home);
    restoreProjectBackup(second, backupProject(first, projectId, flow.home), flow.home);
    assert.equal(reconcileProject(second, projectId, flow.adapter, false).state, 'disabled');
  } finally { first.close(); second.close(); }
});

test('review 1299-13: restoring the same backup resumes artifact writes after the import commits', t => {
  const flow = setup(t, true); const path = join(flow.home, 'restore-source.txt'); writeFileSync(path, 'Frozen bytes');
  captureRequest(flow.store, { projectId, clientRequestId: 'resume-restore', channel: 'cli', source: { uri: 'fixture:source' },
    originalText: 'Retain source', attachments: [{ uri: path, revision: 'v1' }] });
  const bundle = backupProject(flow.store, projectId, flow.home); rmSync(path);
  const restored = new ProjectStore(join(flow.home, 'resumable-restore.sqlite'));
  const importProject = restored.importProject.bind(restored);
  restored.importProject = (...args) => { importProject(...args); throw new Error('interrupted after import'); };
  try {
    assert.throws(() => restoreProjectBackup(restored, bundle, flow.home), /interrupted after import/);
    restored.importProject = importProject;
    assert.throws(() => restoreProjectBackup(restored, { ...bundle, exportedAt: '2026-01-01T00:00:00.000Z' }, flow.home), /import_requires_empty_store/);
    const committed = restored.history(projectId);
    restoreProjectBackup(restored, bundle, flow.home);
    assert.equal(readFileSync(path, 'utf8'), 'Frozen bytes');
    assert.deepEqual(restored.history(projectId), committed);
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
  } finally { restored.close(); }
});

for (const changed of ['registry', 'settings'] as const) test(`review 1321-10: worker start revalidates ${changed} after judgment`, t => {
  const flow = setup(t); const registry = readyWorkerStart(flow);
  const target = changed === 'registry' ? registry : join(flow.home, 'config', 'hooks.json');
  const judge = flow.executable('mutating-judge.mjs', `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(target)}, JSON.stringify(${changed === 'registry' ? "{version:1,projects:[]}" : "{version:1,hooks:[]}"}));
await import(${JSON.stringify(new URL('../../fixtures/fake-instruction-judge.mjs', import.meta.url).href)});`);
  flow.save('launch-agents.json', { ...fakeJudge, executables: { codex: judge, claude: judge } });
  assert.throws(() => checkConfiguredWorkerStart(flow.store, projectId, 'pilot-build', flow.home, registry, assignment(flow).brief!.path), /configuration_changed/);
});

test('review 1299-9: handback removes a guard whose installation lost its response', t => {
  const flow = setup(t);
  flow.tasks.edit(state => { state.tasks['interrupted-guard'] = fakeTask('interrupted-guard', {
    hold: { reason: 'Owner hold', kind: 'captain', until: null } }); state.failure = { action: 'block', when: 'after' }; });
  const task = taskCommand('interrupted-guard', 'map');
  const adapter = { ...flow.adapter, guardTaskId: 'permanent-guard' };
  const result = manageExecutionTask(flow.store, { ...task, payload: { ...task.payload,
    readiness: [{ id: 'pending-check', reason: 'Pending product check', evidence: [] }] } }, adapter);
  assert.equal(result.operation.state, 'unknown');
  disableProject(flow.store, projectId, 'hand_back', adapter);
  assert.deepEqual(flow.tasks.read().tasks['interrupted-guard']!.deps, []);
  assert.equal(flow.tasks.read().tasks['interrupted-guard']!.hold?.reason, 'Owner hold');
});

for (const kind of ['inferred', 'operational'] as const) test(`review 1391-2: backup retains pending ${kind} section identities`, t => {
  const flow = setup(t, true); const path = join(flow.home, 'pending-memory.md');
  const original = '## Pending\nKeep pending source.\n'; writeFileSync(path, original);
  captureLearning(flow.store, { projectId, id: 'pending-memory', idempotencyKey: 'pending-memory', issuedAt: new Date().toISOString(),
    identity: { scope: { kind: 'project' }, topic: 'pending-policy' }, finding: 'Evaluate retained source', inputKind: kind,
    captureReason: 'stow', legacySections: [readLegacySection(path, '## Pending')], evidence: [{
      artifact: { uri: path, revision: 'v1' }, description: 'Pending section', observedAt: new Date().toISOString() }] });
  writeFileSync(path, original.replace('Keep pending source.', 'Changed pending source.'));
  const bundle = backupProject(flow.store, projectId, flow.home);
  assert.equal(bundle.artifacts.find(artifact => artifact.path === path)?.issue, 'changed');
  const restored = new ProjectStore(join(flow.home, 'pending-restore.sqlite'));
  try {
    restoreProjectBackup(restored, bundle, flow.home);
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'reconciling');
    writeFileSync(path, original); const digest = digestText(original);
    verifyRestoredArtifact(restored, { projectId, path, digest, evidence: [{ artifact: { uri: path, digest },
      description: 'Repaired pending section', observedAt: new Date().toISOString() }] });
    assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'enabled');
  } finally { restored.close(); }
});


function suspendedNewWork(flow: ReturnType<typeof setup>) {
  const a = assignment(flow); const task = taskCommand('bound-work');
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'bound-correction', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'bound-correction', command: 'deliver_correction', targetId: 'bound-correction', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Create the originally planned work', action: 'new_work',
      sequence: 1, supersedes: [], taskCommand: task } });
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const unused = flow.executable('unused-bound.cjs', 'throw new Error("task action only");');
  const options: CorrectionAdapterOptions = { fmHome: flow.home, sendExecutable: unused, controlExecutable: unused,
    taskAdapter: flow.adapter, recipients: [] };
  return { queued, task, options };
}

for (const timing of ['before-child', 'after-child'] as const) test(`review 1342-1: recovery rejects readdressing ${timing}`, t => {
  const flow = setup(t); const { queued, options } = suspendedNewWork(flow);
  const replace = () => {
    const previous = assignment(flow); const at = new Date().toISOString();
    const replacement = { ...previous, revision: previous.revision + 1, updatedAt: at, attemptId: 'replacement-attempt' };
    const decision = { kind: 'decision_change', id: 'replace-bound-attempt', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
      questionOrChange: 'Replace the assignment', affectedRecords: [ref(previous)], rationale: 'Explicit new attempt',
      disposition: 'selected', sourceRefs: [{ uri: 'fixture:replacement' }], scopeChanges: [] };
    flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
      command: 'record_decision_suggestion', targetId: previous.id, expectedRevision: previous.revision, payload: { decision } }, () => [decision, replacement]);
    const record = flow.store.get(projectId, queued.correction.id); assert.ok(record?.kind === 'observation' && record.correction);
    const c = record.correction;
    queueCorrection(flow.store, { schemaVersion: 1, id: 'readdress-bound', projectId, issuedAt: at, idempotencyKey: 'readdress-bound',
      command: 'deliver_correction', targetId: record.id, expectedRevision: record.revision,
      payload: { readdress: true, affectedRevision: c.affectedRevision, assignment: ref(replacement), originalCorrection: c.originalText,
        action: c.action, sequence: c.sequence, supersedes: c.supersedes, sourceRefs: c.sourceRefs, taskCommand: taskCommand('changed-work') } });
  };
  const lock = flow.store.withTaskLock.bind(flow.store); let count = 0;
  flow.store.withTaskLock = (id, body) => {
    const child = ++count === 2;
    if (child && timing === 'before-child') replace();
    const result = lock(id, body);
    if (child && timing === 'after-child') replace();
    return result;
  };
  assert.throws(() => recoverTaskCorrection(flow.store, { projectId, correctionId: queued.correction.id, idempotencyKey: 'bound-recovery' }, options), /recovery.*(changed|conflict)|delivery_intent_changed/);
  const record = flow.store.get(projectId, queued.correction.id); assert.ok(record?.kind === 'observation' && record.correction);
  assert.equal(record.correction.facts.some(fact => fact.fact === 'delivered'), false);
  assert.equal(flow.tasks.read().tasks['changed-work'], undefined);
  if (timing === 'before-child') assert.equal(flow.tasks.read().tasks['bound-work'], undefined);
});

test('review 1342-4: fresh recovery permission follows a suspended recovery child after a second disable', t => {
  const flow = setup(t); const { queued, task, options } = suspendedNewWork(flow);
  // Prepare the original task operation, then retire it before recovering a child.
  flow.tasks.edit(state => { state.failure = { action: 'add', when: 'after' }; });
  assert.equal(manageExecutionTask(flow.store, task, flow.adapter).operation.state, 'unknown');
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  flow.tasks.edit(state => { state.failure = { action: 'show', when: 'bad-read' }; });
  const request = { projectId, correctionId: queued.correction.id, idempotencyKey: 'first-child-permission' };
  assert.equal(recoverTaskCorrection(flow.store, request, options).state, 'unknown');
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  assert.throws(() => recoverTaskCorrection(flow.store, request, options), /permanently_suspended/);
  assert.equal(recoverTaskCorrection(flow.store, { ...request, idempotencyKey: 'second-child-permission' }, options).state, 'succeeded');
  assert.equal(flow.tasks.read().calls.filter(call => call.args[0] === 'add' && call.args[1] !== '--help').length, 1);
});

test('review 1453-1: recovery reuses a successful child after interruption and disable/re-enable', t => {
  const flow = setup(t); const { queued, task, options } = suspendedNewWork(flow);
  flow.tasks.edit(state => { state.failure = { action: 'add', when: 'after' }; });
  assert.equal(manageExecutionTask(flow.store, task, flow.adapter).operation.state, 'unknown');
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  const lock = flow.store.withTaskLock.bind(flow.store); let count = 0;
  flow.store.withTaskLock = (id, body) => {
    const result = lock(id, body);
    if (++count === 2) throw new Error('interrupted after child success');
    return result;
  };
  const request = { projectId, correctionId: queued.correction.id, idempotencyKey: 'interrupted-success-permission' };
  assert.throws(() => recoverTaskCorrection(flow.store, request, options), /interrupted after child success/);
  flow.store.withTaskLock = lock;
  const childKey = stableId('recovered-task-key', stableId('task-correction-recovery', projectId, request.idempotencyKey));
  const child = flow.store.get(projectId, stableId('task-operation', projectId, childKey));
  assert.ok(child?.kind === 'operation'); assert.equal(child.state, 'succeeded');
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  assert.throws(() => recoverTaskCorrection(flow.store, request, options), /permanently_suspended/);
  const calls = flow.tasks.read().calls;
  const taskOperations = flow.store.operations(projectId).filter(operation => operation.command === 'map_manage_execution_task');
  const fresh = { ...request, idempotencyKey: 'fresh-success-permission' };
  assert.equal(recoverTaskCorrection(flow.store, fresh, options).state, 'succeeded');
  assert.equal(recoverTaskCorrection(flow.store, fresh, options).state, 'succeeded');
  assert.deepEqual(flow.tasks.read().calls, calls);
  const record = flow.store.get(projectId, queued.correction.id);
  assert.ok(record?.kind === 'observation' && record.correction);
  assert.equal(record.correction.facts.filter(fact => fact.fact === 'delivered').length, 1);
  assert.deepEqual(flow.store.operations(projectId).filter(operation => operation.command === 'map_manage_execution_task'), taskOperations);
});

test('review 1342-2: explicit cancellation recovery carries the lost-response lifecycle attempt', t => {
  const flow = setup(t); const a = assignment(flow); const task = taskCommand(a.firstMateTaskId, 'cancel');
  task.targetId = 'mapping-1'; task.expectedRevision = 1;
  flow.tasks.edit(state => { state.tasks[a.firstMateTaskId] = fakeTask(a.firstMateTaskId, { state: 'in_flight' }); });
  flow.runtime.save([{ id: a.firstMateTaskId, spawn_gen: 'cancel-generation', project: flow.home,
    endpoint: { exists: true, agent_alive: 'alive', freshness: 'fresh', observed_at: '' }, current_state: { state: 'active', freshness: 'fresh', observed_at: '' } }]);
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'lost-cancel', projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: 'lost-cancel', command: 'deliver_correction', targetId: 'lost-cancel', expectedRevision: 0,
    payload: { affectedRevision: a.feature, assignment: ref(a), originalCorrection: 'Cancel the exact worker', action: 'cancellation',
      sequence: 1, supersedes: [], taskCommand: task } });
  const control = flow.executable('lost-cancel-control.cjs', `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(flow.home, 'cancel-exits'))},'exit\\n');
const tasks=JSON.parse(fs.readFileSync(${JSON.stringify(flow.runtime.statePath)},'utf8'));tasks[0].endpoint.agent_alive='dead';
fs.writeFileSync(${JSON.stringify(flow.runtime.statePath)},JSON.stringify(tasks));process.exit(2);`);
  const options: CorrectionAdapterOptions = { fmHome: flow.home, sendExecutable: control, controlExecutable: control,
    taskAdapter: { ...flow.adapter, controlExecutable: control }, recipients: [{ assignment: ref(a), attemptId: a.attemptId,
      firstMateTaskId: a.firstMateTaskId, state: 'active', observedAt: new Date().toISOString() }] };
  assert.equal(deliverCorrection(flow.store, projectId, queued.correction.id, options).state, 'unknown');
  disableProject(flow.store, projectId, 'pause'); reconcileProject(flow.store, projectId, flow.adapter);
  assert.equal(recoverTaskCorrection(flow.store, { projectId, correctionId: queued.correction.id, idempotencyKey: 'recover-lost-cancel' }, options).state, 'succeeded');
  assert.equal(readFileSync(join(flow.home, 'cancel-exits'), 'utf8'), 'exit\n');
});


for (const protection of ['guard', 'hold', 'preexisting-guard'] as const) test(`review 1453-2: cancellation protection respects consumer ${protection} ownership at handback`, t => {
  const flow = setup(t); const detail = flow.store.get(projectId, 'task-1'); assert.ok(detail?.kind === 'detailed_plan_task');
  const at = new Date().toISOString(); const consumerDetail = { ...detail, id: 'consumer-detail', plan: { id: 'consumer-plan', revision: 1 } };
  const plan = flow.store.get(projectId, 'plan-1'); assert.ok(plan?.kind === 'implementation_plan_revision');
  const consumerPlan = { ...plan, id: 'consumer-plan', deliverySequence: [ref(consumerDetail)], priorities: [{ taskId: consumerDetail.id, priority: 1 }] };
  const decision = { kind: 'decision_change', id: 'consumer-fixture', projectId, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
    questionOrChange: 'Add dependent work', affectedRecords: [ref(detail)], rationale: 'Cancellation protection regression',
    disposition: 'selected', sourceRefs: [{ uri: 'fixture:consumer' }], scopeChanges: [] };
  flow.store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
    command: 'record_decision_suggestion', targetId: consumerDetail.id, expectedRevision: 0, payload: { decision } }, () => [decision, consumerPlan, consumerDetail]);
  const consumer = taskCommand('protected-consumer', 'map');
  if (protection !== 'hold') {
    queueManagedTask(flow.store, { ...consumer, payload: { ...consumer.payload, detailedPlanTask: ref(consumerDetail), dependencies: ['pilot-build'] } });
  } else {
    const template = flow.store.get(projectId, 'mapping-1'); assert.ok(template?.kind === 'task_mapping');
    const mapping = { ...template, id: consumer.targetId, firstMateTaskId: 'protected-consumer', detailedPlanTask: ref(consumerDetail), dependencies: ['pilot-build'] };
    const add = { ...decision, id: 'unmanaged-consumer-fixture', affectedRecords: [ref(mapping)] };
    flow.store.mutate({ schemaVersion: 1, id: add.id, projectId, issuedAt: at, idempotencyKey: add.id,
      command: 'record_decision_suggestion', targetId: mapping.id, expectedRevision: 0, payload: { decision: add } }, () => [add, mapping]);
  }
  flow.tasks.edit(state => {
    state.tasks['pilot-build'] = fakeTask('pilot-build');
    state.tasks['protected-consumer'] = fakeTask('protected-consumer', { hold: protection !== 'hold' ? { reason: 'Consumer owner', kind: 'captain', until: null } : null,
      deps: [{ type: 'blocked-by', id: 'pilot-build' }, ...(protection === 'preexisting-guard' ? [{ type: 'blocked-by' as const, id: 'permanent-guard' }] : [])] });
    if (protection !== 'preexisting-guard') state.failure = { action: protection === 'guard' ? 'block' : 'hold', when: 'after' };
  });
  const cancel = taskCommand('pilot-build', 'cancel'); cancel.targetId = 'mapping-1'; cancel.expectedRevision = 1;
  const adapter = { ...flow.adapter, guardTaskId: 'permanent-guard' };
  assert.equal(manageExecutionTask(flow.store, cancel, adapter).operation.state, protection === 'preexisting-guard' ? 'succeeded' : 'unknown');
  if (protection === 'preexisting-guard') {
    const mapping = flow.store.get(projectId, consumer.targetId); assert.ok(mapping?.kind === 'task_mapping');
    assert.equal(mapping.management!.managedDependencies.includes('permanent-guard'), false);
    assert.equal(flow.tasks.read().calls.some(call => call.args[0] === 'block' && call.args[1] === 'protected-consumer'), false);
  }
  disableProject(flow.store, projectId, 'hand_back', adapter);
  assert.deepEqual(flow.tasks.read().tasks['protected-consumer']!.deps, [{ type: 'blocked-by', id: 'pilot-build' },
    ...(protection === 'preexisting-guard' ? [{ type: 'blocked-by', id: 'permanent-guard' }] : [])]);
  assert.equal(flow.tasks.read().tasks['protected-consumer']!.hold?.reason, protection !== 'hold' ? 'Consumer owner' : undefined);
});
