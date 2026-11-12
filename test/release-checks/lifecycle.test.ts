import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { queueCorrection, deliverCorrection, ref, validateReviewForCompletion, validateAssignmentForDispatch,
  queueManagedTask, reconcileManagedTask, disableProject, reconcileProject, backupProject, restoreProjectBackup,
  ProjectStore, readFleetSnapshot, projectView, workView, WorkSnapshotSchema, importLegacyTasks } from '../../src/index.js';
import { setup, cases, correction, taskCommand, projectId } from './helper.js';

// Shell transport only. Its durable message envelope is the installed
// fm-task-inbox.v1 shape (bin/fm-task-inbox-lib.sh); no lifecycle rule lives here.
function steering(flow: ReturnType<typeof setup>) {
  return flow.executable('send.cjs', `const fs=require('node:fs'),path=require('node:path');
const inbox=path.join(process.env.FM_HOME,'state',process.argv[2]+'.inbox');fs.mkdirSync(inbox,{recursive:true});
fs.appendFileSync(path.join(process.env.FM_HOME,'send-calls'),JSON.stringify(process.argv.slice(2))+'\\n');
fs.writeFileSync(path.join(inbox,'001.msg'),'schema=fm-task-inbox.v1\\nat='+new Date().toISOString()+'\\nbody-terminator=1\\n--\\n'+process.argv[3]+'\\n');`);
}
function options(flow: ReturnType<typeof setup>, executable: string) {
  const a = flow.assignment();
  return { fmHome: flow.directory, sendExecutable: executable, controlExecutable: executable,
    snapshotExecutable: flow.runtime.executable, recipients: [{ assignment: ref(a), attemptId: a.attemptId,
      firstMateTaskId: a.firstMateTaskId, state: 'active' as const, observedAt: new Date().toISOString() }] };
}

test('CHECK-06 — correction revises the active attempt and stale returns cannot close it', t => {
  const flow = setup(t, 'CHECK-06'); const previous = flow.assignment();
  const input = correction(flow, 'CHECK-06', 'amended_scope');
  const queued = queueCorrection(flow.store, { ...input, payload: { ...input.payload, changedOutcome: cases['CHECK-06']!.correction } });
  assert.equal(flow.assignment().attemptId, previous.attemptId);
  assert.ok(flow.assignment().revision > previous.revision);
  assert.equal(flow.assignment().correctionContext?.requiresReplan, true);
  assert.equal(validateAssignmentForDispatch(flow.store.history(projectId), ref(flow.assignment())).ok, false);
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), { id: 'review-1', revision: 1 }).ok, false);
  const send = steering(flow);
  const result = deliverCorrection(flow.store, projectId, queued.correction.id, options(flow, send));
  assert.equal(result.state, 'succeeded', result.reconciliation?.note);
  const [target, text] = JSON.parse(readFileSync(join(flow.directory, 'send-calls'), 'utf8'));
  assert.equal(target, previous.firstMateTaskId);
  const payload = JSON.parse(text); assert.equal(payload.attemptId, previous.attemptId);
  assert.equal(payload.corrections[0].originalText, cases['CHECK-06']!.correction);
  const recorded = flow.store.get(projectId, queued.correction.id); assert.ok(recorded?.kind === 'observation');
  assert.deepEqual(recorded.correction?.facts.map(f => f.fact), ['recorded', 'delivered']);
  assert.equal(projectView(flow.store, { projectId }).features[0]?.completeness, 'Incomplete — product behavior still needs verification');
});

test('CHECK-08 — process death after native creation reconciles without duplicate execution', t => {
  const flow = setup(t, 'CHECK-08'); const queued = queueManagedTask(flow.store, taskCommand());
  const crash = flow.executable('crash-after-add.cjs', `const cp=require('node:child_process');
const r=cp.spawnSync(${JSON.stringify(flow.tasks.executable)},process.argv.slice(2));
if(r.status!==0){process.stdout.write(r.stdout);process.exit(r.status??2);}
if(process.argv[2]==='add'&&process.argv[3]!=='--help'){process.kill(process.ppid,'SIGKILL');process.exit(0);}
process.stdout.write(r.stdout);`);
  const config = join(flow.directory, 'adapter.json'); writeFileSync(config, JSON.stringify({ ...flow.adapter, tasksExecutable: crash }));
  const cli = new URL('../../src/cli.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'reconcile-task', '--db', flow.database, '--project', projectId,
    '--operation', queued.operation.id, '--adapter-config', config], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  assert.ok(flow.tasks.read().tasks['release-task']);
  flow.reopen();
  const recovered = reconcileManagedTask(flow.store, projectId, queued.operation.id, flow.adapter);
  assert.equal(recovered.state, 'succeeded', recovered.reconciliation?.note);
  assert.equal(flow.tasks.read().calls.filter(c => c.args[0] === 'add' && c.args[1] !== '--help').length, 1);
  assert.ok(readFleetSnapshot(flow.runtimeAdapter).tasks.some(task => task.id === 'pilot-build'));
  assert.equal(flow.store.get(projectId, 'request-1')?.kind, 'request');
});

test('CHECK-12 — disable and restore preserve work and retire pending side effects', t => {
  const flow = setup(t, 'CHECK-12');
  const command = taskCommand('existing-release');
  const created = queueManagedTask(flow.store, { ...command, payload: { ...command.payload, readiness: [{ id: 'acceptance', reason: 'Requested behavior still lacks current evidence', evidence: [] }] } });
  assert.equal(reconcileManagedTask(flow.store, projectId, created.operation.id, flow.adapter).state, 'succeeded');
  const pending = queueManagedTask(flow.store, taskCommand('never-replay'));
  const original = flow.store.get(projectId, 'request-1');
  const disabled = disableProject(flow.store, projectId, 'hand_back', flow.adapter);
  assert.deepEqual(disabled.errors, []);
  assert.ok(disabled.outstandingConditions.length, 'Evidence gaps must have explicit dispositions');
  assert.equal(flow.tasks.read().tasks['pilot-build']?.state, 'in_flight');
  assert.ok(flow.tasks.read().tasks['existing-release']);
  assert.throws(() => reconcileManagedTask(flow.store, projectId, pending.operation.id, flow.adapter), /disabled/);
  assert.equal(reconcileProject(flow.store, projectId, flow.adapter).state, 'enabled');
  assert.throws(() => reconcileManagedTask(flow.store, projectId, pending.operation.id, flow.adapter), /permanently_suspended/);
  assert.equal(flow.tasks.read().tasks['never-replay'], undefined);
  assert.equal(flow.tasks.read().calls.some(c => c.args.includes('exit') || c.args.includes('done')), false);
  const backup = backupProject(flow.store, projectId, flow.directory);
  const restored = new ProjectStore(join(flow.directory, 'restored.sqlite')); t.after(() => restored.close());
  mkdirSync(join(flow.directory, 'restored-artifacts'));
  const report = restoreProjectBackup(restored, backup, join(flow.directory, 'restored-artifacts'));
  assert.ok(report.artifacts.length, 'Absent source/evidence attachments must be disclosed');
  assert.deepEqual(restored.get(projectId, 'request-1'), original);
  assert.throws(() => restored.assertExternalOperationsAllowed(projectId), /reconciling/);
  assert.equal(reconcileProject(restored, projectId, flow.adapter).state, 'reconciling');
  assert.equal(flow.tasks.read().tasks['never-replay'], undefined);
});

test('CHECK-17 — rewind names the existing worker or reports unsupported without substitution', t => {
  const flow = setup(t, 'CHECK-17'); const queued = queueCorrection(flow.store, correction(flow, 'CHECK-17', 'rewind'));
  const executable = flow.executable('forbid-control.cjs', `require('node:fs').writeFileSync(${JSON.stringify(join(flow.directory, 'unexpected-lifecycle'))},'called');process.exit(99);`);
  // Read the installed-shape observation through the real adapter before action.
  assert.equal(readFleetSnapshot(flow.runtimeAdapter).tasks[0]?.id, flow.assignment().firstMateTaskId);
  const result = deliverCorrection(flow.store, projectId, queued.correction.id, options(flow, executable));
  assert.equal(result.state, 'failed'); assert.match(result.reconciliation!.note, /Missing capability.*rewind/);
  assert.equal(existsSync(join(flow.directory, 'unexpected-lifecycle')), false);
  assert.equal(flow.store.records(projectId).filter(r => r.kind === 'assignment').length, 1);
  const recorded = flow.store.get(projectId, queued.correction.id); assert.ok(recorded?.kind === 'observation');
  assert.equal(recorded.correction?.originalText, cases['CHECK-17']!.correction);
  assert.equal(recorded.correction?.assignment.id, 'assignment-1');
});

// Work rendering exists; distinguish a valid toolkit projection from the
// missing production connection to the installed fleet adapter.
test('CHECK-18 — ready PR retains age, next action and blockers as queues grow', async t => {
  const flow = setup(t, 'CHECK-18', undefined, false);
  const rows = flow.runtime.read(); rows[0]!.current_state.state = 'done';
  rows.push({ ...structuredClone(rows[0]!), id: 'waiting-review', current_state: { ...rows[0]!.current_state, state: 'parked' } },
    { ...structuredClone(rows[0]!), id: 'new-work', current_state: { ...rows[0]!.current_state, state: 'working' } });
  // Additive fields are the installed snapshot's exact pr/current_state/path shapes.
  const snapshotRows = rows.map(row => row.id === 'pilot-build' ? { ...row,
    pr: { url: 'https://example.invalid/software-factory/pull/18', source: 'meta', head: null },
    current_state: { ...row.current_state, source: 'run-step', detail: 'checks green: PR ready for review' },
    paths: { status_log: { last_event: { raw: 'done: synthetic ready result', age_seconds: 120 } } } } : row);
  writeFileSync(flow.runtime.statePath, JSON.stringify(snapshotRows));
  const observed = readFleetSnapshot(flow.runtimeAdapter);
  assert.equal(observed.tasks[0]?.current_state.state, 'done');
  assert.equal(observed.tasks.length, 3);
  assert.deepEqual(observed.tasks[0]?.pr, snapshotRows[0] && 'pr' in snapshotRows[0] ? snapshotRows[0].pr : undefined);
  assert.equal(observed.tasks[0]?.current_state.detail, 'checks green: PR ready for review');
  const plan = flow.store.get(projectId, 'plan-1'); assert.ok(plan?.kind === 'implementation_plan_revision');
  const original = flow.store.get(projectId, 'request-1'); assert.ok(original?.kind === 'request');
  assert.equal(original.originalText, cases['CHECK-18']!.originalRequest);
  const readyRef = (observed.tasks[0]!.pr as { url: string }).url;
  const snapshot = WorkSnapshotSchema.parse(JSON.parse(readFileSync(new URL('../../../fixtures/ui-work-snapshot.json', import.meta.url), 'utf8')));
  snapshot.observedAt = new Date().toISOString();
  snapshot.tasks[0]!.ready = [{ kind: 'pr', reference: readyRef,
    readySince: new Date(Date.now() - 120_000).toISOString(), nextAction: 'Independent product review using the settled local-only delivery instructions' }];
  const options = { projectId, readSnapshot: () => snapshot };
  const model = workView(projectView(flow.store, options));
  assert.equal(model.ready[0]?.reference, readyRef); assert.equal(model.ready[0]?.age, '2 min');
  assert.ok(model.ready[0]?.row?.reasons.some(reason => reason.includes('Review wait')));
  const before = flow.store.exportProject(projectId);
  const http = await flow.http(options);
  const work = await http('GET', '/projects/project-1/work'); assert.equal(work.status, 200, work.text);
  assert.ok(work.text.includes(readyRef)); assert.match(work.text, /Next action: Independent product review/);
  assert.match(work.text, /Ready since:/); assert.match(work.text, /Feature completeness: Incomplete/);
  assert.deepEqual(flow.store.exportProject(projectId), before, 'Reads reuse settled intent without generating new instructions or decisions');
  // Import real adapter evidence as the existing runtime path does. The default
  // API does not connect that observation to BUILD-13's separate WorkSnapshot.
  importLegacyTasks(flow.store, projectId, flow.runtimeAdapter);
  const defaultHttp = await flow.http();
  const defaultWork = await defaultHttp('GET', '/projects/project-1/work'); assert.equal(defaultWork.status, 200);
  assert.match(defaultWork.text, /Unknown — ready-work observations unavailable/);
  const defaultModel = workView(projectView(flow.store, { projectId }));
  await t.test('CHECK-18 unresolved — installed fleet evidence is not projected into Work', {
    todo: 'Production runtime-to-WorkSnapshot connection absent; see docs/release-checks.md',
  }, () => {
    assert.ok(defaultModel.ready.some(item => item.reference === readyRef),
      'Recorded installed readiness is unavailable to the default Work view without a caller-authored projection');
  });
});
