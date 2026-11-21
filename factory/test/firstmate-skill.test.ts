import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FeatureRunConfigSchema, ProjectStore, captureRequest, checkStartingWorker, digestText, mapRequest, ref, runFeature, stableId, taskReadinessReasons, type ImplementationPlanRevision } from '../src/index.js';
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

test('managed reviews refuse a stale return and resume once the builder returns the branch head', () => {
  const { flow, config } = intake();
  try {
    const planned = runFeature(config, 'plan') as any;
    const taskId = planned.tasks[0].taskId;
    runFeature(config, 'prepare-task', taskId);
    runFeature(config, 'start', taskId);
    const directory = join(config.runDirectory, 'tasks', taskId);
    const path = join(directory, 'worker-return.json');
    const original = readFileSync(path, 'utf8');
    const oldHead = JSON.parse(original).deliveredArtifact.revision as string;
    assert.equal((runFeature(config, 'review', taskId) as any).taskOutcome, 'passed');
    const before = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
    const originalScope = readFileSync(join(flow.root, 'scope-review.json'), 'utf8');
    flow.mode({ returnRevision: 2 });
    execFileSync(flow.returnWorker, [taskId]);
    const refreshed = readFileSync(path, 'utf8');
    const newest = JSON.parse(refreshed).deliveredArtifact.revision as string;
    assert.notEqual(newest, oldHead);
    writeFileSync(path, original);
    const stale = new RegExp(`factory_review_stale_return:.*${newest}.*update worker-return\\.json.*${oldHead}`);
    assert.throws(() => runFeature(config, 'review', taskId), stale);
    assert.throws(() => runFeature(config, 'review-all'), stale);
    const cli = spawnSync(process.execPath, [join(factory, 'dist/src/cli.js'), 'review-product',
      '--db', config.database, '--input', join(directory, 'review-input.json'), '--agent-config', config.agentConfig],
    { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, stale);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), before);
    assert.equal(readFileSync(join(flow.root, 'scope-review.json'), 'utf8'), originalScope);
    assert.equal(existsSync(join(config.runDirectory, 'review-all.started')), false);
    writeFileSync(path, refreshed);
    const reviewed = runFeature(config, 'review', taskId) as any;
    assert.equal(reviewed.taskOutcome, 'passed');
    assert.equal(reviewed.review.reviewedArtifacts[0].revision, newest);
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
    const callsBefore = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
    assert.throws(() => runFeature(config, 'prepare-task', consumer), /review the producer first/);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), callsBefore);
    assert.equal(existsSync(join(config.runDirectory, 'tasks', consumer, 'prepare-task.started')), false);
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
      const outputsPath = join(flow.root, 'outputs.json');
      const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
      const understanding = outputs.understand.input.records[0];
      const decision = { kind: 'decision_change', id: 'publishing-answer', projectId: 'project-1', schemaVersion: 1,
        revision: 1, createdAt: understanding.createdAt, updatedAt: understanding.updatedAt,
        questionOrChange: 'Which interface applies?', affectedRecords: [understanding.feature], rationale: clarification,
        disposition: 'selected', choice: { kind: 'product', state: 'resolved' },
        sourceRefs: [{ uri: captured.source.uri, record: ref(captured) }], scopeChanges: [] };
      outputs.understand.input.records.push(decision);
      outputs.design.records[0].decisions = [ref(decision)];
      flow.save(outputsPath, outputs);
    }
    const repository = 'https://github.com/example/factory';
    git('remote', 'add', 'origin', repository);
    writeFileSync(join(config.repository, 'companion.txt'), 'baseline feature companion\n');
    git('add', 'companion.txt');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Keep existing companion');
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
    flow.mode({ codeNote: true, scopeNote: true, productNote: true });
    const result = runFeature(config, 'review-all') as any;
    assert.equal(result.review.outcome, 'passed');
    const deliveryPath = join(config.runDirectory, 'ticket-delivery.json');
    const intentFile = join(config.runDirectory, 'ticket-intent.md');
    const reviewNotes = '## Factory review notes\n\n- **code** Code observation\n- **scope** Scope observation\n- **product** Product observation';
    assert.deepEqual(result.ticketDelivery, { taskId: parent.id, branch, mode: 'no-mistakes', yolo: 'off',
      repository: config.repository, repositoryIdentity: 'github.com/example/factory', commit: finalCommit,
      review: ref(result.review), intentFile, intentDigest: digestText(expectedIntent), reviewNotes });
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
    flow.save(join(config.runDirectory, 'run.json'), config);
    const deliveryBrief = validate('brief');
    assert.equal(deliveryBrief.status, 0, deliveryBrief.stderr);
    assert.ok(deliveryBrief.stdout.includes(`git switch --no-guess ${branch}`));
    assert.match(deliveryBrief.stdout, /ticket-validation\.mjs' start '/u);
    assert.match(deliveryBrief.stdout, /pr-body action/u);
    assert.doesNotMatch(deliveryBrief.stdout, /^Base branch: /mu);
    const launch = join(flow.data, 'ticket-delivery-brief.md');
    writeFileSync(launch, deliveryBrief.stdout);
    const registry = JSON.parse(readFileSync(config.hookRegistry, 'utf8'));
    const event = { version: 1, event: 'worker.start.before', kind: 'ship', mode: 'no-mistakes',
      home: flow.home, project: config.repository, task_id: parent.id, branch, base_branch: null,
      source_brief_path: launch, brief_path: launch, brief_sha256: digestText(deliveryBrief.stdout).slice(7) };
    assert.deepEqual(checkStartingWorker(registry, event), { ok: true, managed: true });
    assert.throws(() => checkStartingWorker(registry, { ...event, task_id: 'another-delivery' }), /ticket_delivery_not_verified/);
    assert.throws(() => checkStartingWorker(registry, { ...event, branch: 'fm/another-branch' }), /ticket_delivery_not_verified/);
    assert.throws(() => checkStartingWorker(registry, { ...event, raw_command: 'true' }), /ticket_delivery_not_verified/);
    git('update-ref', localRef, firstCommit, finalCommit);
    assert.throws(() => checkStartingWorker(registry, event), /ticket branch moved after review/);
    git('update-ref', localRef, finalCommit, firstCommit);
    assert.match(validate('start').stderr, /reviewed ticket repository, branch and commit/);
    assert.equal(existsSync(prBody), false);
    git('switch', branch);
    const started = validate('start');
    assert.equal(started.status, 0, started.stderr);
    const pr = readFileSync(prBody, 'utf8');
    assert.match(validate('check-pr', pr).stderr, /does not contain the Factory review notes/);
    const composed = validate('pr-body', pr);
    assert.equal(composed.status, 0, composed.stderr);
    assert.ok(composed.stdout.endsWith(reviewNotes + '\n'));
    assert.equal(validate('pr-body', composed.stdout).stdout, composed.stdout);
    const checked = validate('check-pr', composed.stdout);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(validate('check-pr', pr.split('## Definition of done (confirmed)')[0]).status, 1);
    const changedIntent = expectedIntent + '\nAppended outside the review.';
    writeFileSync(intentFile, changedIntent);
    flow.save(deliveryPath, { ...result.ticketDelivery, intentDigest: digestText(changedIntent) });
    assert.throws(() => checkStartingWorker(registry, event), /ticket_delivery_not_verified/);
    const pinnedStart = spawnSync(process.execPath, [helper, 'start', deliveryPath,
      finalCommit, result.ticketDelivery.intentDigest], { cwd: config.repository, encoding: 'utf8' });
    assert.match(pinnedStart.stderr, /handoff changed after worker admission/);
    flow.save(deliveryPath, result.ticketDelivery);

    const url = `${repository}/pull/31`;
    writeFileSync(join(config.repository, 'first-fix.mjs'), 'export const firstFix = true;\n');
    git('add', 'first-fix.mjs');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'First fix');
    rmSync(join(config.repository, 'companion.txt'));
    git('add', '-u', '--', 'companion.txt');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Second fix');
    const fixed = git('rev-parse', 'HEAD');
    const forgeResponse = join(flow.root, 'forge-ticket.json');
    flow.save(forgeResponse, { html_url: url, head: { sha: fixed, ref: branch, repo: { html_url: repository } }, base: { sha: base } });
    writeFileSync(join(flow.root, 'gh-axi'), `#!${process.execPath}
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2, 6), ['api', '/repos/example/factory/pulls/31', '--full', '--jq']);
assert.match(process.argv[6], /@base64/);
assert.equal(process.env.GH_HOST, 'github.com');
const { html_url, head, base } = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(forgeResponse)}));
const json = JSON.stringify({ url: html_url, head: head.sha, base: base.sha, sourceBranch: head.ref, sourceRepository: head.repo.html_url });
process.stdout.write('api_response:\\n  body: ' + Buffer.from(json).toString('base64') + '\\n  truncated: false\\n');
`, { mode: 0o700 });
    flow.save(join(flow.root, 'mode.json'), { ticketPatchReview: result.review.id });
    const runnerConfig = join(flow.root, 'publishing-run.json');
    flow.save(runnerConfig, config);
    const runner = join(factory, 'scripts/run-feature.mjs');
    const merge = () => spawnSync(process.execPath, [join(factory, 'scripts/factory-lock.mjs'), 'merge', config.hookRegistry,
      flow.home, repository, parent.id, fixed, url], { encoding: 'utf8' });
    assert.match(merge().stderr, /requires_passing_product_review_for_head/);
    const reviewed = spawnSync(process.execPath, [runner, 'review-pr', runnerConfig, url, fixed], { encoding: 'utf8' });
    assert.equal(reviewed.status, 0, reviewed.stderr + reviewed.stdout);
    const followUp = JSON.parse(reviewed.stdout).review;
    assert.equal(followUp.ticketReview.from, finalCommit);
    assert.equal(followUp.ticketReview.head, fixed);
    assert.deepEqual(JSON.parse(merge().stdout).review, ref(followUp));
    writeFileSync(intentFile, 'Changed after review.');
    assert.throws(() => checkStartingWorker(registry, event), /ticket intent is empty or changed/);
    assert.match(validate('start').stderr, /ticket intent is empty or changed/);

    execFileSync(config.firstMate.briefExecutable, ['ordinary-ticket', 'unregistered-project', '--mode', 'no-mistakes'], {
      env: { ...process.env, FM_HOME: flow.home, FM_DATA_OVERRIDE: flow.data }, encoding: 'utf8',
    });
    const ordinaryBrief = readFileSync(join(flow.data, 'ordinary-ticket', 'brief.md'), 'utf8');
    assert.match(ordinaryBrief, /pass `--intent` as only this brief's `## Captain's intent` subsection/);
    assert.doesNotMatch(ordinaryBrief, /ticket-validation\.mjs|--intent-file/);
  } finally { flow.close(); }
});

test('independent plan review blocks narrowing before any task is queued', () => {
  const { flow, config } = intake(true);
  try {
    flow.mode({ planFailure: true });
    assert.throws(() => runFeature({ ...config, maxRevisionRounds: 1 }, 'plan'), /plan_review_failed: exhausted 1 revision rounds/);
    assert.equal(flow.wrapper.read().calls.length, 0);
    assert.equal(existsSync(join(config.runDirectory, 'planned.json')), false);
    const failure = JSON.parse(readFileSync(join(config.runDirectory, 'plan-check-agent.json'), 'utf8'));
    assert.equal(failure.verdict.findings[0].type, 'narrowing');
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

test('plan review blocks vague feature and worker titles and queues the revised titles', () => {
  const { flow, config } = intake();
  try {
    const records = flow.outputs.detail.records as Array<{ kind: string }>;
    const plan = records.find((record) => record.kind === 'implementation_plan_revision');
    const task = records.find((record) => record.kind === 'detailed_plan_task');
    assert.ok(plan && task);
    Object.assign(plan, { ticketTitle: '  Project Leap  ' });
    Object.assign(task, { expectedBehavior: 'Phase\n1' });
    flow.save(join(flow.root, 'outputs.json'), flow.outputs);
    flow.mode({ reviseTitles: true });
    runFeature(config, 'plan');
    const turns = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const planner = turns.find((turn) => turn.step === 'plan');
    assert.match(planner.prompt, /Plan one implementation task by default/);
    assert.match(planner.prompt, /only when the ticket is too big for one task.*strategyReason/);
    const failed = JSON.parse(readFileSync(join(config.runDirectory, 'plan-check-agent.json'), 'utf8'));
    assert.equal(failed.verdict.verdict, 'fail');
    assert.deepEqual(failed.verdict.findings.map((finding: { title: string }) => finding.title), ['Project Leap', 'Phase 1']);
    const tickets = Object.values(flow.wrapper.read().tasks);
    assert.equal(tickets.find((ticket) => ticket.kind === 'feature')?.title, 'Export invoices from all connected systems');
    assert.equal(tickets.find((ticket) => ticket.kind === 'ship')?.title, 'Export invoice records using the shared report');
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

for (const state of ['resolved', 'open-product', 'open-technical']) test(`understanding decisions survive planning with ${state}`, () => {
  const open = state !== 'resolved';
  const product = state === 'open-product';
  const { flow, config } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const understanding = outputs.understand.input.records[0];
    const decision = { kind: 'decision_change', id: 'understanding-decision', projectId: understanding.projectId,
      schemaVersion: 1, revision: 1, createdAt: understanding.createdAt, updatedAt: understanding.updatedAt,
      questionOrChange: 'How should the common behavior be delivered?', affectedRecords: [understanding.feature],
      rationale: 'Preserve the original request', disposition: open ? 'proposed' : 'selected',
      choice: { kind: product ? 'product' : 'technical', state: open ? 'open' : 'resolved' },
      sourceRefs: [{ uri: config.requestFile }], scopeChanges: [] };
    outputs.understand.input.records.push(decision);
    outputs.design.records[0].decisions = [{ id: decision.id, revision: 1 }];
    if (open) outputs.design.records[0].unresolvedQuestions = [decision.questionOrChange];
    flow.save(outputsPath, outputs);
    if (product) {
      assert.throws(() => runFeature(config, 'plan'), /check-plan_failed/);
      const check = JSON.parse(readFileSync(join(config.runDirectory, 'check-plan.stdout'), 'utf8'));
      assert.ok(check.check.findings.some((finding: any) => finding.code === 'unresolved_product_decision'));
      assert.equal(flow.wrapper.read().calls.length, 0);
    } else {
      const planned = runFeature(config, 'plan') as any;
      assert.equal(planned.tasks.length, 1);
      assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
    }
    assert.ok(existsSync(join(config.runDirectory, 'understand.stdout')));
    assert.ok(existsSync(join(config.runDirectory, 'detail.stdout')));
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const step of ['understand', 'design', 'plan', 'detail']) {
      const files = JSON.parse(calls.find((call) => call.step === step).prompt.trimEnd().split('\n').at(-1));
      const snapshot = JSON.parse(readFileSync(files.evidence, 'utf8'));
      assert.deepEqual(snapshot.baselineEvidence, config.baselineEvidence, 'Planners receive the captured commit identity and baseline facts');
    }
  } finally { flow.close(); }
});

test('understand rejects a preliminary design carrier before mapping or recording it', () => {
  const { flow, config } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    outputs.understand.input.records.push(outputs.design.records[0]);
    flow.save(outputsPath, outputs);
    assert.throws(() => runFeature(config, 'plan'), /Invalid input/);
    assert.equal(existsSync(join(config.runDirectory, 'map-input.json')), false);
    assert.equal(flow.wrapper.read().calls.length, 0);
  } finally { flow.close(); }
});


test('explicit plan resume preserves the mapped feature and saved failure before queueing held tasks', () => {
  const { flow, config } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const originalDesign = structuredClone(outputs.design);
    outputs.understand.input.records[0].openUnknowns = ['Owner scope needs clarification'];
    outputs.design.records[0].workflow.understanding.id = 'missing-understanding';
    flow.save(outputsPath, outputs);
    assert.throws(() => runFeature(config, 'plan'), /design_failed/);
    assert.throws(() => runFeature({ ...config, repository: flow.root }, 'plan', '--resume'), /planned_run_config_changed/);
    const failedEvidence = readFileSync(join(config.runDirectory, 'design-agent.json'), 'utf8');
    const originalMap = readFileSync(join(config.runDirectory, 'map-input.json'), 'utf8');
    const understood = outputs.understand.input;
    understood.expectedRevision = 1;
    understood.stage.previousStage = { id: understood.stage.id, revision: 1 };
    understood.stage.revision = 2;
    understood.stage.artifact.revision = 2;
    understood.records[0].revision = 2;
    understood.records[0].openUnknowns = [];
    outputs.understand = understood;
    outputs.design = originalDesign;
    outputs.design.stage.previousStage.revision = 2;
    outputs.design.records[0].workflow.understanding.revision = 2;
    flow.save(outputsPath, outputs);
    const planned = runFeature(config, 'plan', '--resume') as any;
    assert.equal(planned.tasks.length, 1);
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
    assert.equal(readFileSync(join(config.runDirectory, 'map-input.json'), 'utf8'), originalMap);
    assert.equal(readFileSync(join(config.runDirectory, 'design-agent.json'), 'utf8'), failedEvidence);
    const authorTurns = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(turn => turn.step !== 'plan_check');
    assert.ok(authorTurns[0].sessionId);
    assert.ok(authorTurns.slice(1).every(turn => turn.sessionId === authorTurns[0].sessionId && turn.args.includes('resume')));
    const store = new ProjectStore(config.database, { readOnly: true });
    try { assert.equal(store.records('project-1').filter((record) => record.kind === 'feature_revision').length, 1); }
    finally { store.close(); }
    const calls = flow.wrapper.read().calls.length;
    assert.deepEqual(runFeature(config, 'plan', '--resume'), planned);
    assert.equal(flow.wrapper.read().calls.length, calls, 'Never repeat completed queue/reconcile effects');
  } finally { flow.close(); }
});

test('plan resume refuses a missing original run and an active plan attempt', () => {
  const { flow, config } = intake();
  try {
    assert.throws(() => runFeature(config, 'plan', '--resume'), /resume_plan_requires_unqueued_started_run/);
    mkdirSync(join(config.runDirectory, 'plan-attempt.lock'));
    assert.throws(() => runFeature(config, 'plan'), /plan_attempt_in_progress/);
    assert.equal(existsSync(join(config.runDirectory, 'plan.started')), false);
    assert.equal(flow.wrapper.read().calls.length, 0);
  } finally { flow.close(); }
});


test('planning materializes an owner clarification from its captured text without reading its source path', () => {
  const { flow, config } = intake();
  try {
    const text = 'Keep all systems in scope and use the common interface.';
    const source = { uri: join(flow.root, 'never-written-owner-message.txt') };
    const store = new ProjectStore(config.database);
    let request;
    try { request = captureRequest(store, { projectId: 'project-1', clientRequestId: 'owner-clarification',
      channel: 'chat', originalText: text, source, attachments: [] }).request; }
    finally { store.close(); }
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const understanding = outputs.understand.input.records[0];
    const decision = { kind: 'decision_change', id: 'owner-scope-answer', projectId: 'project-1', schemaVersion: 1,
      revision: 1, createdAt: understanding.createdAt, updatedAt: understanding.updatedAt,
      questionOrChange: 'Preserve all systems?', affectedRecords: [understanding.feature], rationale: text,
      disposition: 'selected', choice: { kind: 'product', state: 'resolved' },
      sourceRefs: [{ uri: 'factory:owner-clarification', record: ref(request), excerpt: text }], scopeChanges: [] };
    outputs.understand.input.records.push(decision);
    outputs.design.records[0].decisions = [{ id: decision.id, revision: 1 }];
    flow.save(outputsPath, outputs);
    const planned = runFeature(config, 'plan') as any;
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
    assert.equal(existsSync(source.uri), false);
    assert.equal(readFileSync(join(config.runDirectory, `captured-${request.id}-1.txt`), 'utf8'), text);
    runFeature(config, 'prepare-task', planned.tasks[0].taskId);
    assert.equal(existsSync(source.uri), false, 'Preparation also uses stored capture text');
  } finally { flow.close(); }
});


test('resume retains a complete understanding instead of authoring another revision', () => {
  const { flow, config } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const design = structuredClone(outputs.design);
    outputs.design.records[0].workflow.understanding.id = 'missing-understanding';
    flow.save(outputsPath, outputs);
    assert.throws(() => runFeature(config, 'plan'), /design_failed/);
    outputs.design = design;
    flow.save(outputsPath, outputs);
    const planned = runFeature(config, 'plan', '--resume') as any;
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.step === 'understand').length, 1);
  } finally { flow.close(); }
});

test('stage authoring rejects reserved answer fields on technical decisions before storage', () => {
  const { flow, config } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const understanding = outputs.understand.input.records[0];
    outputs.design.records.push({ kind: 'decision_change', id: 'technical-selection', projectId: 'project-1',
      schemaVersion: 1, revision: 1, createdAt: understanding.createdAt, updatedAt: understanding.updatedAt,
      questionOrChange: 'Select the existing common interface', affectedRecords: [understanding.feature],
      rationale: 'Preserve existing behavior', disposition: 'selected', choice: { kind: 'technical', state: 'resolved' },
      sourceRefs: [{ uri: config.requestFile }], scopeChanges: [], answer: { text: 'Use the common interface' } });
    flow.save(outputsPath, outputs);
    assert.throws(() => runFeature(config, 'plan'), /Invalid input/);
    assert.equal(existsSync(join(config.runDirectory, 'design-input.json')), false);
    assert.equal(flow.wrapper.read().calls.length, 0);
  } finally { flow.close(); }
});


test('a selected request mapping is settled intake provenance in design decisions', () => {
  const { flow, config } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    outputs.design.records[0].decisions.push({ id: stableId('mapping', 'project-1', 'map-feature'), revision: 1 });
    flow.save(outputsPath, outputs);
    const planned = runFeature(config, 'plan') as any;
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
  } finally { flow.close(); }
});


test('resume retains a completed design when only plan authoring failed', () => {
  const { flow, config } = intake();
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const plan = structuredClone(outputs.plan);
    outputs.plan.records[0].design.id = 'missing-design';
    flow.save(outputsPath, outputs);
    assert.throws(() => runFeature(config, 'plan'), /plan_failed/);
    outputs.plan = plan;
    flow.save(outputsPath, outputs);
    const planned = runFeature(config, 'plan', '--resume') as any;
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const step of ['understand', 'design']) assert.equal(calls.filter((call) => call.step === step).length, 1);
  } finally { flow.close(); }
});

test('planning shares the author session and reviews the original request independently', () => {
  const { flow, config } = intake();
  try {
    const store = new ProjectStore(config.database);
    const text = 'An unrelated request with no shared source. '.repeat(1000);
    let request;
    try {
      request = captureRequest(store, { projectId: 'project-1', clientRequestId: 'unrelated', channel: 'chat',
        originalText: text, source: { uri: 'fixture:unrelated' }, attachments: [] }).request;
      mapRequest(store, { projectId: 'project-1', requestId: request.id, expectedRevision: 1, idempotencyKey: 'unrelated-map',
        issuedAt: new Date().toISOString(), start: 0, end: text.length, rationale: 'Separate feature',
        target: { kind: 'new_feature', feature: { id: 'unrelated-feature', outcome: 'Unrelated behavior', criteria: [] } } });
    } finally { store.close(); }
    runFeature(config, 'plan');
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const [understand, design, plan, detail, review] = calls;
    assert.deepEqual(calls.map(call => call.step), ['understand', 'design', 'plan', 'detail', 'plan_check']);
    assert.ok(understand.sessionId);
    assert.ok(!understand.args.includes('resume'));
    for (const turn of [design, plan, detail]) {
      assert.ok(turn.args.includes('resume'));
      assert.equal(turn.sessionId, understand.sessionId);
      assert.equal(turn.cwd, understand.cwd);
    }
    assert.ok(!review.args.includes('resume'));
    assert.notEqual(review.sessionId, understand.sessionId);
    const snapshot = (step: string) => {
      const files = JSON.parse(calls.find((call) => call.step === step).prompt.trimEnd().split('\n').at(-1));
      return JSON.parse(readFileSync(files.evidence, 'utf8'));
    };
    for (const step of ['understand', 'design', 'plan', 'detail', 'plan_check']) {
      const records = snapshot(step).records;
      if (step === 'understand') assert.equal(snapshot(step).project.id, 'project-1');
      else {
        assert.ok(records.some((record: any) => record.id === 'feature-1'));
        assert.ok(records.some((record: any) => record.id === 'project-1'));
      }
      assert.equal(records.some((record: any) => record.id === 'unrelated-feature' || record.id === request.id), false);
      const captured = records.find((record: any) => record.kind === 'request');
      assert.ok(captured);
      if (step === 'understand' || step === 'plan_check') assert.ok(captured.originalText && captured.originalText !== text);
      else assert.equal(captured.originalText, undefined);
    }
  } finally { flow.close(); }
});


test('a large planning safety budget does not inflate the worker instruction hook deadline', () => {
  const { flow, config } = intake();
  try {
    const agents = JSON.parse(readFileSync(config.agentConfig, 'utf8'));
    agents.planningTimeoutMs = 21_600_000;
    agents.planningIdleTimeoutMs = 1_800_000;
    flow.save(config.agentConfig, agents);
    const planned = runFeature(config, 'plan') as any;
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
  } finally { flow.close(); }
});


test('a source-comparison failure remains blocking, then corrected detail resumes without replanning', () => {
  const { flow, config } = intake();
  config.maxRevisionRounds = 0;
  try {
    const outputsPath = join(flow.root, 'outputs.json');
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));
    const plan = outputs.detail.records[0];
    plan.readiness.comparison.result = 'untested';
    plan.readiness.comparison.findings = [{ result: 'untested', description: 'Code and check-plan have not run yet',
      sourceRefs: plan.readiness.comparison.sourceRefs, evidence: [] }];
    flow.save(outputsPath, outputs);
    assert.throws(() => runFeature(config, 'plan'), /check-plan_failed/);
    assert.equal(flow.wrapper.read().calls.length, 0);
    const check = JSON.parse(readFileSync(join(config.runDirectory, 'check-plan.stdout'), 'utf8'));
    assert.ok(check.check.findings.some((finding: any) => finding.code === 'source_gap'));
    outputs.detail.expectedRevision = 1;
    outputs.detail.stage.revision = 2;
    outputs.detail.stage.artifact.revision = 3;
    plan.readiness.comparison.result = 'passed'; plan.readiness.comparison.findings = [];
    for (const record of outputs.detail.records) {
      record.revision = 3;
      if (record.kind === 'detailed_plan_task') record.plan.revision = 3;
    }
    for (const task of plan.deliverySequence) task.revision = 3;
    for (const slice of plan.workflow.slices) for (const task of slice.tasks) task.revision = 3;
    flow.save(outputsPath, outputs);
    const planned = runFeature(config, 'plan', '--resume') as any;
    assert.equal(flow.wrapper.read().tasks[planned.tasks[0].taskId]!.held, true);
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const step of ['understand', 'design', 'plan']) assert.equal(calls.filter((call) => call.step === step).length, 1);
    assert.equal(calls.filter((call) => call.step === 'detail').length, 2);
  } finally { flow.close(); }
});


test('plan resume reconciles only saved operations after a partial native transport failure', () => {
  const { flow, config } = intake(true);
  try {
    flow.wrapper.edit((native) => { native.failure = { action: 'add', when: 'before', used: false }; });
    assert.throws(() => runFeature(config, 'plan'), /reconcile-task/);
    const saved = JSON.parse(readFileSync(join(config.runDirectory, 'planned.json'), 'utf8'));
    const calls = readFileSync(join(flow.root, 'agents.jsonl'), 'utf8');
    assert.deepEqual(runFeature(config, 'plan', '--resume'), saved);
    assert.equal(readFileSync(join(flow.root, 'agents.jsonl'), 'utf8'), calls, 'Never re-author checked work');
    for (const task of saved.tasks) assert.equal(flow.wrapper.read().tasks[task.taskId]!.held, true);
    const writes = flow.wrapper.read().calls.filter((call) => call.args[0] === 'add' && saved.tasks.some((task: any) => task.taskId === call.args[1]));
    assert.equal(writes.length, saved.tasks.length);
    const tampered = structuredClone(saved); tampered.tasks[0].task.revision++;
    flow.save(join(config.runDirectory, 'planned.json'), tampered);
    assert.throws(() => runFeature(config, 'plan', '--resume'), /planned_reconciliation_context_changed/);
  } finally { flow.close(); }
});

test('a checked plan resumes without agents and keeps pinned evidence and plain web references distinct', () => {
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
    const plainReference = { uri: 'https://example.invalid/background' };
    outputs.design.records[0].sourceRefs.push(source, reference.source, plainReference);
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
      assert.ok(!assignment.selectedContext.some((context) => context.source.uri === plainReference.uri));
      const design = store.get(config.project.id, assignment.design.id, assignment.design.revision);
      assert.ok(design?.kind === 'design_revision');
      assert.ok(design.sourceRefs.some((source) => source.uri === plainReference.uri));
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
