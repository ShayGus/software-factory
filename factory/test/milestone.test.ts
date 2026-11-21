import { scenario } from './milestone-helper.js';
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkStartingWorker, DetailedPlanTaskSchema, ProjectStore, ref, recordSource, runFeature,
  validateReviewForCompletion, FeatureRunConfigSchema, prepareWorkerBrief, applyCommand, buildEditCommand,
  assertNoOwnerQuestions, type DecisionChange } from '../src/index.js';

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
  return { version: 1, event: 'worker.start.before', home: flow.home, project: flow.config.repository, task_id: 'milestone-worker',
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
    const { evidence } = JSON.parse(call.prompt.trimEnd().split('\n').at(-1)!);
    const judged = JSON.parse(readFileSync(evidence, 'utf8'));
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

test('review 1201 finding 5: bootstrap works before hook enablement without an agent config and preserves factory membership', () => {
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
    const event = { version: 1, event: 'worker.start.before', home: flow.home, project: flow.config.repository, task_id: 'ordinary-task',
      source_brief_path: null, brief_path: null, brief_sha256: null };
    assert.throws(() => checkStartingWorker(registry, event), /factory_task_requires_mapping/);
    assert.throws(() => runFeature(flow.config, 'prepare')); // An agent preflight failure cannot remove the bootstrap context.
    assert.throws(() => checkStartingWorker(registry, event), /factory_task_requires_mapping/);
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
    for (const call of calls) {
      const original = readFileSync(flow.config.requestFile, 'utf8');
      assert.equal(call.prompt.includes(original), false, call.step);
      assert.ok(call.prompt.length < 10_000, call.step);
      const files = JSON.parse(call.prompt.trimEnd().split('\n').at(-1));
      assert.equal(files.runDirectory, flow.config.runDirectory);
      assert.deepEqual(files.repositories, [flow.config.repository]);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(flow.root, 'spawn-args.json'), 'utf8')).slice(-6), ['--harness', 'codex', '--model', 'build', '--effort', 'medium']);
    assert.equal((runFeature(flow.config, 'start') as { state: string }).state, 'awaiting_worker_return');
  } finally { flow.close(); }
});

test('a new planning attempt reads its own request and source paths, and saves agent failure output', () => {
  const flow = scenario();
  try {
    flow.mode({ planFailure: true });
    assert.throws(() => runFeature(flow.config, 'plan'), /plan_review_failed/);
    const store = new ProjectStore(flow.database, { readOnly: true });
    try {
      assert.ok(store.history('project-1').some((record) => record.kind === 'implementation_plan_revision'));
    } finally { store.close(); }

    const source = join(flow.config.repository, 'large-source.txt');
    const sourceText = 'CONTENTS_TO_READ_FROM_DISK\n'.repeat(45_000);
    writeFileSync(source, sourceText);
    const config = { ...flow.config, runDirectory: join(flow.root, 'new-attempt'), clientRequestId: 'new-attempt',
      sourceFiles: [{ source: { uri: 'research:large-source' }, path: source }] };
    flow.mode({ failStep: 'understand' });
    assert.throws(() => runFeature(config, 'plan'), (error: unknown) => {
      assert.ok(error instanceof Error);
      const failure = /^understand_agent_failed: 17; inspect (.+\/agent\.stderr)$/u.exec(error.message);
      assert.ok(failure?.[1], error.message);
      assert.equal(readFileSync(failure[1], 'utf8'), 'Agent diagnostic before exit.\n');
      const call = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trimEnd().split('\n').at(-1)!;
      const { prompt } = JSON.parse(call);
      const files = JSON.parse(prompt.trimEnd().split('\n').at(-1));
      assert.equal(files.evidence, join(dirname(failure[1]), 'input.json'));
      assert.equal(files.runDirectory, config.runDirectory);
      assert.equal(readFileSync(files.requestFile, 'utf8'), readFileSync(config.requestFile, 'utf8'));
      const input = JSON.parse(readFileSync(files.evidence, 'utf8'));
      assert.deepEqual(input.records.map((record: { kind: string }) => record.kind), ['request']);
      assert.equal(input.records[0].clientRequestId, config.clientRequestId);
      assert.deepEqual(input.research, config.sourceFiles);
      assert.equal(prompt.includes('CONTENTS_TO_READ_FROM_DISK'), false);
      assert.ok(prompt.length < 10_000);
      return true;
    });
  } finally { flow.close(); }
});

test('review 1: task stays held until its prepared brief passes the instruction check', () => {
  const flow = scenario();
  try {
    flow.mode({ requirePreparationHold: true });
    runFeature(flow.config, 'prepare');
    const state = flow.wrapper.read();
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
      version: 1, event: 'worker.start.before', home: flow.home, project: flow.config.repository, task_id: 'milestone-worker', source_brief_path: source,
      brief_path: candidate, brief_sha256: createHash('sha256').update(text).digest('hex'),
    });
    assert.equal(report.ok, false);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), before);
  } finally { flow.close(); }
});

for (const context of ['empty', 'wrong-project'] as const) {
  test(`review 3: hook rejects ${context} database without changing it or classifying task as unmanaged`, () => {
    const flow = scenario();
    try {
      const database = join(flow.root, 'unavailable.sqlite');
      if (context === 'empty') writeFileSync(database, '');
      if (context === 'wrong-project') {
        const store = new ProjectStore(database);
        store.importProject({ schemaVersion: 1, projectId: 'project-1', history: [flow.config.project], receipts: [] }); store.close();
      }
      const projectId = context === 'wrong-project' ? 'another-project' : 'project-1';
      flow.save(flow.config.hookRegistry, { version: 1, projects: [{ home: flow.home, projectId, database, agentConfig: flow.config.agentConfig }] });
      const before = readFileSync(database);
      const result = spawnSync(script, [flow.config.hookRegistry], { encoding: 'utf8', input: JSON.stringify({
        version: 1, event: 'worker.start.before', home: flow.home, project: flow.config.repository, task_id: 'milestone-worker',
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

test('a failed product review sends scoped feedback to the original worker and reviews its new commit', () => {
  const flow = scenario();
  try {
    const send = join(flow.root, 'send.mjs');
    const sent = join(flow.root, 'feedback.json');
    writeFileSync(send, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(sent)},JSON.stringify({target:process.argv[2],message:process.argv[3],
 generation:process.env.FM_SEND_EXPECTED_SPAWN_GEN,idempotent:process.env.FM_SEND_IDEMPOTENT}));`, { mode: 0o755 });
    const config = { ...flow.config, firstMate: { ...flow.config.firstMate, sendExecutable: send } };
    flow.mode({ badDelivery: true, exposeWorkerGeneration: true });
    runFeature(config, 'prepare');
    runFeature(config, 'start');
    const awaiting = runFeature(config, 'review') as any;
    assert.equal(awaiting.state, 'awaiting_worker_revision');
    const feedback = JSON.parse(readFileSync(sent, 'utf8'));
    assert.equal(feedback.target, config.taskId);
    assert.equal(feedback.generation, 'generation-1');
    assert.equal(feedback.idempotent, '1');
    assert.match(feedback.message, /ERPNext only violates original generality/u);
    flow.mode({ returnRevision: 2 });
    execFileSync(flow.returnWorker, [config.taskId]);
    const revised = runFeature(config, 'review') as any;
    assert.equal(revised.review.outcome, 'passed');
    assert.equal(revised.review.revision, 2);
    assert.notEqual(revised.review.reviewedArtifacts[0].revision, awaiting.review.reviewedArtifacts[0].revision);
  } finally { flow.close(); }
});

test('a semantic instruction failure repairs the brief with the original author before dispatch', () => {
  const flow = scenario();
  try {
    const task = DetailedPlanTaskSchema.parse(flow.outputs.detail.records.find((record) =>
      typeof record === 'object' && record !== null && 'kind' in record && record.kind === 'detailed_plan_task'));
    const instructionOmission = 'Verify every supported connected system.';
    flow.mode({ instructionOmission, requirePreparationHold: true, specEdits: [
      { find: task.expectedBehavior, replace: `${task.expectedBehavior} ${instructionOmission}` },
    ] });
    const prepared = runFeature(flow.config, 'prepare') as any;
    assert.equal(prepared.assignment.revision, 2);
    assert.ok(readFileSync(prepared.briefPath, 'utf8').includes(instructionOmission));
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const author = calls.filter((call) => call.step === 'detail');
    assert.equal(author.length, 2);
    assert.equal(author[0].sessionId, author[1].sessionId);
    assert.equal(flow.wrapper.read().tasks[flow.config.taskId]!.held, false);
  } finally { flow.close(); }
});

test('hook refuses unmapped factory tasks and fails closed for missing managed context and changed candidate digest', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    const registry = JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8'));
    const source = join(flow.data, 'milestone-worker', 'brief.md'); const text = readFileSync(source, 'utf8');
    const event = { version: 1, event: 'worker.start.before', home: flow.home, project: flow.config.repository, task_id: 'ordinary-task', source_brief_path: null, brief_path: null, brief_sha256: null };
    assert.throws(() => checkStartingWorker(registry, event), /factory_task_requires_mapping/);
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


test('factory legacy and orphan tasks require an unambiguous canonical mapping', () => {
  const flow = scenario();
  try {
    const registry = JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8'));
    const fixture = JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8'));
    const template = fixture.find((record: any) => record.kind === 'task_mapping');
    const legacy = { ...template, legacy: true, feature: null, criteria: [], detailedPlanTask: null };
    const event = { version: 1, event: 'worker.start.before', home: flow.home, project: flow.config.repository, task_id: legacy.firstMateTaskId,
      source_brief_path: null, brief_path: null, brief_sha256: null };
    for (const kind of ['passive', 'managed', 'orphan'] as const) {
      const database = join(flow.root, `${kind}.sqlite`);
      const history = fixture.filter((record: any) => ['project', 'request', 'feature_revision', 'criterion', 'design_revision', 'implementation_plan_revision', 'detailed_plan_task', 'task_mapping', 'assignment'].includes(record.kind) &&
        (kind === 'orphan' || record.kind !== 'assignment'))
        .map((record: any) => record.kind === 'project' ? { ...record, firstMateHomeRef: flow.home, repositories: [{ uri: flow.config.repository }] } : kind === 'passive' && record.kind === 'task_mapping' ? legacy : record);
      const store = new ProjectStore(database);
      try { store.importProject({ schemaVersion: 1, projectId: 'project-1', history, receipts: [] }); }
      finally { store.close(); }
      if (kind === 'orphan') {
        const db = new DatabaseSync(database);
        try { db.exec("DELETE FROM record_history WHERE kind = 'task_mapping'"); } finally { db.close(); }
      }
      registry.projects[0].database = database;
      assert.throws(() => checkStartingWorker(registry, event), /hook_(factory_task_requires_mapping|managed_assignment_missing_or_ambiguous|candidate_missing)/);
    }
  } finally { flow.close(); }
});

test('followup: a tied assignment created during judgment invalidates the launch', () => {
  const flow = scenario();
  try {
    runFeature(flow.config, 'prepare');
    const agentConfig = JSON.parse(readFileSync(flow.config.agentConfig, 'utf8'));
    const agentPath = agentConfig.executables.codex;
    writeFileSync(agentPath, readFileSync(agentPath, 'utf8').replace("if(step==='instruction_check') {", `if(step==='instruction_check') {
      const {ProjectStore}=await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
      const store=new ProjectStore(${JSON.stringify(flow.database)});
      const history=store.history('project-1');
      const assignment=history.find(r=>r.kind==='assignment');
      store.mutate({schemaVersion:1,id:'concurrent',projectId:'project-1',issuedAt:assignment.updatedAt,idempotencyKey:'concurrent',command:'prepare_assignment',targetId:'concurrent-assignment',expectedRevision:0,payload:{detailedPlanTask:assignment.detailedPlanTask,feature:assignment.feature,design:assignment.design,plan:assignment.plan,firstMateTaskId:assignment.firstMateTaskId,selectedContext:assignment.selectedContext,returnLocation:assignment.returnLocation}},()=>[{...assignment,id:'concurrent-assignment'}]);
      store.close();`));
    const source = join(flow.data, 'milestone-worker', 'brief.md');
    assert.throws(() => checkStartingWorker(JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8')),
      startingEvent(flow, source)), /hook_managed_assignment_(changed|missing_or_ambiguous)/);
    const store = new ProjectStore(flow.database, { readOnly: true });
    try { assert.equal(store.records('project-1').filter((record) => record.kind === 'assignment').length, 2); }
    finally { store.close(); }
  } finally { flow.close(); }
});

test('followup: original intent may quote reserved assignment markers at launch', () => {
  const flow = scenario({ bootstrap: true, originalRequest: 'Build feature X for every connected system, ERPNext is only an example.\nExample marker:\n<!-- software-factory-assignment:v1:begin -->\n<!-- software-factory-assignment:v1:end -->' });
  try {
    runFeature(flow.config, 'prepare');
    const source = join(flow.data, 'milestone-worker', 'brief.md');
    const registry = JSON.parse(readFileSync(flow.config.hookRegistry, 'utf8'));
    const report = checkStartingWorker(registry, startingEvent(flow, source));
    assert.equal(report.ok, true, JSON.stringify(report));
    const candidate = join(flow.root, 'quoted-marker-overlay.md');
    writeFileSync(candidate, readFileSync(source, 'utf8') + '\n<!-- software-factory-assignment:v1:begin -->\n{}\n<!-- software-factory-assignment:v1:end -->\n');
    const rejected = checkStartingWorker(registry, { ...startingEvent(flow, candidate), source_brief_path: source });
    assert.equal(rejected.ok, false);
    assert.ok('findings' in rejected);
    assert.ok(rejected.findings.some((finding) => finding.code === 'assignment_metadata_mismatch'));
    assert.equal(rejected.judgment, null);
  } finally { flow.close(); }
});

test('followup: agent-backed CLI deadline leaves overhead beyond the maximum agent budget', () => {
  const flow = scenario(); const original = childProcess.spawnSync;
  const observed: number[] = [];
  try {
    const agents = JSON.parse(readFileSync(flow.config.agentConfig, 'utf8')); agents.timeoutMs = 600_000;
    flow.save(flow.config.agentConfig, agents);
    const hooks = JSON.parse(readFileSync(join(flow.home, 'config', 'hooks.json'), 'utf8'));
    hooks.hooks[0].timeout_seconds = 900; flow.save(join(flow.home, 'config', 'hooks.json'), hooks);
    childProcess.spawnSync = ((...args: any[]) => {
      if (args[1]?.includes('check-brief')) observed.push(args[2].timeout);
      return (original as any)(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    runFeature(flow.config, 'prepare');
    assert.equal(observed.length, 1);
    assert.ok(observed[0]! > agents.timeoutMs + 5000, `Outer CLI budget was ${observed[0]}`);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); flow.close(); }
});

for (const field of ['reuseTargets', 'sourceRefs'] as const) for (const uriKind of ['path', 'file'] as const) {
  test(`followup: automated ${field} rejects an unlisted ${uriKind} before brief preparation`, () => {
    const flow = scenario();
    try {
      const secret = join(flow.root, 'unlisted.txt'); writeFileSync(secret, 'PRIVATE_TEST_CONTENT');
      const uri = uriKind === 'file' ? pathToFileURL(secret).href : secret;
      const owner = field === 'reuseTargets' ? flow.outputs.detail.records.find((record: any) => record.kind === 'detailed_plan_task') : flow.outputs.design.records[0];
      Object.assign(owner!, { [field]: [{ uri }] }); flow.save(join(flow.root, 'outputs.json'), flow.outputs);
      assert.throws(() => runFeature(flow.config, 'prepare'), /unauthorized_run_source/);
      assert.equal(existsSync(join(flow.data, 'milestone-worker', 'brief.sf.json')), false);
      const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
      assert.equal(calls.includes('PRIVATE_TEST_CONTENT'), false);
      assert.equal(calls.includes('"step":"instruction_check"'), false);
    } finally { flow.close(); }
  });
}


test('followup: automated preparation accepts an operator source snapshot and preserves the captured request', () => {
  const flow = scenario();
  try {
    const uri = 'research:common-interface'; const snapshot = join(flow.root, 'research.txt');
    writeFileSync(snapshot, 'OPERATOR_SUPPLIED_INTERFACE');
    flow.config.sourceFiles = [{ source: { uri }, path: snapshot }];
    const task = flow.outputs.detail.records.find((record: any) => record.kind === 'detailed_plan_task');
    Object.assign(task!, { reuseTargets: [{ uri }, { uri: flow.config.requestFile }] });
    flow.save(join(flow.root, 'outputs.json'), flow.outputs);
    const originalRequest = readFileSync(flow.config.requestFile, 'utf8');
    const agent = JSON.parse(readFileSync(flow.config.agentConfig, 'utf8')).executables.codex;
    writeFileSync(agent, readFileSync(agent, 'utf8').replace("if(step==='plan_check')",
      `if(step==='plan_check') { const fs=await import('node:fs'); fs.writeFileSync(${JSON.stringify(flow.config.requestFile)},'MUTATED_REQUEST_FILE'); }\nif(step==='plan_check')`));
    runFeature(flow.config, 'prepare');
    const text = readFileSync(join(flow.data, 'milestone-worker', 'brief.md'), 'utf8');
    const coverage = readFileSync(join(flow.data, 'milestone-worker', 'brief.sf.json'), 'utf8');
    assert.ok(text.includes(snapshot));
    assert.ok(!text.includes('OPERATOR_SUPPLIED_INTERFACE'));
    assert.ok(coverage.includes('OPERATOR_SUPPLIED_INTERFACE'));
    assert.ok(text.includes(originalRequest));
    assert.equal(text.includes('MUTATED_REQUEST_FILE'), false);
  } finally { flow.close(); }
});


test('review 1446 finding 2: planners cite the complete configured source reference instead of its snapshot path', () => {
  const flow = scenario();
  try {
    const source = { uri: 'research:configured-interface', excerpt: 'Common interface for every connected system.' };
    const path = join(flow.root, 'operator-snapshot.txt');
    writeFileSync(path, source.excerpt);
    flow.config.sourceFiles = [{ source, path }];
    const agent = JSON.parse(readFileSync(flow.config.agentConfig, 'utf8')).executables.codex;
    const script = readFileSync(agent, 'utf8');
    writeFileSync(agent, script.replace("if(step==='plan_check')", `if(['understand','design','plan','detail'].includes(step)) {
      assert.doesNotMatch(prompt,/use local snapshot paths for external source references/i);
      assert.match(prompt,/complete.{0,25}source.{0,25}reference/i);
      if(step==='design') out.records.find(r=>r.kind==='design_revision').sourceRefs.push(snapshot.research[0].source);
    }
if(step==='plan_check')`));
    runFeature(flow.config, 'prepare');
    const store = new ProjectStore(flow.database, { readOnly: true });
    try {
      const assignment = store.records('project-1').find((record) => record.kind === 'assignment');
      assert.ok(assignment?.kind === 'assignment');
      const selected = assignment.selectedContext.find((context) => context.source.uri === source.uri);
      assert.deepEqual(selected?.source, source);
      assert.equal(selected?.artifact?.uri, path);
      assert.equal(selected?.extract, source.excerpt);
    } finally { store.close(); }
  } finally { flow.close(); }
});


test('an unanswered ticket question prevents observable design/planner invocation', () => {
  const flow = scenario(); const original = childProcess.spawnSync;
  let question: DecisionChange | undefined;
  try {
    childProcess.spawnSync = ((...args: any[]) => {
      const result = (original as any)(...args);
      if (args[1]?.[1] === 'understand' && result.status === 0) {
        const store = new ProjectStore(flow.database);
        try {
          const feature = store.get('project-1', 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
          const time = new Date().toISOString();
          question = { kind: 'decision_change', id: 'owner-question-before-design', projectId: 'project-1', schemaVersion: 1,
            revision: 1, createdAt: time, updatedAt: time, questionOrChange: 'Allow changing the connection?',
            affectedRecords: [ref(feature)], rationale: 'Owner input required', disposition: 'proposed',
            sourceRefs: [recordSource(feature)], scopeChanges: [], choice: { kind: 'product', state: 'open' } };
          applyCommand(store, { schemaVersion: 1, id: 'ask-owner', projectId: 'project-1', issuedAt: time,
            idempotencyKey: 'ask-owner', command: 'record_decision_suggestion', targetId: question.id, expectedRevision: 0,
            payload: { decision: question } });
        } finally { store.close(); }
      }
      return result;
    }) as typeof original;
    syncBuiltinESMExports();
    assert.throws(() => runFeature(flow.config, 'plan'), /ticket_awaiting_owner/);
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).step);
    assert.deepEqual(calls, ['understand']);
    assert.equal(flow.wrapper.read().calls.length, 0);
    const store = new ProjectStore(flow.database);
    try {
      assert.ok(question);
      applyCommand(store, buildEditCommand({ kind: 'answer', decision: question }, { answer: 'Yes', reason: 'Owner answer' },
        'owner-answer', new Date().toISOString()));
      assert.doesNotThrow(() => assertNoOwnerQuestions(store.history('project-1'), 'feature-1'));
      assert.equal(store.records('project-1').filter(record => record.kind === 'request').length, 1);
    } finally { store.close(); }
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); flow.close(); }
});
