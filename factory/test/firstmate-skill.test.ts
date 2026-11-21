import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FeatureRunConfigSchema, ProjectStore, captureRequest, digestText, ref, runFeature, taskReadinessReasons, type ImplementationPlanRevision } from '../src/index.js';
import { scenario } from './milestone-helper.js';
import { fakeTask } from './task-wrapper-helper.js';

const factory = fileURLToPath(new URL('../../', import.meta.url));
const materializer = join(factory, 'skills/software-factory/scripts/materialize-run.mjs');

// The fake FirstMate interprets its home registry and selects sources, as the
// skill instructs. The owner supplies only plain request text, never run.json.
function intake(twoTasks = false, independentBranch = false, existingCode = false, featureTaskId?: string,
  request = 'Build feature X for every connected system, ERPNext is only an example.\nPreserve "quotes", $values and Unicode: שלום.\n') {
  const flow = scenario({ bootstrap: false, factoryLayout: true, twoTasks, independentBranch, existingCode, originalRequest: request });
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
    ...(featureTaskId ? { featureTaskId } : {}),
    project: { goal: 'Exercise common interfaces', intendedUser: 'Operator', priorities: [], exclusions: [], vocabulary: {}, timezone: 'UTC' },
    sources: [{ path: join(flow.config.repository, existingCode ? 'connection.mjs' : 'baseline.txt'), reason: 'Establish behavior before the feature' }],
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

test('plan, code and product reviews read the current backlog ticket, including edits after delivery', () => {
  const id = 'current-review-ticket';
  const original = 'Build feature X for every connected system. ERPNext is an example.\n\n' +
    '## Definition of done (confirmed)\n1. Use the common interface.\n2. Show planning-time device proof.\n';
  const { flow, config } = intake(false, false, false, id, original);
  config.maxRevisionRounds = 0;
  config.firstMate.mode = 'no-mistakes';
  config.firstMate.briefExecutable = join(factory, '../bin/fm-brief.sh');
  const proofRequirement = 'Show browser proof on all target devices.';
  const oldDone = `1. Use the common interface.\n2. ${proofRequirement}`;
  const oldTicket = { id, text: `Build feature X for every connected system.\n\n## Definition of done (confirmed)\n${oldDone}\n` };
  const newDone = '1. Use the common interface.';
  const removed = 'The additional browser proof has been withdrawn.';
  const newTicket = { id, text: `Build feature X for every connected system. ${removed}\n\nDefinition of done:\n${newDone}\n` };
  try {
    flow.wrapper.edit((native) => { native.tasks[id] = fakeTask(id, { kind: 'feature', body: original }); });
    flow.mode({ ticketAtPlanReview: oldTicket, confirmedDone: oldDone });
    const plan = runFeature(config, 'plan') as any;
    const taskId = plan.tasks[0].taskId;
    runFeature(config, 'prepare-task', taskId);
    runFeature(config, 'start', taskId);
    const returnPath = join(config.runDirectory, 'tasks', taskId, 'worker-return.json');
    const returned = JSON.parse(readFileSync(returnPath, 'utf8'));
    execFileSync('git', ['-C', config.repository, 'update-ref', `refs/heads/fm/ticket/${id}`, returned.deliveredArtifact.revision]);
    returned.results.find((result: any) => result.criterion.id === 'criterion-second-system').result = 'untested';
    flow.save(returnPath, returned);
    flow.mode({ ticketAtProductReview: oldTicket, confirmedDone: oldDone, reviewQuote: proofRequirement });
    assert.throws(() => runFeature(config, 'review-all'), /review-product_failed/);
    const readReviews = () => {
      const store = new ProjectStore(config.database, { readOnly: true });
      try { return store.history('project-1').filter((record) => record.kind === 'product_review'); }
      finally { store.close(); }
    };
    const [failed] = readReviews();
    assert.equal(failed?.outcome, 'failed');
    assert.deepEqual(failed.conformance?.currentTicket, oldTicket);
    flow.wrapper.edit((native) => { native.tasks[id]!.body = newTicket.text; });
    flow.mode({ ticketAtProductReview: newTicket, confirmedDone: newDone, reviewQuote: removed, withdrawnProof: true });
    const { review, replayed, ticketDelivery } = runFeature(config, 'review-all') as any;
    assert.equal(replayed, false);
    assert.equal(review.outcome, 'passed');
    assert.equal(review.revision, 2);
    assert.deepEqual(review.conformance.currentTicket, newTicket);
    assert.equal(readFileSync(ticketDelivery.intentFile, 'utf8'), newTicket.text);
    assert.deepEqual(review.reviewedArtifacts, failed.reviewedArtifacts);
    assert.deepEqual(review.results, failed.results);
    assert.deepEqual(review.plan, failed.plan);
    assert.notEqual(review.conformance.technicalReviews[1].scopeDigest, failed.conformance?.technicalReviews[1]?.scopeDigest);
    assert.equal((runFeature(config, 'review-all') as any).replayed, true);
    assert.equal(readReviews().length, 2);
    const manual = join(config.runDirectory, 'manual-review-input.json');
    const oldInput = JSON.parse(readFileSync(join(config.runDirectory, 'review-all-input.json'), 'utf8'));
    flow.save(manual, { ...oldInput, expectedRevision: 2, idempotencyKey: 'manual-current-review', issuedAt: new Date().toISOString() });
    const fresh = JSON.parse(execFileSync(process.execPath, [join(factory, 'dist/src/cli.js'), 'review-product',
      '--db', config.database, '--input', manual, '--agent-config', config.agentConfig,
      '--adapter-config', join(config.runDirectory, 'task-adapter.json')], { encoding: 'utf8' }));
    assert.deepEqual(fresh.review.conformance.currentTicket, newTicket);
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
    const files = JSON.parse(calls.at(-1).prompt.trimEnd().split('\n').at(-1));
    const aggregate = JSON.parse(readFileSync(files.evidence, 'utf8'));
    assert.equal(aggregate.deliveries.length, 2);
    assert.equal(aggregate.technicalReviews.length, 4);
    assert.equal(aggregate.assignedCriteria.length, 2);
  } finally { flow.close(); }
});

for (const existingTicket of [false, true]) test(`a publishing run gives both sub-tasks a local handoff and one ticket delivery (${existingTicket ? 'backlog' : 'chat'})`, () => {
  const ticket = 'Build feature X for every connected system, ERPNext is only an example.\n' +
    '\n## Owner’s answers\nAnswer: "Use the common interface. Preserve $values, `examples`, and שלום."\n' +
    '\n## Definition of done (confirmed)\nEvery connected system can use feature X.\n';
  const parentId = existingTicket ? 'existing-publishing-ticket' : undefined;
  const { flow, config } = intake(true, false, false, parentId, ticket);
  const clarification = 'Use the existing interface for every connection. Preserve `opaque IDs`.\n';
  const expectedIntent = existingTicket ? `${ticket}\n\n## Recorded owner answers\n\n${clarification}` : ticket;
  config.firstMate.mode = 'no-mistakes';
  config.firstMate.briefExecutable = join(factory, '../bin/fm-brief.sh');
  const git = (...args: string[]) => execFileSync('git', ['-C', config.repository, ...args], { encoding: 'utf8' }).trim();
  try {
    if (parentId) {
      flow.wrapper.edit(state => { state.tasks[parentId] = fakeTask(parentId, { kind: 'feature', body: ticket }); });
      const store = new ProjectStore(config.database);
      let captured;
      try { captured = captureRequest(store, { projectId: 'project-1', clientRequestId: 'publishing-clarification',
        channel: 'chat', originalText: clarification, source: { uri: 'factory:publishing-clarification' }, attachments: [] }).request; }
      finally { store.close(); }
      const snapshot = join(flow.root, 'publishing-clarification.txt');
      writeFileSync(snapshot, clarification);
      config.sourceFiles.push({ source: captured.source, path: snapshot });
      const outputsPath = join(flow.root, 'outputs.json');
      const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
      const understanding = outputs.understand.input.records[0];
      const decision = { kind: 'decision_change', id: 'publishing-answer', projectId: 'project-1', schemaVersion: 1,
        revision: 1, createdAt: understanding.createdAt, updatedAt: understanding.updatedAt,
        questionOrChange: 'Which interface applies?', affectedRecords: [understanding.feature], rationale: clarification,
        disposition: 'selected', choice: { kind: 'product', state: 'resolved' },
        sourceRefs: [{ uri: captured.source.uri, record: ref(captured) }], scopeChanges: [] };
      outputs.design.records[0].decisions = [ref(decision)];
      outputs.design.records.push(decision);
      flow.save(outputsPath, outputs);
    }
    const planned = runFeature(config, 'plan') as any;
    const [producer, consumer] = planned.tasks.map((task: any) => task.taskId);
    assert.equal(planned.tasks.length, 2);
    const parent = flow.wrapper.read().tasks[producer]!.deps.find(edge => edge.type === 'parent')!;
    const branch = `fm/ticket/${parent.id}`;
    const localRef = `refs/heads/${branch}`;
    const base = git('rev-parse', 'HEAD');
    const produce = (taskId: string) => {
      const prepared = runFeature(config, 'prepare-task', taskId) as any;
      const briefPath = join(flow.data, taskId, 'brief.md');
      if (taskId === producer) {
        writeFileSync(briefPath, 'Old or damaged instructions');
      }
      runFeature(config, 'start', taskId);
      const retried = JSON.parse(readFileSync(join(config.runDirectory, 'tasks', taskId, 'prepared.json'), 'utf8'));
      assert.deepEqual(retried.assignment, { id: prepared.assignment.id, revision: prepared.assignment.revision + (taskId === producer ? 1 : 0) });
      const brief = readFileSync(briefPath, 'utf8');
      assert.ok(brief.includes(`Base branch: ${branch}`));
      assert.match(brief, /Delivery contract: mode=local-only/);
      assert.match(brief, /Do not push, open a PR, or merge/);
      assert.match(brief, /### Context files/);
      assert.ok(!brief.includes('"selectedContext":'));
      const args = JSON.parse(readFileSync(join(flow.root, 'spawn-args.json'), 'utf8'));
      assert.deepEqual(args.slice(2, 8), ['--mode', 'local-only', '--yolo', 'off', '--base-branch', branch]);
      assert.equal((runFeature(config, 'review', taskId) as any).taskOutcome, 'passed');
      return git('rev-parse', 'HEAD');
    };
    const firstCommit = produce(producer);
    assert.equal(git('rev-parse', localRef), base);
    assert.equal((runFeature(config, 'review-all') as any).state, 'awaiting_worker_returns');
    git('update-ref', localRef, firstCommit, base);
    flow.wrapper.edit(native => { native.tasks[producer]!.state = 'done'; });
    const finalCommit = produce(consumer);
    assert.equal((runFeature(config, 'review-all') as any).state, 'awaiting_ticket_branch');
    assert.equal(existsSync(join(config.runDirectory, 'ticket-delivery.json')), false);
    git('update-ref', localRef, finalCommit, firstCommit);
    writeFileSync(config.requestFile, 'A mutable replacement cannot become the published ticket.');
    const result = runFeature(config, 'review-all') as any;
    assert.equal(result.review.outcome, 'passed');
    const deliveryPath = join(config.runDirectory, 'ticket-delivery.json');
    const intentFile = join(config.runDirectory, 'ticket-intent.md');
    assert.deepEqual(result.ticketDelivery, { taskId: parent.id, branch, mode: 'no-mistakes', yolo: 'off',
      repository: config.repository, commit: finalCommit, intentFile, intentDigest: digestText(expectedIntent) });
    assert.deepEqual(JSON.parse(readFileSync(deliveryPath, 'utf8')), result.ticketDelivery);
    assert.equal(readFileSync(intentFile, 'utf8'), expectedIntent);

    const prBody = join(flow.root, 'pipeline-pr.md');
    writeFileSync(join(flow.root, 'no-mistakes'), `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(process.argv.slice(2), ['axi', 'run', '--intent-file', ${JSON.stringify(intentFile)}]);
const intent = fs.readFileSync(process.argv[5], 'utf8');
assert.equal(intent, ${JSON.stringify(expectedIntent)});
fs.writeFileSync(${JSON.stringify(prBody)}, '## What Changed\\n\\nSynthetic pipeline description.\\n\\n## Intent\\n\\n' + intent.trim() + '\\n');
`, { mode: 0o700 });
    const helper = join(factory, 'scripts/ticket-validation.mjs');
    const validate = (action: string, input?: string) => spawnSync(process.execPath, [helper, action, deliveryPath],
      { cwd: config.repository, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
    assert.match(validate('start').stderr, /reviewed ticket repository, branch and commit/);
    assert.equal(existsSync(prBody), false);
    git('switch', branch);
    const started = validate('start');
    assert.equal(started.status, 0, started.stderr);
    const pr = readFileSync(prBody, 'utf8');
    const checked = validate('check-pr', pr);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(validate('check-pr', pr.split('## Definition of done (confirmed)')[0]).status, 1);
    writeFileSync(intentFile, 'Changed after review.');
    assert.match(validate('start').stderr, /ticket intent is empty or changed/);

    execFileSync(config.firstMate.briefExecutable, ['ordinary-ticket', 'unregistered-project', '--mode', 'no-mistakes'], {
      env: { ...process.env, FM_HOME: flow.home, FM_DATA_OVERRIDE: flow.data }, encoding: 'utf8',
    });
    const ordinaryBrief = readFileSync(join(flow.data, 'ordinary-ticket', 'brief.md'), 'utf8');
    assert.match(ordinaryBrief, /pass `--intent` as only this brief's `## Captain's intent` subsection/);
    assert.doesNotMatch(ordinaryBrief, /ticket-validation\.mjs|--intent-file/);
  } finally { flow.close(); }
});

test('one author session produces four stages before an independent review can block queueing', () => {
  const { flow, config } = intake(true);
  try {
    flow.mode({ planFailure: true });
    assert.throws(() => runFeature({ ...config, maxRevisionRounds: 1 }, 'plan'), /plan_review_failed: exhausted 1 revision rounds/);
    assert.equal(flow.wrapper.read().calls.length, 0);
    assert.equal(existsSync(join(config.runDirectory, 'planned.json')), false);
    const failure = JSON.parse(readFileSync(join(config.runDirectory, 'plan-check-agent.json'), 'utf8'));
    assert.equal(failure.verdict.findings[0].type, 'narrowing');
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const [understand, design, plan, detail, review, correction, recheck] = calls;
    assert.deepEqual(calls.map(call => call.step), ['understand', 'design', 'plan', 'detail', 'plan_check', 'detail', 'plan_check']);
    assert.ok(understand.sessionId);
    assert.ok(!understand.args.includes('resume'));
    assert.equal(correction.sessionId, understand.sessionId);
    assert.ok(correction.args.includes('resume'));
    assert.notEqual(review.sessionId, understand.sessionId);
    assert.notEqual(recheck.sessionId, review.sessionId);
    assert.ok(!recheck.args.includes('resume'));
    const snapshot = (turn: typeof understand) => {
      const { evidence } = JSON.parse(turn.prompt.trimEnd().split('\n').at(-1));
      return JSON.parse(readFileSync(evidence, 'utf8'));
    };
    const originalText = readFileSync(config.requestFile, 'utf8');
    assert.equal(snapshot(understand).request.originalText, originalText);
    for (const turn of [design, plan, detail]) {
      assert.ok(turn.args.includes('resume'));
      assert.equal(turn.sessionId, understand.sessionId);
      assert.equal(turn.cwd, understand.cwd);
      const evidence = snapshot(turn);
      assert.equal(evidence.request.originalText, undefined);
      assert.equal(evidence.records.find((record: any) => record.kind === 'request').originalText, undefined);
    }
    assert.equal(snapshot(review).records.find((record: any) => record.kind === 'request').originalText, originalText);
  } finally { flow.close(); }
});

test('a review finding revises only task detail in the existing planner session', () => {
  const { flow, config } = intake(true);
  try {
    flow.mode({ reviseOnce: true });
    runFeature(config, 'plan');
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((turn) => turn.step), ['understand', 'design', 'plan', 'detail', 'plan_check', 'detail', 'plan_check']);
    assert.equal(calls[5].sessionId, calls[0].sessionId);
    assert.notEqual(calls[6].sessionId, calls[4].sessionId);
    const first = JSON.parse(readFileSync(join(config.runDirectory, 'plan-check-agent.json'), 'utf8'));
    assert.deepEqual(first.notes, ['A reviewer suggested extra cleanup']);
    assert.equal(first.verdict.findings.length, 1);
    const input = JSON.parse(readFileSync(join(config.runDirectory, 'detail-revision-1-input.json'), 'utf8'));
    assert.deepEqual(input.records.filter((record: any) => record.kind === 'detailed_plan_task').map((record: any) => record.id), ['task-1']);
    assert.equal(JSON.parse(readFileSync(join(config.runDirectory, 'plan-check-agent-r1.json'), 'utf8')).verdict.verdict, 'pass');
  } finally { flow.close(); }
});

test('failed preparation instruction check retains the native hold and never starts a worker', () => {
  const { flow, config } = intake();
  config.maxRevisionRounds = 0;
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
    assert.equal(reviewed.review.conformance.technicalReviews.length, 2);
  } finally { flow.close(); }
});


for (const existingParent of [false, true]) test(`existing project code without factory artifacts completes the method (${existingParent ? 'existing feature ticket' : 'new feature ticket'})`, t => {
  const { flow, config, request } = intake(false, false, true, existingParent ? 'fixture-f03' : undefined);
  try {
    if (existingParent) {
      assert.equal(config.featureTaskId, 'fixture-f03');
      flow.wrapper.edit(state => { state.tasks['fixture-f03'] = fakeTask('fixture-f03', { kind: 'feature', title: 'Existing feature ticket' }); });
    }
    const originalParent = existingParent ? structuredClone(flow.wrapper.read().tasks['fixture-f03']) : undefined;
    const stage = flow.outputs.understand.input.stage as any;
    const understanding = flow.outputs.understand.input.records[0] as any;
    const source = config.sourceFiles[0]!.source;
    assert.match(execFileSync('git', ['-C', config.repository, 'show', 'HEAD:connection.mjs'], { encoding: 'utf8' }), /export function connect/);
    // The selected repository already has a committed baseline, but bootstrap
    // created no factory design or plan. Reuse is code, not a factory revision.
    const store = new ProjectStore(config.database, { readOnly: true });
    try {
      assert.equal(store.history('project-1').some(r => ['design_revision', 'implementation_plan_revision'].includes(r.kind)), false);
    } finally { store.close(); }
    understanding.existingWork = [{ source, finding: 'Preserve the existing baseline while adding feature X' }];
    Object.assign(stage, { reuse: { kind: 'project_code', sources: [source], criterionMap: [], check: {
      result: 'passed', sourceRefs: [{ uri: config.requestFile, record: stage.sourceRequests[0] }, source],
      findings: [], reviewerSession: 'fixture-code-research', comparedAt: stage.createdAt,
    } } });
    flow.save(join(flow.root, 'outputs.json'), flow.outputs);
    const planned = runFeature(config, 'plan') as any;
    assert.equal(planned.tasks.length, 1);
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
    const recorded = new ProjectStore(config.database, { readOnly: true });
    try {
      const records = recorded.history('project-1');
      assert.deepEqual(records.filter(r => r.kind === 'stage_revision').map(r => r.stage).sort(), ['design', 'detail', 'plan', 'understand']);
      const plan = recorded.get('project-1', planned.plan.id);
      assert.ok(plan?.kind === 'implementation_plan_revision' && plan.readiness.ready);
      const captured = records.find(r => r.kind === 'request');
      assert.ok(captured?.kind === 'request'); assert.equal(captured.originalText, request);
    } finally { recorded.close(); }
    const added = flow.wrapper.read().calls.filter(c => c.args[0] === 'add' && c.args[1] !== '--help');
    assert.equal(added.length, existingParent ? 1 : 2);
    const child = flow.wrapper.read().tasks[planned.tasks[0].taskId]!;
    const parents = child.deps.filter(d => d.type === 'parent');
    assert.equal(parents.length, 1);
    assert.ok(flow.wrapper.read().tasks[parents[0]!.id]);
    if (existingParent) {
      assert.equal(parents[0]!.id, 'fixture-f03');
      assert.deepEqual(flow.wrapper.read().tasks['fixture-f03'], originalParent);
    }
    runFeature(config, 'prepare-task', child.id);
    runFeature(config, 'start', child.id);
    assert.equal((runFeature(config, 'review', child.id) as any).review.outcome, 'passed');
    assert.equal((runFeature(config, 'review-all') as any).review.outcome, 'passed');
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const assignmentStore = new ProjectStore(config.database, { readOnly: true });
    try {
      const assignment = assignmentStore.records('project-1').find(record => record.kind === 'assignment');
      assert.ok(assignment?.kind === 'assignment');
      assert.ok(assignment.selectedContext.some(context => context.extract?.includes('export function connect')));
      assert.ok(assignment.brief);
      assert.ok(!readFileSync(assignment.brief.path, 'utf8').includes('export function connect'));
      assert.match(readFileSync(assignment.brief.sidecarPath, 'utf8'), /export function connect/);
    } finally { assignmentStore.close(); }
    const checked = calls.find(call => call.step === 'instruction_check');
    const judged = calls.filter(call => call.step === 'product_review');
    assert.ok(checked);
    const original = (prompt: string) => {
      const { evidence } = JSON.parse(prompt.trimEnd().split('\n').at(-1)!);
      return JSON.parse(readFileSync(evidence, 'utf8')).originalRequests[0].text;
    };
    assert.equal(original(checked.prompt), request);
    assert.equal(judged.length, 2);
    for (const call of judged) assert.equal(original(call.prompt), request);
    t.diagnostic(JSON.stringify({ taskCreate: added.find(call => call.args[1] === child.id)!.args,
      observedDependencies: flow.wrapper.read().tasks[planned.tasks[0].taskId]!.deps }));
  } finally { flow.close(); }
});

test('planning records the exact stored excerpt for an authored request range', () => {
  const { flow, config, request } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const understanding = outputs.understand.input.records[0]!;
    const sourceRequest = understanding.sourceRequests[0]!;
    const excerpt = 'שלום';
    const start = request.indexOf(excerpt);
    const decision = {
      kind: 'decision_change', id: 'range-decision', projectId: understanding.projectId,
      schemaVersion: 1, revision: 1, createdAt: understanding.createdAt, updatedAt: understanding.updatedAt,
      questionOrChange: 'Preserve the Unicode request text', affectedRecords: [sourceRequest, understanding.feature],
      rationale: 'Keep the captured source', disposition: 'selected', scopeChanges: [],
      choice: { kind: 'technical', state: 'resolved' },
      sourceRefs: [{ uri: config.requestFile, record: sourceRequest }],
      requestMapping: { request: sourceRequest, start, end: start + excerpt.length, disposition: 'work',
        feature: understanding.feature, criteria: [], replaces: [] },
    };
    outputs.design.records[0].decisions = [{ id: decision.id, revision: 1 }];
    outputs.design.records.push(decision);
    flow.save(outputsPath, outputs);
    runFeature(config, 'plan');
    const store = new ProjectStore(config.database, { readOnly: true });
    try {
      const stored = store.get('project-1', decision.id, 1);
      assert.ok(stored?.kind === 'decision_change' && stored.requestMapping);
      const { request: mapped } = stored.requestMapping;
      assert.deepEqual(stored.sourceRefs[0], { uri: config.requestFile, record: mapped });
      assert.ok(stored.sourceRefs.some(source => source.record?.id === mapped.id &&
        source.record.revision === mapped.revision && source.excerpt === excerpt));
    } finally { store.close(); }
  } finally { flow.close(); }
});

test('a checked plan resumes without agents and passes newly cited baseline files to task preparation', () => {
  const { flow, config } = intake();
  try {
    const path = join(config.repository, 'new-citation.mjs');
    const text = 'export const pinnedBaseline = true;\n';
    const git = (...args: string[]) => execFileSync('git', ['-C', config.repository, ...args], { encoding: 'utf8' }).trim();
    writeFileSync(path, text);
    git('add', '--', path);
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Add source the planner discovers');
    const revision = git('rev-parse', 'HEAD');
    config.baselineEvidence[0]!.artifact.revision = revision;
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const source = { uri: path, excerpt: 'pinnedBaseline = true' };
    const reference = { source: { uri: 'https://example.invalid/reference' }, digest: digestText('Reviewed reference.\n') };
    outputs.design.records[0].sourceRefs.push(source, reference.source);
    flow.save(outputsPath, outputs);
    const digest = digestText(text);
    const pin = join(config.runDirectory, 'sources', `cited-${digest.slice(7)}.txt`);
    writeFileSync(pin, 'A damaged snapshot must stop queueing.');
    assert.throws(() => runFeature(config, 'plan'), /pinned_run_source_changed/);
    assert.equal(flow.wrapper.read().calls.length, 0);
    assert.equal(existsSync(join(config.runDirectory, 'planned.json')), false);
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
    const checked = JSON.parse(readFileSync(join(config.runDirectory, 'check-plan.stdout'), 'utf8'));
    rmSync(pin);
    writeFileSync(path, 'Mutable checkout content after planning.\n');
    const referencePath = join(config.runDirectory, 'sources', `cited-${reference.digest.slice(7)}.txt`);
    writeFileSync(referencePath, 'Reviewed reference.\n');
    const references = join(flow.root, 'references.json');
    flow.save(references, [reference]);
    const run = join(flow.root, 'resume-run.json');
    flow.save(run, config);
    const planned = JSON.parse(execFileSync(process.execPath, [join(factory, 'scripts/run-feature.mjs'), 'plan', run,
      '--resume', '--references', references], { encoding: 'utf8' }));
    assert.deepEqual(planned.plan, checked.readyPlan);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), calls);
    assert.deepEqual(planned.pinnedSources, [{ source, revision, digest }, reference]);
    assert.equal(readFileSync(pin, 'utf8'), text);
    const taskId = planned.tasks[0].taskId;
    assert.equal(flow.wrapper.read().tasks[taskId]!.held, true);
    const prepared = runFeature(config, 'prepare-task', taskId) as any;
    const store = new ProjectStore(config.database, { readOnly: true });
    try {
      const assignment = store.get(config.project.id, prepared.assignment.id, prepared.assignment.revision);
      assert.ok(assignment?.kind === 'assignment');
      assert.ok(assignment.selectedContext.some((context) =>
        context.source.uri === path && context.extract === source.excerpt && context.artifact?.uri === pin));
      assert.ok(assignment.selectedContext.some((context) =>
        context.source.uri === reference.source.uri && context.artifact?.uri === referencePath));
    } finally { store.close(); }
  } finally { flow.close(); }
});

for (const link of [false, true]) test(`plan refuses a citation outside its repository (${link ? 'tracked symlink' : 'file path'})`, () => {
  const { flow, config } = intake();
  try {
    const outside = join(flow.root, 'outside.txt');
    writeFileSync(outside, 'This file is outside the registered repository.\n');
    const source = link ? join(config.repository, 'escape.txt') : outside;
    if (link) {
      symlinkSync(outside, source);
      const git = (...args: string[]) => execFileSync('git', ['-C', config.repository, ...args], { encoding: 'utf8' }).trim();
      git('add', '--', source);
      git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Track symlink outside repository');
      config.baselineEvidence[0]!.artifact.revision = git('rev-parse', 'HEAD');
    }
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    outputs.design.records[0].sourceRefs.push({ uri: source });
    flow.save(outputsPath, outputs);
    assert.throws(() => runFeature(config, 'plan'), /unauthorized_run_source/);
    assert.equal(flow.wrapper.read().calls.length, 0);
  } finally { flow.close(); }
});
