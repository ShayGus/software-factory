import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkBuilderAdmission, factoryProject, requireFactoryStartHook, repositoryIdentity,
  checkStartingWorker, ProjectStore, RecordsSchema, FleetSnapshotSchema, ref, type Assignment, type DecisionChange } from '../src/index.js';
const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'sf-lock-'));
  const repo = join(home, 'repo'); mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Example/Factory.git']);
  const records = structuredClone(baseline);
  const project = records.find(record => record.kind === 'project')!;
  assert.equal(project.kind, 'project');
  if (project.kind !== 'project') throw Error('fixture');
  project.firstMateHomeRef = home; project.repositories = [{ uri: repo }];
  const database = join(home, 'store.sqlite'); const store = new ProjectStore(database);
  store.importProject({ schemaVersion: 1, projectId: project.id, history: records, receipts: [] });
  const registry = { version: 1, projects: [{ home, database, projectId: project.id, agentConfig: join(home, 'agents.json') }] };
  const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
  const at = new Date().toISOString();
  const snapshot = (occupants = 0) => FleetSnapshotSchema.parse({ schema: 'fm-fleet-snapshot.v1', generated: at, fm_home: home,
    backlog: { present: true, records: [{ id: assignment.firstMateTaskId, order: 10, state: 'queued', kind: 'ship', repo: 'repo' }] },
    tasks: Array.from({ length: occupants }, (_, i) => ({ id: `builder-${i}`, kind: 'ship', project: repo, spawn_gen: `generation-${i}`,
      current_state: { state: 'working', freshness: 'fresh', observed_at: at } })) });
  return { home, repo, records, database, store, registry, assignment, snapshot,
    close() { store.close(); rmSync(home, { recursive: true, force: true }); } };
}
test('native factory target refuses unmapped tasks; positive non-factory and empty registries retain the old path', () => {
  const f = setup();
  try {
    const event = { version: 1, event: 'worker.start.before', home: f.home, project: f.repo,
      task_id: 'outside-factory', source_brief_path: null, brief_path: null, brief_sha256: null };
    assert.throws(() => checkStartingWorker(f.registry, event), /factory_task_requires_mapping/);
    const other = join(f.home, 'other'); mkdirSync(other); execFileSync('git', ['-C', other, 'init', '-q']);
    assert.deepEqual(checkStartingWorker(f.registry, { ...event, project: other }), { ok: true, managed: false });
    assert.deepEqual(checkStartingWorker({ version: 1, projects: [] }, event), { ok: true, managed: false });
    assert.throws(() => checkStartingWorker(f.registry, { ...event, task_id: f.assignment.firstMateTaskId }), /candidate_missing/);
    const alias = join(f.home, 'alias'); symlinkSync(f.repo, alias);
    assert.equal(factoryProject(f.registry, f.home, alias)?.projectId, 'project-1');
    assert.equal(repositoryIdentity('https://github.com/example/factory.git'), repositoryIdentity(f.repo));
    const unavailable = structuredClone(f.registry); unavailable.projects[0]!.database = join(f.home, 'missing.sqlite');
    assert.throws(() => factoryProject(unavailable, f.home, f.repo), /database_unavailable/);
  } finally { f.close(); }
});
test('factory starts require the installed native hook even when hooks.json is absent or empty', () => {
  const f = setup();
  try {
    const path = join(f.home, 'registry.json'), executable = '/installed/worker-start-before.mjs';
    assert.throws(() => requireFactoryStartHook(f.registry, path, f.home, f.repo, executable));
    mkdirSync(join(f.home, 'config'));
    const hooks = join(f.home, 'config/hooks.json');
    writeFileSync(hooks, JSON.stringify({ version: 1, hooks: [] }));
    assert.throws(() => requireFactoryStartHook(f.registry, path, f.home, f.repo, executable), /not_configured/);
    writeFileSync(hooks, JSON.stringify({ version: 1, hooks: [{ event: 'worker.start.before', argv: [executable, path] }] }));
    assert.doesNotThrow(() => requireFactoryStartHook(f.registry, path, f.home, f.repo, executable));
  } finally { f.close(); }
});
test('configured builder capacity defers excess workers; unset is unlimited and done without a PR frees a place', () => {
  const f = setup();
  try {
    assert.equal(checkBuilderAdmission(f.records, f.assignment, f.snapshot(2), f.repo, 3).builders, 2);
    const incomplete = f.snapshot(1); incomplete.tasks[0]!.project = null;
    assert.throws(() => checkBuilderAdmission(f.records, f.assignment, incomplete, f.repo, 3), /inventory_incomplete/);
    assert.doesNotThrow(() => checkBuilderAdmission(f.records, f.assignment, f.snapshot(6), f.repo), 'Unset capacity has no limit');
    assert.throws(() => checkBuilderAdmission(f.records, f.assignment, f.snapshot(2), f.repo, 2), /project capacity 2/);
    assert.doesNotThrow(() => checkBuilderAdmission(f.records, f.assignment, f.snapshot(4), f.repo, 5));
    const snapshot = f.snapshot(3);
    assert.throws(() => checkBuilderAdmission(f.records, f.assignment, snapshot, f.repo, 3), /project capacity 3/);
    snapshot.tasks[0]!.endpoint = { agent_alive: 'dead', exists: false, freshness: 'fresh', observed_at: snapshot.generated }; // Loss is not completion.
    assert.throws(() => checkBuilderAdmission(f.records, f.assignment, snapshot, f.repo, 3), /project capacity 3/);
    snapshot.tasks[0]!.current_state.state = 'done';
    assert.equal(checkBuilderAdmission(f.records, f.assignment, snapshot, f.repo, 3).builders, 2);
    snapshot.tasks[0]!.current_state.state = 'working'; snapshot.tasks[0]!.kind = 'scout';
    assert.equal(checkBuilderAdmission(f.records, f.assignment, snapshot, f.repo, 3).builders, 2);
    snapshot.tasks[0]!.kind = 'ship'; snapshot.tasks[0]!.current_state.freshness = 'stale';
    snapshot.tasks[0]!.current_state.state = 'done';
    assert.throws(() => checkBuilderAdmission(f.records, f.assignment, snapshot, f.repo, 3), /project capacity 3/);
  } finally { f.close(); }
});
test('native owner order wins over IDs and array order; a stuck earlier ticket permits independent work', () => {
  const f = setup();
  try {
    const records = structuredClone(f.records);
    const mapping = records.find(record => record.kind === 'task_mapping')!;
    if (mapping.kind !== 'task_mapping') throw Error('fixture');
    const earlierMapping = { ...mapping, id: 'later-alphabetically-mapping', firstMateTaskId: 'zz-owner-first' };
    const earlierAssignment = { ...f.assignment, id: 'earlier-assignment', firstMateTaskId: earlierMapping.firstMateTaskId,
      attemptId: 'earlier-attempt' };
    records.push(earlierMapping, earlierAssignment);
    const snapshot = f.snapshot();
    snapshot.backlog.records.push({ id: earlierMapping.firstMateTaskId, order: 1, state: 'queued', kind: 'ship', repo: 'repo' });
    assert.throws(() => checkBuilderAdmission(records, f.assignment, snapshot, f.repo, 3), /earlier eligible ticket zz-owner-first/);
    snapshot.backlog.records[1]!.hold_reason = 'Owner question';
    assert.doesNotThrow(() => checkBuilderAdmission(records, f.assignment, snapshot, f.repo, 3));
    snapshot.backlog.records[0]!.blocked_by_ids = [earlierMapping.firstMateTaskId];
    assert.throws(() => checkBuilderAdmission(records, f.assignment, snapshot, f.repo, 3), /held or blocked/);
    delete snapshot.backlog.records[0]!.order;
    assert.throws(() => checkBuilderAdmission(records, f.assignment, snapshot, f.repo, 3), /order_unavailable/);
  } finally { f.close(); }
});


test('native lock adapter refuses missing configuration and checker before any start or merge', () => {
  const f = setup();
  try {
    const library = fileURLToPath(new URL('../../../bin/fm-factory-lock-lib.sh', import.meta.url));
    const bin = fileURLToPath(new URL('../../../bin', import.meta.url));
    const invoke = (action: string, repository = f.repo) => spawnSync('bash', ['-c',
      '. "$1"; FM_HOME=$2; SCRIPT_DIR=$3; fm_factory_lock "$4" "$5" "$6" "$7"', '_',
      library, f.home, bin, action, repository, f.assignment.firstMateTaskId, 'a'.repeat(40)], { encoding: 'utf8' });
    assert.equal(invoke('start').status, 0, 'Homes without a factory registry keep existing behavior');
    mkdirSync(join(f.home, 'config'));
    const settingsPath = join(f.home, 'config/software-factory.json');
    writeFileSync(settingsPath, JSON.stringify({ factoryRoot: fileURLToPath(new URL('../..', import.meta.url)) }));
    const missingRegistry = invoke('start');
    assert.equal(missingRegistry.status, 1); assert.match(missingRegistry.stderr, /registry unavailable/);
    rmSync(settingsPath);
    const registryPath = join(f.home, 'config/software-factory.projects.json');
    writeFileSync(registryPath, JSON.stringify(f.registry));
    assert.equal(invoke('start').status, 1);
    const executable = fileURLToPath(new URL('../../scripts/worker-start-before.mjs', import.meta.url));
    writeFileSync(join(f.home, 'config/hooks.json'), JSON.stringify({ version: 1,
      hooks: [{ event: 'worker.start.before', argv: [executable, registryPath] }] }));
    assert.equal(invoke('start').status, 0);
    const merge = invoke('merge');
    assert.equal(merge.status, 1); assert.match(merge.stderr, /requires_passing_product_review_for_head/);
    writeFileSync(join(f.home, 'config/software-factory.json'), JSON.stringify({ factoryRoot: join(f.home, 'absent-checker') }));
    assert.notEqual(invoke('start').status, 0);
  } finally { f.close(); }
});

test('native steering checks Factory scope and preserves question replies, owner wording and other projects', () => {
  const f = setup();
  try {
    const task = f.assignment.firstMateTaskId;
    const statement = 'Leave the provider timing check as an advisory.';
    const request = f.records.find((record) => record.kind === 'request')!;
    const reviewed = f.records.find((record) => record.kind === 'product_review')!;
    const at = new Date().toISOString();
    const decision: DecisionChange = { kind: 'decision_change', id: 'owner-review-answer', projectId: f.assignment.projectId,
      schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at, questionOrChange: 'Should the timing finding block?',
      affectedRecords: [ref(reviewed)], rationale: 'Recorded owner answer', disposition: 'selected',
      sourceRefs: [request.source], scopeChanges: [], choice: { kind: 'product', state: 'resolved' }, answer: { text: statement } };
    f.store.mutate({ schemaVersion: 1, id: decision.id, projectId: decision.projectId, issuedAt: at, idempotencyKey: decision.id,
      command: 'record_decision_suggestion', targetId: decision.id, expectedRevision: 0, payload: { decision } }, () => [decision]);

    const agentLog = join(f.home, 'judge.jsonl');
    const agent = join(f.home, 'judge');
    writeFileSync(agent, `#!${process.execPath}
const fs = require('node:fs');
const pointer = JSON.parse(fs.readFileSync(0, 'utf8').trim().split('\\n').at(-1));
const input = JSON.parse(fs.readFileSync(pointer.evidence, 'utf8'));
fs.appendFileSync(${JSON.stringify(agentLog)}, JSON.stringify(input) + '\\n');
const message = input.candidateInstructions;
const allowed = message === 'Verify every connected system.' ||
  (input.workerQuestions.includes('Which local fixture should I use?') && message === 'Use the common fixture.');
process.stdout.write(JSON.stringify(allowed ? {verdict:'pass',findings:[]} : {
  verdict:'fail',findings:[{type:'invented_scope',message:'The live provider timing test is outside the confirmed assignment',
    quotes:[{source:'instructions',text:message}]}]
}));
`, { mode: 0o700 });
    const agentConfig = JSON.parse(readFileSync(new URL('../../fixtures/workflow-agents.json', import.meta.url), 'utf8'));
    agentConfig.projectId = f.assignment.projectId;
    agentConfig.cwd = f.home;
    agentConfig.steps.instruction_check = { harness: 'codex', provider: 'codex', model: 'stub', effort: 'low' };
    agentConfig.executables = { codex: agent };
    writeFileSync(f.registry.projects[0]!.agentConfig, JSON.stringify(agentConfig));
    for (const directory of ['config', 'state', 'fake-bin']) mkdirSync(join(f.home, directory));
    writeFileSync(join(f.home, 'config/software-factory.projects.json'), JSON.stringify(f.registry));
    writeFileSync(join(f.home, 'fake-bin/tmux'), `#!/usr/bin/env bash
case "$1" in
  capture-pane) printf '╭────╮\\n│    │\\n╰────╯\\n' ;;
  display-message) printf '1\\n' ;;
  list-windows) printf 'fm-%s\\n' ${JSON.stringify(task)} unrelated ;;
esac
`, { mode: 0o700 });
    writeFileSync(join(f.home, 'fake-bin/sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
    const meta = (id: string, repo: string) => writeFileSync(join(f.home, 'state', `${id}.meta`),
      `window=sess:fm-${id}\nkind=ship\nproject=${repo}\nspawn_gen=test-generation\n`);
    meta(task, f.repo);
    const send = fileURLToPath(new URL('../../../bin/fm-send.sh', import.meta.url));
    const steer = (...args: string[]) => spawnSync('bash', [send, ...args], { encoding: 'utf8', timeout: 10_000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FM_'))),
        FM_HOME: f.home, FM_ROOT_OVERRIDE: f.home, FM_SEND_SETTLE: '0', PATH: `${join(f.home, 'fake-bin')}:${process.env.PATH}` } });
    const inbox = join(f.home, 'state', `${task}.inbox`);
    const messages = () => existsSync(inbox) ? readdirSync(inbox).filter((name) => name.endsWith('.msg')).sort()
      .map((name) => readFileSync(join(inbox, name), 'utf8')) : [];
    const outside = 'Run a live provider timing test for 31 minutes.';
    const refused = steer(task, outside);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /live provider timing test is outside the confirmed assignment/);
    const explicit = steer(`sess:fm-${task}`, outside);
    assert.equal(explicit.status, 1, explicit.stderr);
    assert.match(explicit.stderr, /outside the confirmed assignment/);
    assert.deepEqual(messages(), []);

    const status = join(f.home, 'state', `${task}.status`);
    writeFileSync(status, 'needs-decision [key=fixture]: Which local fixture should I use?\n');
    assert.equal(steer(task, '--resolve-key', 'fixture', `Use the common fixture. ${outside}`).status, 1);
    assert.doesNotMatch(readFileSync(status, 'utf8'), /resolved /);
    for (const args of [[task, '--resolve-key', 'fixture', 'Use the common fixture.'],
      [task, request.originalText], [task, statement], [task, 'Verify every connected system.']]) {
      const sent = steer(...args);
      assert.equal(sent.status, 0, sent.stderr);
    }
    assert.match(readFileSync(status, 'utf8'), /resolved \[key=fixture\]/);
    const delivered = messages();
    const expected = ['Use the common fixture.', request.originalText, statement, 'Verify every connected system.'];
    assert.equal(delivered.length, expected.length);
    expected.forEach((message, index) => assert.ok(delivered[index]!.includes(message)));
    assert.equal(readFileSync(agentLog, 'utf8').trim().split('\n').length, 5);

    const other = join(f.home, 'unregistered'); mkdirSync(other);
    execFileSync('git', ['-C', other, 'init', '-q']);
    meta('unrelated', other);
    const unmanaged = steer('unrelated', outside);
    assert.equal(unmanaged.status, 0, unmanaged.stderr);
    assert.ok(readFileSync(join(f.home, 'state/unrelated.inbox/001.msg'), 'utf8').includes(outside));
    assert.equal(readFileSync(agentLog, 'utf8').trim().split('\n').length, 5);
  } finally { f.close(); }
});
