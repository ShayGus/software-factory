import { scenario } from './milestone-helper.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkStartingWorker, ProjectStore, ref, recordSource, runFeature,
  validateReviewForCompletion, FeatureRunConfigSchema, prepareWorkerBrief } from '../src/index.js';

const at = '2026-11-11T18:00:00Z';
const script = fileURLToPath(new URL('../../scripts/worker-start-before.mjs', import.meta.url));

function laterAttempt(flow: ReturnType<typeof scenario>, suffix: string) {
  const store = new ProjectStore(flow.database);
  try {
    const original = store.get('project-1', 'milestone-worker-assignment'); assert.ok(original?.kind === 'assignment');
    const directory = join(flow.data, 'milestone-worker', `attempt-${suffix}`); mkdirSync(directory, { recursive: true });
    const briefPath = join(directory, 'brief.md');
    writeFileSync(briefPath, readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url), 'utf8'));
    const prepared = prepareWorkerBrief(store, { projectId: 'project-1', assignmentId: `${original.id}-${suffix}`,
      attemptId: `attempt-${suffix}`, expectedRevision: 0, idempotencyKey: `prepare-${suffix}`,
      issuedAt: new Date(Date.parse(original.updatedAt) + 1000).toISOString(),
      detailedPlanTask: original.detailedPlanTask, plan: original.plan, firstMateTaskId: original.firstMateTaskId,
      returnLocation: original.returnLocation, briefPath, sourceFiles: flow.config.sourceFiles });
    assert.equal(prepared.ok, true, JSON.stringify(prepared)); return prepared;
  } finally { store.close(); }
}

function startingEvent(flow: ReturnType<typeof scenario>, source: string) {
  return { version: 1, event: 'worker.start.before', home: flow.home, task_id: 'milestone-worker',
    source_brief_path: source, brief_path: source, brief_sha256: createHash('sha256').update(readFileSync(source)).digest('hex') };
}

test('review 1251 finding 5: hook checks the current attempt and refuses a historical brief', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    const latest = laterAttempt(flow, 'current');
    const registry = JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8'));
    const report = checkStartingWorker(registry, startingEvent(flow, latest.briefPath));
    assert.equal(report.ok, true, JSON.stringify(report));
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
    const call = JSON.parse(calls.trimEnd().split('\n').at(-1)!);
    const judged = JSON.parse(call.prompt.trimEnd().split('\n').at(-1)!);
    assert.equal(judged.assignment.id, latest.assignment.id);
    const historical = checkStartingWorker(registry, startingEvent(flow, join(flow.data, 'milestone-worker', 'brief.md')));
    assert.equal(historical.ok, false);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), calls);
  } finally { flow.close(); }
});

test('review 1251 finding 5: genuinely tied current attempts remain blocked before judgment', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    const first = laterAttempt(flow, 'tied-a'); laterAttempt(flow, 'tied-b');
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
    assert.throws(() => checkStartingWorker(JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8')),
      startingEvent(flow, first.briefPath)), /hook_managed_assignment_missing_or_ambiguous/);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), calls);
  } finally { flow.close(); }
});

test('review 1251 finding 9: relative snapshot paths are rejected before capture', () => {
  const flow = scenario();
  try {
    const snapshot = fileURLToPath(new URL('../../fixtures/firstmate-brief.md', import.meta.url));
    flow.config.sourceFiles = [{ source: { uri: 'fixture:planning-research' }, path: relative(process.cwd(), snapshot) }];
    const before = readFileSync(flow.database);
    assert.throws(() => runFeature(flow.config, 'prepare'), /Snapshot paths must be absolute/);
    assert.deepEqual(readFileSync(flow.database), before);
    assert.equal(flow.wrapper.read().calls.length, 0);
    assert.equal(existsSync(join(flow.root, 'agents.jsonl')), false);
    assert.equal(existsSync(join(flow.config.runDirectory, 'prepare.started')), false);
  } finally { flow.close(); }
});

test('review 1201 finding 5: bootstrap works before hook enablement without an agent config and keeps unmanaged starts available', () => {
  const flow = scenario({ bootstrap: false });
  try {
    const hookPath = join(flow.home, 'config', 'hooks.json'); const hooks = JSON.parse(readFileSync(hookPath, 'utf8'));
    rmSync(hookPath); rmSync(flow.config.agentConfig);
    const configPath = join(flow.root, 'run.json'); flow.save(configPath, flow.config);
    const runner = fileURLToPath(new URL('../../scripts/run-feature.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [runner, 'bootstrap', configPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const store = new ProjectStore(flow.database, { readOnly: true });
    try { assert.equal(store.get('project-1', 'project-1')?.kind, 'project'); } finally { store.close(); }
    assert.equal(existsSync(hookPath), false);
    flow.save(hookPath, hooks); // Operator enables the hook only AFTER validated bootstrap.
    const registry = JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8'));
    const event = { version: 1, event: 'worker.start.before', home: flow.home, task_id: 'ordinary-task',
      source_brief_path: null, brief_path: null, brief_sha256: null };
    assert.deepEqual(checkStartingWorker(registry, event), { ok: true, managed: false });
    assert.throws(() => runFeature(flow.config, 'prepare')); // An agent preflight failure cannot remove the bootstrap context.
    assert.deepEqual(checkStartingWorker(registry, event), { ok: true, managed: false });
    assert.equal(flow.wrapper.read().calls.length, 0);
    assert.equal(existsSync(join(flow.root, 'agents.jsonl')), false);
  } finally { flow.close(); }
});

test('review 1201 finding 5: prepare refuses an unbootstrapped database before any task or agent call', () => {
  const flow = scenario({ bootstrap: false });
  try {
    assert.throws(() => runFeature(flow.config, 'prepare'), /bootstrap_project_unavailable/);
    assert.equal(existsSync(flow.database), false);
    assert.equal(flow.wrapper.read().calls.length, 0);
    assert.equal(existsSync(join(flow.root, 'agents.jsonl')), false);
  } finally { flow.close(); }
});

for (const field of ['goal', 'exclusions'] as const) {
  test(`review 1207: changed project ${field} is refused read-only before capture`, () => {
    const flow = scenario();
    try {
      flow.config.project = structuredClone(flow.config.project);
      if (field === 'goal') flow.config.project.goal = 'A changed goal that was never initialized';
      else flow.config.project.exclusions.push('A changed exclusion that was never initialized');
      const before = readFileSync(flow.database);
      assert.throws(() => runFeature(flow.config, 'prepare'), /project_initialization_mismatch/);
      assert.deepEqual(readFileSync(flow.database), before);
      const store = new ProjectStore(flow.database, { readOnly: true });
      try { assert.equal(store.records('project-1').some((record) => record.kind === 'request'), false); }
      finally { store.close(); }
      assert.equal(flow.wrapper.read().calls.length, 0);
      assert.equal(existsSync(join(flow.root, 'agents.jsonl')), false);
      assert.equal(existsSync(join(flow.config.runDirectory, 'prepare.started')), false);
    } finally { flow.close(); }
  });
}

test('one captured feature reaches product completion through the existing CLI and fake FirstMate', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    assert.ok(flow.wrapper.read().trace.every((entry) => entry.mappingSaved));
    runFeature(flow.config, 'start');
    const result = runFeature(flow.config, 'review') as any;
    assert.equal(result.review.outcome, 'passed');
    const store = new ProjectStore(flow.database);
    try { assert.equal(validateReviewForCompletion(store.history('project-1'), result.review).ok, true); }
    finally { store.close(); }
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.step), ['understand', 'design', 'plan', 'detail', 'plan_check', 'instruction_check', 'instruction_check', 'instruction_check', 'product_review']);
    assert.equal(new Set(calls.map((call) => call.pid)).size, calls.length);
    assert.deepEqual(JSON.parse(readFileSync(join(flow.root, 'spawn-args.json'), 'utf8')).slice(-6), ['--harness', 'codex', '--model', 'build', '--effort', 'medium']);
    assert.equal((runFeature(flow.config, 'start') as { state: string }).state, 'awaiting_worker_return');
  } finally { flow.close(); }
});

test('review 1: task stays held until its prepared brief passes the instruction check', () => {
  const flow = scenario();
  try {
    flow.mode({ requirePreparationHold: true });
    runFeature(flow.config, 'prepare');
    const state = flow.wrapper.read();
    assert.ok(state.trace.some((entry) => entry.task.held));
    assert.equal(state.tasks['milestone-worker']!.held, false);
  } finally { flow.close(); }
});

for (const failure of ['missing-hook', 'missing-registry', 'removed-during-check', 'failed-brief'] as const) {
  test(`review 1: ${failure} cannot expose runnable work`, () => {
    const flow = scenario();
    try {
      if (failure === 'missing-hook') rmSync(join(flow.home, 'config', 'hooks.json'));
      if (failure === 'missing-registry') flow.save(flow.config.hookRegistry, { version: 1, projects: [] });
      if (failure === 'removed-during-check') flow.mode({ removeHookDuringCheck: true });
      if (failure === 'failed-brief') {
        flow.mode({ narrow: true });
        // Keep the original request broad; the independently checked candidate is narrowed.
        const detail = flow.outputs.detail.records.find((record) => (record as { kind: string }).kind === 'detailed_plan_task') as object;
        Object.assign(detail, { expectedBehavior: 'Implement feature X for ERPNext only.' });
        flow.save(join(flow.root, 'outputs.json'), flow.outputs);
      }
      assert.throws(() => runFeature(flow.config, 'prepare'));
      assert.ok(flow.wrapper.read().trace.every((entry) => !entry.ready.includes('milestone-worker')));
    } finally { flow.close(); }
  });
}

test('review 2: a conflicting assignment block anywhere in the launch overlay is refused without a judge call', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    const source = join(flow.data, 'milestone-worker', 'brief.md');
    const text = readFileSync(source, 'utf8') + '\n<!-- software-factory-assignment:v1:begin -->\n```json\n{"assignment":{"id":"other","revision":1}}\n```\n<!-- software-factory-assignment:v1:end -->\n';
    const candidate = join(flow.root, 'conflicting-launch.md'); writeFileSync(candidate, text);
    const before = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
    const report = checkStartingWorker(JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8')), {
      version: 1, event: 'worker.start.before', home: flow.home, task_id: 'milestone-worker', source_brief_path: source,
      brief_path: candidate, brief_sha256: createHash('sha256').update(text).digest('hex'),
    });
    assert.equal(report.ok, false);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), before);
  } finally { flow.close(); }
});

for (const context of ['empty', 'truncated', 'wrong-schema', 'wrong-project'] as const) {
  test(`review 3: hook rejects ${context} database without changing it or classifying task as unmanaged`, () => {
    const flow = scenario();
    try {
      const database = join(flow.root, 'unavailable.sqlite');
      if (context === 'empty') writeFileSync(database, '');
      if (context === 'truncated') writeFileSync(database, 'SQLite format 3\0broken');
      if (context === 'wrong-schema') {
        const db = new DatabaseSync(database); db.exec('PRAGMA user_version=1; CREATE TABLE record_history (body TEXT)'); db.close();
      }
      if (context === 'wrong-project') {
        const store = new ProjectStore(database);
        store.importProject({ schemaVersion: 1, projectId: 'project-1', history: [flow.config.project], receipts: [] }); store.close();
      }
      const projectId = context === 'wrong-project' ? 'another-project' : 'project-1';
      flow.save(flow.config.hookRegistry, { version: 1, projects: [{ home: flow.home, projectId, database, agentConfig: flow.config.agentConfig }] });
      const before = readFileSync(database);
      const result = spawnSync(script, [flow.config.hookRegistry], { encoding: 'utf8', input: JSON.stringify({
        version: 1, event: 'worker.start.before', home: flow.home, task_id: 'milestone-worker',
        source_brief_path: null, brief_path: null, brief_sha256: null,
      }) });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.deepEqual(readFileSync(database), before);
    } finally { flow.close(); }
  });
}

test('review 5: multiline behavior produces a single-line native title and retains full instructions', () => {
  const flow = scenario();
  try {
    const behavior = 'Deliver feature X across systems.\r\nVerify ERPNext and another system.';
    const task = flow.outputs.detail.records.find((record) => (record as { kind: string }).kind === 'detailed_plan_task') as object;
    Object.assign(task, { expectedBehavior: behavior }); flow.save(join(flow.root, 'outputs.json'), flow.outputs);
    runFeature(flow.config, 'prepare');
    assert.equal(flow.wrapper.read().tasks['milestone-worker']!.title, 'Deliver feature X across systems. Verify ERPNext and another system.');
    const store = new ProjectStore(flow.database);
    try { const saved = store.get('project-1', 'task-1'); assert.ok(saved?.kind === 'detailed_plan_task'); assert.equal(saved.expectedBehavior, behavior); }
    finally { store.close(); }
    assert.ok(readFileSync(join(flow.data, 'milestone-worker', 'brief.md'), 'utf8').includes(behavior));
  } finally { flow.close(); }
});

test('review 7: default outer deadline exceeds a maximum hook budget and launch allowance', () => {
  const flow = scenario();
  try { assert.ok(FeatureRunConfigSchema.parse(flow.config).firstMate.timeoutMs > 900_000 + 120_000 + 1000); }
  finally { flow.close(); }
});

test('review 7: a short configured spawn deadline is rejected before task creation', () => {
  const flow = scenario();
  try {
    flow.config.firstMate.timeoutMs = 120_000;
    assert.throws(() => runFeature(flow.config, 'prepare'), /spawn_deadline_too_short/);
    assert.equal(flow.wrapper.read().calls.length, 0);
  } finally { flow.close(); }
});

test('review 7: serial before-hook budgets are added rather than using only the instruction hook', () => {
  const flow = scenario();
  try {
    flow.config.firstMate.timeoutMs = 700_000;
    const path = join(flow.home, 'config', 'hooks.json'); const hooks = JSON.parse(readFileSync(path, 'utf8'));
    hooks.hooks.push({ id: 'other-check', event: 'worker.start.before', argv: [process.execPath, '-e', 'process.exit(0)'], timeout_seconds: 300 });
    flow.save(path, hooks);
    assert.throws(() => runFeature(flow.config, 'prepare'), /spawn_deadline_too_short/);
    assert.equal(flow.wrapper.read().calls.length, 0);
  } finally { flow.close(); }
});

test('review 7: changed hook budgets are revalidated before starting the worker', () => {
  const flow = scenario();
  try {
    flow.config.firstMate.timeoutMs = 500_000; runFeature(flow.config, 'prepare');
    const path = join(flow.home, 'config', 'hooks.json'); const hooks = JSON.parse(readFileSync(path, 'utf8'));
    hooks.hooks[0].timeout_seconds = 900; flow.save(path, hooks);
    assert.throws(() => runFeature(flow.config, 'start'), /spawn_deadline_too_short/);
    assert.equal(existsSync(join(flow.root, 'worker-started')), false);
    assert.equal(existsSync(join(flow.config.runDirectory, 'start.started')), false);
  } finally { flow.close(); }
});

test('review 7: the instruction hook budget also has to cover its configured agent', () => {
  const flow = scenario();
  try {
    const agents = JSON.parse(readFileSync(flow.config.agentConfig, 'utf8')); agents.timeoutMs = 300_000;
    flow.save(flow.config.agentConfig, agents);
    assert.throws(() => runFeature(flow.config, 'prepare'), /instruction_hook_deadline_too_short/);
    assert.equal(flow.wrapper.read().calls.length, 0);
  } finally { flow.close(); }
});

test('ERPNext-only launch overlay is vetoed before the fake worker starts', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare'); flow.mode({ narrow: true });
    assert.throws(() => runFeature(flow.config, 'start'), /firstmate-spawn_failed/);
    assert.equal(existsSync(join(flow.root, 'worker-started')), false);
    const report = JSON.parse(readFileSync(join(flow.root, 'hook-result.json'), 'utf8'));
    assert.equal(report.ok, false); assert.ok(report.findings.some((finding: any) => finding.code === 'narrowed_generality'));
  } finally { flow.close(); }
});

test('legacy return perfectly following a bad brief fails product review despite green technical evidence', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    // Simulate a historical/imported bad assignment that reached implementation
    // before the new hook existed. No production bypass is provided.
    const store = new ProjectStore(flow.database);
    try {
      const assignment = store.get('project-1', 'milestone-worker-assignment'); assert.ok(assignment?.kind === 'assignment');
      const decision = { kind: 'decision_change', id: 'legacy-bad-brief', projectId: 'project-1', schemaVersion: 1,
        revision: 1, createdAt: at, updatedAt: at, questionOrChange: 'Synthetic historical instruction error',
        affectedRecords: [ref(assignment)], rationale: 'Negative test', disposition: 'selected', sourceRefs: [recordSource(assignment)], scopeChanges: [] };
      store.mutate({ schemaVersion: 1, id: 'legacy-error', projectId: 'project-1', issuedAt: at, idempotencyKey: 'legacy-error',
        command: 'record_decision_suggestion', targetId: assignment.id, expectedRevision: 1, payload: { decision } },
      () => [{ ...assignment, revision: 2, instructionText: 'Implement feature X for ERPNext only.' }, decision]);
    } finally { store.close(); }
    const manifest = join(flow.config.runDirectory, 'prepared.json');
    const prepared = JSON.parse(readFileSync(manifest, 'utf8')); prepared.assignment.revision = 2; flow.save(manifest, prepared);
    flow.mode({ badDelivery: true }); execFileSync(flow.returnWorker);
    assert.throws(() => runFeature(flow.config, 'review'), /review-product_failed/);
    const report = JSON.parse(readFileSync(join(flow.config.runDirectory, 'review-product.stdout'), 'utf8'));
    assert.equal(report.review.outcome, 'failed'); assert.equal(report.review.conformance.technicalReviews[0].verdict, 'passed');
    assert.equal(report.review.planConformance.result, 'failed');
  } finally { flow.close(); }
});

test('plan reviewer failure stops before a task or worker is created', () => {
  const flow = scenario();
  try {
    flow.mode({ planFailure: true }); assert.throws(() => runFeature(flow.config, 'prepare'), /plan_review_failed/);
    assert.equal(flow.wrapper.read().calls.length, 0); assert.equal(existsSync(join(flow.root, 'worker-started')), false);
  } finally { flow.close(); }
});

test('hook passes unmanaged tasks and fails closed for missing managed context and changed candidate digest', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    const registry = JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8'));
    const source = join(flow.data, 'milestone-worker', 'brief.md'); const text = readFileSync(source, 'utf8');
    const event = { version: 1, event: 'worker.start.before', home: flow.home, task_id: 'ordinary-task', source_brief_path: null, brief_path: null, brief_sha256: null };
    assert.deepEqual(checkStartingWorker(registry, event), { ok: true, managed: false });
    const managed = { ...event, task_id: 'milestone-worker', source_brief_path: source, brief_path: source,
      brief_sha256: createHash('sha256').update(text).digest('hex') };
    const alias = join(flow.root, 'home-alias'); symlinkSync(flow.home, alias);
    assert.equal(checkStartingWorker(registry, { ...managed, home: alias }).managed, true);
    assert.equal(checkStartingWorker(registry, { ...managed, brief_sha256: '0'.repeat(64) }).ok, false);
    assert.throws(() => checkStartingWorker(registry, { ...managed, brief_path: null }), /hook_candidate_missing/);
    const missing = structuredClone(registry); missing.projects[0].database = join(flow.root, 'absent.sqlite');
    assert.throws(() => checkStartingWorker(missing, event), /hook_database_unavailable/);
    assert.equal(existsSync(missing.projects[0].database), false);
    const cli = spawnSync(script, [flow.config.hookRegistry], { input: '{broken', encoding: 'utf8' });
    assert.equal(cli.status, 1);
  } finally { flow.close(); }
});
