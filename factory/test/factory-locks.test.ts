import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkBuilderAdmission, factoryProject, requireFactoryStartHook, repositoryIdentity,
  checkStartingWorker, ProjectStore, RecordsSchema, FleetSnapshotSchema, type Assignment } from '../src/index.js';
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
