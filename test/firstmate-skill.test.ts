import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FeatureRunConfigSchema, ProjectStore, runFeature, taskReadinessReasons, type ImplementationPlanRevision } from '../src/index.js';
import { scenario } from './milestone-helper.js';

const factory = fileURLToPath(new URL('../../', import.meta.url));
const materializer = join(factory, 'skills/software-factory/scripts/materialize-run.mjs');

// The fake FirstMate interprets its home registry and selects sources, as the
// skill instructs. The owner supplies only plain request text, never run.json.
function intake(twoTasks = false, independentBranch = false) {
  const request = 'Build feature X for every connected system, ERPNext is only an example.\nPreserve "quotes", $values and Unicode: שלום.\n';
  const flow = scenario({ bootstrap: false, factoryLayout: true, twoTasks, independentBranch, originalRequest: request });
  const registration = `| project-1 | ${flow.config.repository} | local-only |`;
  writeFileSync(join(flow.data, 'projects.md'), registration + '\n');
  const fork = join(flow.root, 'fork'); mkdirSync(join(fork, 'bin'), { recursive: true });
  for (const [name, executable] of Object.entries({ brief: flow.config.firstMate.briefExecutable,
    spawn: flow.config.firstMate.spawnExecutable, inbox: flow.config.firstMate.inboxExecutable,
    'tasks-axi': flow.config.firstMate.tasksExecutable, 'fleet-snapshot': flow.config.firstMate.snapshotExecutable! })) {
    symlinkSync(executable, join(fork, 'bin', `fm-${name}.sh`));
  }
  const settingsPath = join(flow.home, 'config/software-factory.json');
  flow.save(settingsPath, { factoryRoot: factory, home: flow.home, fork, agentTemplate: flow.config.agentConfig,
    hookRegistry: flow.config.hookRegistry, mode: 'local-only', yolo: 'off', uiOrigin: 'http://127.0.0.1:3185' });
  const selectionPath = join(flow.root, 'selection.json');
  flow.save(selectionPath, { projectName: 'project-1', repository: flow.config.repository, registration,
    project: { goal: 'Exercise common interfaces', intendedUser: 'Operator', priorities: [], exclusions: [], vocabulary: {}, timezone: 'UTC' },
    sources: [{ path: join(flow.config.repository, 'baseline.txt'), reason: 'Establish behavior before the feature' }],
    baselineDescription: 'Feature X is absent at this commit' });
  const materialized = JSON.parse(execFileSync(process.execPath, [materializer, settingsPath, selectionPath, flow.config.requestFile], { encoding: 'utf8' }));
  const config = FeatureRunConfigSchema.parse(JSON.parse(readFileSync(materialized.configPath, 'utf8')));
  // Bootstrap before publishing this DB to the already installed hook registry.
  flow.save(config.hookRegistry, { version: 1, projects: [] });
  runFeature(config, 'bootstrap');
  flow.save(config.hookRegistry, { version: 1, projects: [{ home: flow.home, projectId: 'project-1', database: config.database, agentConfig: config.agentConfig }] });
  return { flow, config, request, materialized, settingsPath, selectionPath };
}

test('chat request materializes immutable sources, bootstraps, builds and reviews one task', () => {
  const { flow, config, request, materialized, settingsPath, selectionPath } = intake();
  try {
    assert.equal(readFileSync(config.requestFile, 'utf8'), request);
    const choice = JSON.parse(readFileSync(join(config.runDirectory, 'source-choice.json'), 'utf8'));
    assert.match(choice.files[0].reason, /before the feature/);
    writeFileSync(join(config.repository, 'baseline.txt'), 'Changed after intake');
    assert.equal(readFileSync(config.sourceFiles[0]!.path, 'utf8'), 'Feature X absent.');
    const runner = join(factory, 'scripts/run-feature.mjs');
    const planned = JSON.parse(execFileSync(process.execPath, [runner, 'plan', materialized.configPath], { encoding: 'utf8' }));
    assert.equal(planned.tasks.length, 1);
    const taskId = planned.tasks[0].taskId;
    execFileSync(process.execPath, [runner, 'prepare-task', materialized.configPath, taskId], { encoding: 'utf8' });
    runFeature(config, 'start', taskId);
    assert.equal((runFeature(config, 'review', taskId) as any).review.outcome, 'passed');
    assert.equal((runFeature(config, 'review-all') as any).review.outcome, 'passed');
    const store = new ProjectStore(config.database, { readOnly: true });
    try {
      const captured = store.records('project-1').find((record) => record.kind === 'request');
      assert.ok(captured?.kind === 'request'); assert.equal(captured.originalText, request); assert.equal(captured.channel, 'chat');
    } finally { store.close(); }
    // A second request reuses revision 1 of the initialized project, including its timestamps.
    const again = JSON.parse(execFileSync(process.execPath, [materializer, settingsPath, selectionPath, config.requestFile], { encoding: 'utf8' }));
    assert.equal(again.database, materialized.database);
    assert.deepEqual(JSON.parse(readFileSync(again.configPath, 'utf8')).project, config.project);
  } finally { flow.close(); }
});

test('two dependent tasks stay held until producer evidence, then both receive original-request review', () => {
  const { flow, config } = intake(true);
  try {
    const planned = runFeature(config, 'plan') as any;
    assert.equal(planned.tasks.length, 2);
    const [producer, consumer] = planned.tasks.map((task: any) => task.taskId);
    const pending = runFeature(config, 'review-all') as any;
    assert.equal(pending.state, 'awaiting_worker_returns');
    assert.deepEqual(pending.pendingTasks, [producer, consumer]);
    assert.equal(existsSync(join(config.runDirectory, 'review-all.started')), false);
    assert.equal(flow.wrapper.read().tasks[consumer]!.held, true);
    assert.ok(flow.wrapper.read().tasks[consumer]!.deps.some((edge) => edge.id === producer));
    const store = new ProjectStore(config.database, { readOnly: true });
    try {
      const records = store.records('project-1');
      const mapping = records.find((record) => record.kind === 'task_mapping' && record.firstMateTaskId === consumer);
      assert.ok(mapping?.kind === 'task_mapping');
      assert.ok(taskReadinessReasons(records, mapping).some((reason) => reason.includes('Product prerequisite not met')));
    } finally { store.close(); }
    runFeature(config, 'prepare-task', producer); runFeature(config, 'start', producer);
    const producerReview = runFeature(config, 'review', producer) as any;
    assert.equal(producerReview.review.outcome, 'incomplete');
    assert.equal(producerReview.taskOutcome, 'passed');
    const partial = runFeature(config, 'review-all') as any;
    assert.deepEqual(partial.pendingTasks, [consumer]);
    const snapshot = JSON.parse(readFileSync(join(config.runDirectory, 'review-all-snapshot.json'), 'utf8'));
    assert.deepEqual(snapshot.pendingTasks, [consumer]);
    assert.equal(snapshot.deliveries.length, 1);
    // Normal FirstMate delivery closes the producer in its existing backlog.
    flow.wrapper.edit((native) => { native.tasks[producer]!.state = 'done'; });
    runFeature(config, 'prepare-task', consumer); runFeature(config, 'start', consumer);
    const consumerReview = runFeature(config, 'review', consumer) as any;
    assert.equal(consumerReview.review.outcome, 'incomplete');
    assert.equal(consumerReview.taskOutcome, 'passed');
    assert.equal(consumerReview.state, undefined);
    assert.equal(consumerReview.review.assignments.length, 1);
    const consumerReturnPath = join(config.runDirectory, 'tasks', consumer, 'worker-return.json');
    const changed = JSON.parse(readFileSync(consumerReturnPath, 'utf8'));
    changed.results[0].result = 'untested';
    const changedPath = join(flow.root, 'changed-after-snapshot.json'); flow.save(changedPath, changed);
    flow.mode({ publishReturnDuringReview: { source: changedPath, path: consumerReturnPath } });
    const final = runFeature(config, 'review-all') as any;
    assert.equal(final.review.outcome, 'passed');
    assert.equal(JSON.parse(readFileSync(consumerReturnPath, 'utf8')).results[0].result, 'untested');
    const finalSnapshot = JSON.parse(readFileSync(join(config.runDirectory, 'review-all-snapshot.json'), 'utf8'));
    assert.deepEqual(finalSnapshot.pendingTasks, []);
    assert.equal(finalSnapshot.deliveries[1].results[0].result, 'passed');
    const evidence = JSON.parse(readFileSync(join(config.runDirectory, 'review-all-input.json'), 'utf8'));
    assert.equal(evidence.additionalDeliveries.length, 1);
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.step === 'instruction_check').length, 6);
    const aggregate = JSON.parse(calls.at(-1).prompt.trimEnd().split('\n').at(-1));
    assert.equal(aggregate.deliveries.length, 2);
    assert.equal(aggregate.technicalReviews.length, 2);
    assert.equal(aggregate.assignedCriteria.length, 2);
  } finally { flow.close(); }
});

test('failed plan check stops before any task is queued', () => {
  const { flow, config } = intake(true);
  try {
    flow.mode({ planFailure: true });
    assert.throws(() => runFeature(config, 'plan'), /plan_review_failed/);
    assert.equal(flow.wrapper.read().calls.length, 0);
    assert.equal(existsSync(join(config.runDirectory, 'planned.json')), false);
    const failure = JSON.parse(readFileSync(join(config.runDirectory, 'plan-check-agent.json'), 'utf8'));
    assert.match(failure.verdict.findings[0].message, /Missing required behavior/);
  } finally { flow.close(); }
});

test('failed preparation instruction check retains the native hold and never starts a worker', () => {
  const { flow, config } = intake();
  try {
    const planned = runFeature(config, 'plan') as any;
    const taskId = planned.tasks[0].taskId;
    const agents = JSON.parse(readFileSync(config.agentConfig, 'utf8'));
    writeFileSync(agents.executables.codex, readFileSync(agents.executables.codex, 'utf8').replace("out={verdict:'pass',findings:[]};",
      "out={verdict:'fail',findings:[{type:'omission',message:'Missing required behavior',quotes:[{source:'original_request',text:snapshot.originalRequests[0].text}]}]};"));
    assert.throws(() => runFeature(config, 'prepare-task', taskId), /check-brief_failed/);
    assert.equal(flow.wrapper.read().tasks[taskId]!.held, true);
    assert.equal(existsSync(join(flow.root, 'worker-started')), false);
    assert.equal(existsSync(join(config.runDirectory, 'tasks', taskId, 'prepared.json')), false);
  } finally { flow.close(); }
});

test('a passing semantic review cannot bypass the deterministic plan check', () => {
  const { flow, config } = intake(true);
  try {
    const plan = flow.outputs.detail.records.find((record): record is ImplementationPlanRevision => (record as { kind: string }).kind === 'implementation_plan_revision');
    assert.ok(plan?.kind === 'implementation_plan_revision');
    plan.workflow!.finalVerification = [];
    flow.save(join(flow.root, 'outputs.json'), flow.outputs);
    assert.throws(() => runFeature(config, 'plan'), /check-plan_failed/);
    assert.equal(flow.wrapper.read().calls.length, 0);
    const check = JSON.parse(readFileSync(join(config.runDirectory, 'check-plan.stdout'), 'utf8'));
    assert.ok(check.check.findings.some((finding: { code: string }) => finding.code === 'missing_integration'));
  } finally { flow.close(); }
});

test('a failed product judgment cannot become a provisional slice pass', () => {
  const { flow, config } = intake(true);
  try {
    const planned = runFeature(config, 'plan') as any;
    const [producer, consumer] = planned.tasks.map((task: any) => task.taskId);
    runFeature(config, 'prepare-task', producer);
    flow.mode({ badDelivery: true }); runFeature(config, 'start', producer);
    assert.throws(() => runFeature(config, 'review', producer), /product_review_failed/);
    assert.equal(flow.wrapper.read().tasks[consumer]!.held, true);
    const review = JSON.parse(readFileSync(join(config.runDirectory, 'tasks', producer, 'review-product.stdout'), 'utf8')).review;
    assert.equal(review.outcome, 'failed');
    assert.equal(review.conformance.technicalReviews[0].verdict, 'passed');
  } finally { flow.close(); }
});

for (const twoTasks of [false, true]) {
  test(`an untested worker result cannot become pending delivery evidence (${twoTasks ? 'dependent' : 'single'} plan)`, () => {
    const { flow, config } = intake(twoTasks);
    try {
      const planned = runFeature(config, 'plan') as any;
      const taskId = planned.tasks[0].taskId;
      runFeature(config, 'prepare-task', taskId); runFeature(config, 'start', taskId);
      const returnPath = join(config.runDirectory, 'tasks', taskId, 'worker-return.json');
      const returned = JSON.parse(readFileSync(returnPath, 'utf8'));
      for (const result of returned.results) result.result = 'untested';
      flow.save(returnPath, returned);
      assert.throws(() => runFeature(config, 'review', taskId), /product_review_incomplete/);
      const review = JSON.parse(readFileSync(join(config.runDirectory, 'tasks', taskId, 'review-product.stdout'), 'utf8')).review;
      assert.equal(review.outcome, 'incomplete');
      assert.equal(review.conformance.technicalReviews[0].verdict, 'passed');
      assert.equal(review.sourceComparison.result, 'passed');
      assert.equal(review.instructionFidelity.result, 'passed');
      assert.equal(review.planConformance.result, 'passed');
      assert.ok(review.conformance.verdict.criteria.every((criterion: { state: string }) => criterion.state === 'accomplished'));
    } finally { flow.close(); }
  });
}

test('an independent failing sibling does not block A or its consumer C', () => {
  const { flow, config } = intake(true, true);
  try {
    const planned = runFeature(config, 'plan') as any;
    const [a, c, b] = planned.tasks.map((task: any) => task.taskId);
    runFeature(config, 'prepare-task', b); runFeature(config, 'start', b);
    const bReturn = JSON.parse(readFileSync(join(config.runDirectory, 'tasks', b, 'worker-return.json'), 'utf8'));
    flow.mode({ technicalFailureCommits: [bReturn.deliveredArtifact.revision] });
    assert.throws(() => runFeature(config, 'review', b), /product_review_failed/);
    runFeature(config, 'prepare-task', a); runFeature(config, 'start', a);
    const aReview = runFeature(config, 'review', a) as any;
    assert.equal(aReview.taskOutcome, 'passed');
    assert.equal(aReview.review.assignments.length, 1);
    flow.wrapper.edit((native) => { native.tasks[a]!.state = 'done'; });
    runFeature(config, 'prepare-task', c); runFeature(config, 'start', c);
    const cReview = runFeature(config, 'review', c) as any;
    assert.equal(cReview.taskOutcome, 'passed');
    assert.equal(cReview.review.assignments.length, 1);
    assert.throws(() => runFeature(config, 'review-all'), /review-product_failed/);
    const aggregate = JSON.parse(readFileSync(join(config.runDirectory, 'review-product.stdout'), 'utf8')).review;
    assert.equal(aggregate.outcome, 'failed');
    assert.equal(aggregate.assignments.length, 3);
  } finally { flow.close(); }
});

test('a sibling return arriving during A review cannot affect A delivery', () => {
  const { flow, config } = intake(true, true);
  try {
    const planned = runFeature(config, 'plan') as any;
    const [a, , b] = planned.tasks.map((task: any) => task.taskId);
    runFeature(config, 'prepare-task', b); runFeature(config, 'start', b);
    const bReturn = join(config.runDirectory, 'tasks', b, 'worker-return.json');
    const delayed = join(flow.root, 'delayed-return.json'); renameSync(bReturn, delayed);
    runFeature(config, 'prepare-task', a); runFeature(config, 'start', a);
    flow.mode({ publishReturnDuringReview: { source: delayed, path: bReturn } });
    const reviewed = runFeature(config, 'review', a) as any;
    assert.equal(existsSync(bReturn), true);
    assert.equal(reviewed.taskOutcome, 'passed');
    assert.equal(reviewed.review.assignments.length, 1);
    assert.equal(reviewed.review.conformance.technicalReviews.length, 1);
  } finally { flow.close(); }
});
