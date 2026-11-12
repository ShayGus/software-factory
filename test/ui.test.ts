import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import {
  ProjectStore, RecordsSchema, ToolkitApi, buildEditCommand, createToolkitRequestHandler, projectView, renderFeature,
  type EditContext, type EditValues, type FactoryRecord, captureRequest, validateAssignmentForDispatch, checkPlanReadiness,
  workView, WorkSnapshotSchema, type UiOptions, recordStage,
  queueCorrection, deliverCorrection,
  consolidateLearning, nextLearningWindow,
  validateRecords,
  guidanceForContext,
} from '../src/index.js';
import { fakeTask, fakeTaskWrapper } from './task-wrapper-helper.js';
import { fakeJudge } from './judge-helper.js';

const fixture = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/ui-overview.json', import.meta.url), 'utf8')));
function setup(t: test.TestContext, history: FactoryRecord[] = fixture, options: Partial<UiOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-ui-'));
  const database = join(directory, 'project.sqlite');
  const store = new ProjectStore(database);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history, receipts: [] });
  const backend = fakeTaskWrapper(directory, true, database);
  backend.edit((state) => {
    state.tasks['pilot-build'] = fakeTask('pilot-build', { title: 'Common feature', state: 'done', priority: 1 });
    state.tasks['pilot-verify'] = fakeTask('pilot-verify', { title: 'Second-system acceptance', priority: 2 });
  });
  const adapter = { fmHome: directory, tasksExecutable: backend.executable, guardTaskId: 'permanent-guard' };
  const api = new ToolkitApi(store, adapter, { projectId: 'project-1', fixture: true, ...options });
  const handler = createToolkitRequestHandler(api, { port: 4712 });
  async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const request = Object.assign(Readable.from([Buffer.from(raw)]), { method, url: path,
      headers: { host: '127.0.0.1:4712', origin: 'http://127.0.0.1:4712', 'content-type': 'application/json', ...headers } });
    const response = { status: 0, body: '', headers: {} as Record<string, string>,
      writeHead(status: number, values: Record<string, string>) { this.status = status; this.headers = values; return this; },
      end(body = '') { this.body = body; } };
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return { ...response, json: () => JSON.parse(response.body) };
  }
  return { directory, database, store, backend, api, http };
}
const decode = (value: string) => value.replace(/&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/&gt;/gu, '>').replace(/&lt;/gu, '<').replace(/&amp;/gu, '&');
function editors(html: string) {
  return [...html.matchAll(/<form data-editor>([\s\S]*?)<\/form>/gu)].map((match) => {
    const markup = match[1]!;
    const raw = markup.match(/name="context" value="([^"]*)"/u)?.[1];
    assert.ok(raw);
    const context = JSON.parse(decode(raw)) as EditContext;
    const values: EditValues = {};
    for (const match of markup.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gu)) if (match[1] !== 'context') values[match[1]!] = decode(match[2]!);
    for (const match of markup.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gu)) values[match[1]!] = decode(match[2]!);
    for (const match of markup.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/gu)) values[match[1]!] = decode(match[2]!.match(/<option selected>([^<]*)/u)?.[1] ?? match[2]!.match(/<option>([^<]*)/u)?.[1] ?? '');
    return { context, values };
  });
}
function findEditor(html: string, kind: EditContext['kind'], action?: string) {
  const editor = editors(html).find(({ context }) => context.kind === kind &&
    (!action || (context.kind === 'task' && context.action === action && context.mapping.firstMateTaskId === 'pilot-verify')));
  assert.ok(editor, `Missing ${kind} ${action ?? ''} editor`);
  return editor;
}
async function sendEdit(flow: ReturnType<typeof setup>, editor: ReturnType<typeof findEditor>, values: EditValues = {}, key = 'edit-1') {
  const command = buildEditCommand(editor.context, { ...editor.values, ...values, reason: 'Preserve original intent: שלום ☕' }, key, new Date().toISOString());
  const first = await flow.http('POST', '/canonical', command);
  assert.equal(first.status, 200, first.body);
  const before = flow.store.exportProject('project-1');
  const calls = flow.backend.read().calls.length;
  const replay = await flow.http('POST', '/canonical', command);
  assert.equal(replay.status, 200, replay.body);
  assert.deepEqual(replay.json(), first.json(), 'Same key replays exactly the first response');
  assert.deepEqual(flow.store.exportProject('project-1'), before);
  assert.equal(flow.backend.read().calls.length, calls);
  const stale = await flow.http('POST', '/canonical', { ...command, idempotencyKey: `${key}-stale` });
  assert.equal(stale.status, 409, stale.body);
  assert.equal(stale.json().error.code, 'conflict');
  const different = structuredClone(command);
  if (different.command === 'record_decision_suggestion') different.payload.decision.rationale = 'Different intent';
  else if (different.command === 'design_plan_feature' && 'design' in different.payload) different.payload.design.productBehavior = 'Different intent';
  else if (different.command === 'map_manage_execution_task') different.payload.reason = 'Different intent';
  else assert.fail('Unexpected editor command');
  const changed = await flow.http('POST', '/canonical', different);
  assert.equal(changed.status, 400);
  assert.equal(changed.json().error.message, 'idempotency_conflict');
  return { command, first };
}

for (const screen of ['/', '/projects/project-1/features/feature-1']) {
  test(`feature priority, outcome and deferral round trip from ${screen}`, async (t) => {
    const flow = setup(t);
    const original = flow.store.get('project-1', 'request-1');
    const page = await flow.http('GET', screen);
    assert.equal(page.status, 200, page.body);
    const { command } = await sendEdit(flow, findEditor(page.body, 'feature'), { priority: '3', outcome: 'Preserve every connected system', disposition: 'deferred' });
    const feature = flow.store.get('project-1', 'feature-1');
    assert.ok(feature?.kind === 'feature_revision');
    assert.equal(feature.priority, 3); assert.equal(feature.disposition.state, 'deferred'); assert.equal(feature.outcome, 'Preserve every connected system');
    assert.equal(feature.revision, 2);
    assert.deepEqual(flow.store.get('project-1', 'request-1'), original);
    const next = await flow.http('GET', screen);
    await sendEdit(flow, findEditor(next.body, 'feature'), { priority: '0', disposition: 'active' }, 'resume-feature');
    assert.equal(flow.store.get('project-1', 'feature-1')!.revision, 3);
    // A delayed replay after another operation still returns its original refs.
    assert.deepEqual((await flow.http('POST', '/canonical', command)).json().records.find((ref: { id: string }) => ref.id === feature.id), { id: feature.id, revision: 2 });
  });
}
for (const kind of ['design', 'plan', 'plan-task', 'criterion'] as const) test(`${kind} editor revises canonical artifacts and preserves old assignment trace`, async (t) => {
  const flow = setup(t);
  const page = await flow.http('GET', '/projects/project-1/features/feature-1');
  const changes: EditValues = kind === 'design' ? { productBehavior: 'Every connected system shares the feature. No example narrows the request.' } :
    kind === 'plan' ? { integrationApproach: 'Verify two adapters through the same interface', finalVerification: 'Run both connected systems' } :
      kind === 'plan-task' ? { outputs: 'General implementation\nAcceptance evidence for both systems' } :
        { verificationMethod: 'Use a non-ERPNext system through the shared interface' };
  await sendEdit(flow, findEditor(page.body, kind), changes);
  const current = flow.store.get('project-1', kind === 'criterion' ? 'criterion-general' : kind === 'design' ? 'design-1' : kind === 'plan-task' ? 'task-1' : 'plan-1');
  assert.equal(current?.revision, 2);
  if (kind === 'design') { assert.ok(current?.kind === 'design_revision'); assert.equal(current.productBehavior, changes.productBehavior); }
  if (kind === 'plan') { assert.ok(current?.kind === 'implementation_plan_revision'); assert.equal(current.integrationApproach, changes.integrationApproach); assert.deepEqual(current.workflow?.finalVerification, ['Run both connected systems']); }
  if (kind === 'plan-task') { assert.ok(current?.kind === 'detailed_plan_task'); assert.deepEqual(current.outputs, ['General implementation', 'Acceptance evidence for both systems']); }
  if (kind === 'criterion') { assert.ok(current?.kind === 'criterion'); assert.equal(current.verificationMethod, changes.verificationMethod); }
  const assignment = flow.store.get('project-1', 'assignment-1');
  assert.ok(assignment?.kind === 'assignment'); assert.deepEqual(assignment.plan, { id: 'plan-1', revision: 1 });
  assert.deepEqual(assignment.detailedPlanTask, { id: 'task-1', revision: 1 });
  assert.equal((await flow.http('GET', '/projects/project-1/features/feature-1')).status, 200);
  assert.equal((await flow.http('GET', '/projects/project-1/inspect/plan-1?revision=1')).status, 200);
});
for (const screen of ['/', '/projects/project-1/features/feature-1']) for (const action of ['set_priority', 'edit_dependencies', 'pause'] as const) test(`task ${action} from ${screen} uses BUILD-08 with stable replay and no native lifecycle edits`, async (t) => {
  const flow = setup(t);
  if (action === 'edit_dependencies') {
    flow.backend.edit((state) => { state.tasks['pilot-verify']!.deps = [{ id: 'pilot-build', type: 'blocked-by' }]; });
    const mapping = flow.store.get('project-1', 'mapping-2');
    assert.ok(mapping?.kind === 'task_mapping');
    assert.deepEqual(mapping.dependencies, ['pilot-build']);
  }
  const page = await flow.http('GET', screen);
  const { command, first } = await sendEdit(flow, findEditor(page.body, 'task', action), { priority: '0', dependencies: '' });
  const saved = flow.backend.read().tasks['pilot-verify']!;
  assert.equal(saved.state, 'queued');
  if (action === 'set_priority') assert.equal(saved.priority, 0);
  if (action === 'edit_dependencies') {
    assert.deepEqual(saved.deps, []);
    const mapping = flow.store.get('project-1', 'mapping-2'); assert.ok(mapping?.kind === 'task_mapping');
    assert.deepEqual(mapping.dependencies, []);
  }
  if (action === 'pause') {
    assert.ok(saved.hold);
    const next = await flow.http('GET', '/projects/project-1/features/feature-1');
    await sendEdit(flow, findEditor(next.body, 'task', 'resume'), {}, 'resume-task');
    assert.equal(flow.backend.read().tasks['pilot-verify']!.hold, null);
    assert.deepEqual((await flow.http('POST', '/canonical', command)).json(), first.json(), 'Old task replay after resume is stable');
  }
});

test('rendered pages retain original intent, a brief-to-plan route, evidence gaps and text uncertainty states', async (t) => {
  const flow = setup(t);
  const page = await flow.http('GET', '/projects/project-1/features/feature-1');
  assert.match(page.body, /Build feature X for every connected system, ERPNext is only an example\./u);
  assert.match(page.body, /Missing evidence — untested/u);
  assert.match(page.body, /A non-ERPNext connected system uses the same feature\./u);
  assert.match(page.body, /Worker briefs → plan tasks/u);
  const briefs = page.body.match(/<section id="briefs">([\s\S]*?)<\/section>/u)?.[1]; assert.ok(briefs);
  const assignment = [...briefs.matchAll(/<article>([\s\S]*?)<\/article>/gu)].find((match) => match[1]!.includes('inspect/assignment-1?revision=1'))?.[1];
  assert.ok(assignment, 'assignment-1 article must exist inside the briefs section');
  const derived = assignment.match(/<p>Derived from ([\s\S]*?)<\/p>/u)?.[1]; assert.ok(derived);
  assert.match(derived, /href="\/projects\/project-1\/inspect\/task-1\?revision=1"/u);
  assert.match(derived, /href="\/projects\/project-1\/inspect\/plan-1\?revision=1"/u);
  assert.match(page.body, /Attempt: attempt-1/u);
  assert.match(page.body, /Active feature revision/u);
  assert.match(page.body, /Unknown — execution observation unavailable/u);
  const overview = await flow.http('GET', '/');
  assert.match(overview.body, /Requested features[\s\S]*Suggestions · outside current scope/u);
  assert.match(overview.body, /Decisions needing input/u);
  assert.match(overview.body, /Open product question/u);
  const edit = findEditor(overview.body, 'task', 'set_priority');
  await sendEdit(flow, edit, { priority: '0' });
  const view = projectView(flow.store, { projectId: 'project-1', fixture: true, staleAfterMs: 1 }, Date.now() + 1000);
  assert.match(renderFeature(view, view.features[0]!), /Stale — last observed queued/u);
  assert.match(page.headers['Content-Security-Policy']!, /script-src 'self'/u);
});

test('lost task output remains unknown, cannot close a feature, and replay does not retry the transport', async (t) => {
  const flow = setup(t);
  const editor = findEditor((await flow.http('GET', '/')).body, 'task', 'set_priority');
  const command = buildEditCommand(editor.context, { priority: '0', reason: 'Change task priority' }, 'lost-key', new Date().toISOString());
  flow.backend.edit((state) => { state.failure = { action: 'update', when: 'after' }; });
  const response = await flow.http('POST', '/canonical', command);
  assert.equal(response.status, 202, response.body); assert.equal(response.json().operation.state, 'unknown');
  assert.equal(response.json().error.code, 'unknown_outcome');
  const calls = flow.backend.read().calls.length;
  assert.deepEqual((await flow.http('POST', '/canonical', command)).json(), response.json());
  assert.equal(flow.backend.read().calls.length, calls);
  const page = await flow.http('GET', '/');
  assert.match(page.body, /Unknown outcome — reconciliation required/u);
  assert.match(page.body, /Edits unavailable — inspect and reconcile/u);
  assert.match(page.body, /Incomplete — product behavior still needs verification/u);
});

test('HTTP rejects foreign origins, rebinding hosts, malformed commands and unsupported operations; assets are local', async (t) => {
  const flow = setup(t);
  assert.equal((await flow.http('GET', '/', undefined, { host: 'evil.example:4712' })).status, 403);
  assert.equal((await flow.http('POST', '/canonical', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await flow.http('POST', '/canonical', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await flow.http('POST', '/canonical', {})).json().error.code, 'validation');
  assert.equal((await flow.http('GET', '/projects/project-1/records/missing')).json().error.code, 'not_found');
  assert.equal((await flow.http('GET', '/projects/project-1/features/missing')).status, 404);
  assert.equal((await flow.http('GET', '/assets/../../package.json')).status, 404);
  for (const path of ['/assets/ui.css', '/assets/ui-client.js', '/assets/ui-edit.js']) {
    const response = await flow.http('GET', path); assert.equal(response.status, 200);
  }
  const before = flow.store.exportProject('project-1');
  const editor = findEditor((await flow.http('GET', '/')).body, 'feature');
  const command = buildEditCommand(editor.context, { priority: '2', reason: 'CLI canonical operation' }, 'cli-edit', new Date().toISOString());
  const { writeFileSync } = await import('node:fs');
  const file = join(flow.directory, 'command.json'); writeFileSync(file, JSON.stringify(command));
  const result = spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'apply-command', '--db', flow.database, '--input', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await flow.http('POST', '/canonical', command)).json(), JSON.parse(result.stdout));
  assert.notDeepEqual(flow.store.exportProject('project-1'), before);
});

test('untrusted source text stays text in HTML and form context', async (t) => {
  const flow = setup(t);
  const feature = flow.store.get('project-1', 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  const command = buildEditCommand({ kind: 'feature', feature }, { priority: '1', outcome: '<script>alert(1)</script> " &', reason: 'Untrusted input' }, 'escaping', new Date().toISOString());
  assert.equal((await flow.http('POST', '/canonical', command)).status, 200);
  const page = await flow.http('GET', '/');
  assert.doesNotMatch(page.body, /<script>alert\(1\)<\/script>/u);
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});

test('design edits conflict when the referenced feature changes, even if the design target has not changed', async (t) => {
  const flow = setup(t);
  const html = (await flow.http('GET', '/projects/project-1/features/feature-1')).body;
  const editor = findEditor(html, 'design');
  const draft = buildEditCommand(editor.context, { ...editor.values, reason: 'Revise design based on source' }, 'draft-design', new Date().toISOString());
  await sendEdit(flow, findEditor(html, 'feature'), { priority: '4' }, 'priority-before-design');
  const response = await flow.http('POST', '/canonical', draft);
  assert.equal(response.status, 409, response.body);
  assert.equal(flow.store.get('project-1', 'design-1')!.revision, 1);
});

test('HTTP stage envelopes reuse the existing staged operation, preserve project identity and replay', async (t) => {
  const flow = setup(t);
  const stage = flow.store.get('project-1', 'stage-understand');
  const understanding = flow.store.get('project-1', 'understanding-1');
  assert.ok(stage?.kind === 'stage_revision' && understanding?.kind === 'understanding_revision');
  const at = new Date().toISOString();
  const command = { schemaVersion: 1, id: 'stage-http', projectId: 'project-1', issuedAt: at,
    idempotencyKey: 'stage-http', command: 'design_plan_feature', targetId: stage.id, expectedRevision: 1,
    payload: { action: 'record_stage', stage: { ...stage, revision: 2, updatedAt: at, artifact: { id: understanding.id, revision: 2 } },
      records: [{ ...understanding, revision: 2, updatedAt: at, changeReason: 'Clarify existing research' }] } };
  assert.equal((await flow.http('POST', '/canonical', { ...command, projectId: 'another-project' })).status, 400);
  const response = await flow.http('POST', '/canonical', command);
  assert.equal(response.status, 200, response.body);
  assert.deepEqual((await flow.http('POST', '/canonical', command)).json(), response.json());
  assert.equal((await flow.http('POST', '/canonical', { ...command, idempotencyKey: 'stale-stage' })).status, 409);
  assert.equal(flow.store.get('project-1', understanding.id)!.revision, 2);
});

const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
for (const kind of ['design', 'plan', 'plan-task'] as const) test(`review 1: criterion changes can be followed by a ${kind} edit`, async (t) => {
  const history = structuredClone(fixture);
  const plan = history.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
  plan.dependencies = [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'task-2', reason: 'Consumes the common behavior', needs: { kind: 'criterion', criterion: { id: 'criterion-general', revision: 1 } } }];
  const flow = setup(t, history);
  const originalAssignment = flow.store.get('project-1', 'assignment-1');
  await sendEdit(flow, findEditor((await flow.http('GET', '/projects/project-1/features/feature-1')).body, 'criterion'), { verificationMethod: 'Verify the amended criterion through the common interface' }, 'amend-criterion');
  await sendEdit(flow, findEditor((await flow.http('GET', '/projects/project-1/features/feature-1')).body, kind), {}, `after-criterion-${kind}`);
  const current = flow.store.get('project-1', 'plan-1'); assert.ok(current?.kind === 'implementation_plan_revision');
  const expected = { id: 'criterion-general', revision: 2 };
  assert.deepEqual(current.workflow!.slices[0]!.criteria.find((criterion) => criterion.id === expected.id), expected);
  assert.deepEqual(current.dependencies[0]!.needs, { kind: 'criterion', criterion: expected });
  const task = flow.store.get('project-1', 'task-1'); assert.ok(task?.kind === 'detailed_plan_task');
  assert.deepEqual(task.criteria.find((criterion) => criterion.id === expected.id), expected);
  assert.deepEqual(flow.store.get('project-1', 'assignment-1'), originalAssignment);
});

test('review 3: UI priority-only changes preserve dispatch eligibility and product decisions', async (t) => {
  const flow = setup(t, baseline);
  const target = { id: 'assignment-1', revision: 1 };
  const before = validateAssignmentForDispatch(flow.store.history('project-1'), target);
  assert.equal(before.ok, true, JSON.stringify(before));
  const feature = flow.store.get('project-1', 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  await sendEdit(flow, findEditor((await flow.http('GET', '/')).body, 'feature'), { priority: '4' }, 'priority-only');
  const after = validateAssignmentForDispatch(flow.store.history('project-1'), target);
  assert.equal(after.ok, true, JSON.stringify(after));
  const current = flow.store.get('project-1', feature.id); assert.ok(current?.kind === 'feature_revision');
  assert.deepEqual(current.decisions, feature.decisions);
  assert.ok(projectView(flow.store, { projectId: 'project-1' }).features[0]!.decisions.some((decision) => decision.id === 'change-priority-only'));
});

test('review 4: selected reused design stays visible and editable beside newer drafts', async (t) => {
  const history = structuredClone(baseline);
  const design = history.find((record) => record.kind === 'design_revision'); assert.ok(design?.kind === 'design_revision');
  history.push({ ...design, revision: 2, updatedAt: '2026-11-12T10:00:00Z', productBehavior: 'Unselected draft behavior', sourceComparison: { ...design.sourceComparison, result: 'untested' } });
  const understanding = fixture.find((record) => record.kind === 'understanding_revision'); assert.ok(understanding?.kind === 'understanding_revision');
  const first = fixture.find((record) => record.kind === 'stage_revision' && record.stage === 'understand'); assert.ok(first?.kind === 'stage_revision');
  const selected = fixture.find((record) => record.kind === 'stage_revision' && record.stage === 'design'); assert.ok(selected?.kind === 'stage_revision');
  history.push(understanding, first, { ...selected, reuse: { check: { ...design.sourceComparison, sourceRefs: [...design.sourceComparison.sourceRefs, { uri: 'fixture://selected-design', record: { id: design.id, revision: 1 } }] }, criterionMap: first.criteria.map((criterion) => ({ existing: criterion, current: criterion })) } });
  const plan = history.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
  const planStage = fixture.find((record) => record.kind === 'stage_revision' && record.stage === 'plan'); assert.ok(planStage?.kind === 'stage_revision');
  history.push(planStage, { ...plan, revision: 2, updatedAt: '2026-11-12T11:00:00Z', integrationApproach: 'Unselected plan draft',
    readiness: { ...plan.readiness, ready: false }, workflow: { slices: [{ id: 'draft-slice', behavior: 'Draft behavior', criteria: first.criteria, tasks: plan.deliverySequence }],
      scope: [], integrationSteps: [], finalVerification: [], changeReason: 'Unselected draft', retainedTasks: plan.deliverySequence.map((task) => ({ task, reason: 'Keep original task detail' })) } });

  const flow = setup(t, history);
  const view = projectView(flow.store, { projectId: 'project-1' });
  assert.equal(view.features[0]!.design?.revision, 1);
  assert.equal(view.features[0]!.plan?.revision, 1);
  assert.match(view.features[0]!.completeness, /^Complete/u);
  const page = await flow.http('GET', '/projects/project-1/features/feature-1');
  assert.match(page.body, /Newer draft/u);
  const editor = findEditor(page.body, 'design'); assert.ok(editor.context.kind === 'design');
  assert.equal(editor.context.design.revision, 1);
  assert.equal(editor.values.productBehavior, design.productBehavior);
  await sendEdit(flow, editor, { productBehavior: 'Edit selected behavior while retaining draft history' }, 'selected-design-edit');
  assert.equal(flow.store.get('project-1', design.id)!.revision, 3);
  assert.equal(flow.store.get('project-1', design.id, 2)?.kind, 'design_revision');
});

test('review 5: unclassified captured requests remain visible without any feature mapping', async (t) => {
  const flow = setup(t);
  const result = captureRequest(flow.store, { projectId: 'project-1', clientRequestId: 'unmapped-extra', originalText: 'Also preserve this separate request exactly.', channel: 'cli', source: { uri: 'fixture://unmapped-request' }, attachments: [] });
  const page = await flow.http('GET', '/');
  assert.match(page.body, /Unmapped requests/u);
  assert.match(page.body, /Also preserve this separate request exactly\./u);
  assert.ok(page.body.includes(`/inspect/${encodeURIComponent(result.request.id)}?revision=1`));
});

test('review 6: a partial product review demonstrates one criterion while retaining the missing one', async (t) => {
  const history = structuredClone(baseline);
  const review = history.find((record) => record.kind === 'product_review'); assert.ok(review?.kind === 'product_review');
  const common = history.find((record) => record.id === 'result-general'); assert.ok(common?.kind === 'criterion_result');
  const missing = history.find((record) => record.id === 'result-second'); assert.ok(missing?.kind === 'criterion_result');
  missing.result = 'untested'; missing.evidence = []; missing.artifact = null;
  review.outcome = 'incomplete';
  review.planConformance = { ...review.planConformance, result: 'untested', findings: [
    { criterionId: 'criterion-general', result: 'passed', description: 'Common behavior was reviewed', sourceRefs: review.sourceRefs, evidence: common.evidence },
    { criterionId: 'criterion-second-system', result: 'untested', description: 'Second-system acceptance remains untested', sourceRefs: review.sourceRefs, evidence: [] },
  ] };
  const flow = setup(t, history);
  const view = projectView(flow.store, { projectId: 'project-1' }).features[0]!;
  assert.equal(view.criteria.find((criterion) => criterion.target.id === 'criterion-general')?.label, 'Demonstrated (reviewed)');
  assert.deepEqual(view.remaining.map((criterion) => criterion.target.id), ['criterion-second-system']);
  assert.match(view.completeness, /^Incomplete/u);
});

test('review 7: a requested priority without an observation remains Unknown after adapter failure', async (t) => {
  const flow = setup(t);
  const editor = findEditor((await flow.http('GET', '/')).body, 'task', 'set_priority');
  const command = buildEditCommand(editor.context, { priority: '0', reason: 'Request priority change' }, 'missing-adapter', new Date().toISOString());
  const api = new ToolkitApi(flow.store, { fmHome: flow.directory, tasksExecutable: join(flow.directory, 'missing-wrapper') });
  assert.equal(api.handle('POST', '/canonical', command).status, 502);
  const task = projectView(flow.store, { projectId: 'project-1' }).features[0]!.tasks.find((task) => task.mapping.id === 'mapping-2'); assert.ok(task);
  assert.equal(task.priority, undefined);
  assert.match(task.label, /^Unknown/u);
});

test('review 1314 finding 1: design-save, reload and plan-save resume the same coherent draft', async (t) => {
  const flow = setup(t);
  const path = '/projects/project-1/features/feature-1';
  const originalAssignment = flow.store.get('project-1', 'assignment-1');
  const designSave = await sendEdit(flow, findEditor((await flow.http('GET', path)).body, 'design'), { productBehavior: 'Saved design behavior must survive the next plan edit' }, 'continuous-design');
  const reloaded = await flow.http('GET', designSave.first.json().resumeUrl);
  const planSave = await sendEdit(flow, findEditor(reloaded.body, 'plan'), { integrationApproach: 'Saved plan change must preserve the design draft' }, 'continuous-plan');
  const design = flow.store.get('project-1', 'design-1'); assert.ok(design?.kind === 'design_revision');
  const plan = flow.store.get('project-1', 'plan-1'); assert.ok(plan?.kind === 'implementation_plan_revision');
  assert.equal(design.productBehavior, 'Saved design behavior must survive the next plan edit');
  assert.equal(plan.integrationApproach, 'Saved plan change must preserve the design draft');
  assert.deepEqual(plan.design, { id: design.id, revision: design.revision });
  const outputSave = await sendEdit(flow, findEditor((await flow.http('GET', planSave.first.json().resumeUrl)).body, 'plan-task'), { outputs: 'Keep this saved task draft output' }, 'continuous-task-output');
  const verificationSave = await sendEdit(flow, findEditor((await flow.http('GET', outputSave.first.json().resumeUrl)).body, 'plan-task'), { verificationMethod: 'Verify without discarding the saved output' }, 'continuous-task-verification');
  const task = flow.store.get('project-1', 'task-1'); assert.ok(task?.kind === 'detailed_plan_task');
  assert.deepEqual(task.outputs, ['Keep this saved task draft output']);
  assert.equal(task.verificationMethod, 'Verify without discarding the saved output');
  const selected = projectView(flow.store, { projectId: 'project-1' }).features[0]!;
  assert.equal(selected.design?.revision, 1, 'Draft edits do not silently select the new design');
  assert.equal(selected.plan?.revision, 1, 'Draft edits do not silently select the new plan');
  const nextEditor = findEditor((await flow.http('GET', verificationSave.first.json().resumeUrl)).body, 'plan'); assert.ok(nextEditor.context.kind === 'plan');
  assert.equal(nextEditor.context.design.productBehavior, design.productBehavior);
  assert.equal(nextEditor.values.integrationApproach, plan.integrationApproach);
  assert.deepEqual(flow.store.get('project-1', 'assignment-1'), originalAssignment);
});

for (const oldReady of [false, true]) test(`review 1314 finding 4: old Detail${oldReady ? ' and ready revision' : ''} cannot override the current Plan stage`, async (t) => {
  const history = structuredClone(fixture);
  const originalDesign = history.find((record) => record.kind === 'design_revision'); assert.ok(originalDesign?.kind === 'design_revision');
  const originalPlan = history.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(originalPlan?.kind === 'implementation_plan_revision');
  const designStage = history.find((record) => record.kind === 'stage_revision' && record.stage === 'design'); assert.ok(designStage?.kind === 'stage_revision');
  const planStage = history.find((record) => record.kind === 'stage_revision' && record.stage === 'plan'); assert.ok(planStage?.kind === 'stage_revision');
  const detailStage = history.find((record) => record.kind === 'stage_revision' && record.stage === 'detail'); assert.ok(detailStage?.kind === 'stage_revision');
  const at = new Date().toISOString();
  const design = { ...originalDesign, revision: 2, updatedAt: at, productBehavior: 'New explicitly selected design', sourceComparison: { ...originalDesign.sourceComparison, result: 'untested' as const } };
  const taskRecords = history.filter((record): record is Extract<FactoryRecord, { kind: 'detailed_plan_task' }> => record.kind === 'detailed_plan_task');
  for (const task of taskRecords) { task.verificationMethod = 'Run the recorded acceptance cases'; task.decisionsToKeep = []; }
  const tasks = taskRecords.map((task) => ({ ...task, id: `new-${task.id}`, updatedAt: at,
    plan: { id: 'new-selected-plan', revision: 1 }, design: { id: design.id, revision: 2 },
    designRefs: [{ uri: 'fixture://new-design', record: { id: design.id, revision: 2 } }] }));
  const plan = { ...originalPlan, id: 'new-selected-plan', updatedAt: at, design: { id: design.id, revision: 2 },
    deliverySequence: tasks.map((task) => ({ id: task.id, revision: task.revision })),
    priorities: tasks.map((task, priority) => ({ taskId: task.id, priority })),
    readiness: { ready: false, comparison: { ...originalPlan.readiness.comparison, result: 'untested' as const,
      sourceRefs: [{ uri: 'fixture://request', record: { id: 'request-1', revision: 1 } }, { uri: 'fixture://new-design', record: { id: design.id, revision: 2 } }] } },
    workflow: { ...originalPlan.workflow!, slices: originalPlan.workflow!.slices.map((slice) => ({ ...slice,
      tasks: slice.tasks.map((task) => ({ ...task, id: `new-${task.id}` })) })) } };
  history.push(design, plan, ...tasks, { ...designStage, revision: 2, updatedAt: at, artifact: { id: design.id, revision: 2 } },
    { ...planStage, revision: 2, updatedAt: at, artifact: { id: plan.id, revision: 1 }, previousStage: { id: designStage.id, revision: 2 } });
  const flow = setup(t, history);
  if (oldReady) {
    const result = checkPlanReadiness(flow.store, { projectId: 'project-1', detailStage: { id: detailStage.id, revision: 1 },
      expectedPlanRevision: 1, idempotencyKey: 'old-detail-readiness', issuedAt: at });
    assert.ok(result.readyPlan, JSON.stringify(result.check));
  }
  const selected = projectView(flow.store, { projectId: 'project-1' }).features[0]!;
  assert.equal(selected.plan?.id, plan.id);
  assert.equal(selected.design?.revision, 2);
  assert.equal(selected.planDrafts.some((draft) => draft.id === plan.id && draft.revision === 1), false);
  const page = await flow.http('GET', '/projects/project-1/features/feature-1');
  const editor = findEditor(page.body, 'plan'); assert.ok(editor.context.kind === 'plan');
  assert.equal(editor.context.plan.id, plan.id);
  assert.match(page.body, /Historical detailed plans/u);
  const historical = page.body.match(/<p>Historical detailed plans: ([\s\S]*?)<\/p>/u)?.[1]; assert.ok(historical);
  assert.match(historical, /href="\/projects\/project-1\/inspect\/plan-1\?revision=1"/u);
});

for (const oldDraft of [false, true]) test(`review 1328 finding 1: selecting D2 keeps D2 as the edit base${oldDraft ? ' despite a D1 draft' : ''}`, async (t) => {
  const history = structuredClone(fixture);
  const design = history.find((record) => record.kind === 'design_revision'); assert.ok(design?.kind === 'design_revision');
  const stage = history.find((record) => record.kind === 'stage_revision' && record.stage === 'design'); assert.ok(stage?.kind === 'stage_revision');
  const plan = history.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
  const at = new Date().toISOString();
  history.push({ ...design, revision: 2, updatedAt: at, productBehavior: 'Explicitly selected D2 behavior must survive', sourceComparison: { ...design.sourceComparison, result: 'untested' } },
    { ...stage, revision: 2, updatedAt: at, artifact: { id: design.id, revision: 2 } });
  if (oldDraft) history.push({ ...plan, revision: 2, updatedAt: at, integrationApproach: 'Draft built on superseded D1',
    workflow: { ...plan.workflow!, retainedTasks: plan.deliverySequence.map((task) => ({ task, reason: 'Retained old task detail' })) } });
  const flow = setup(t, history);
  const path = '/projects/project-1/features/feature-1';
  const page = await flow.http('GET', path);
  const editor = findEditor(page.body, 'design'); assert.ok(editor.context.kind === 'design');
  assert.equal(editor.values.productBehavior, 'Explicitly selected D2 behavior must survive');
  assert.equal(editor.context.design.revision, 2);
  if (oldDraft) {
    assert.doesNotMatch(page.body, /Conflict/u);
    assert.equal(editor.context.plan.revision, 1, 'The incompatible old draft is not a save base');
  }
  const designSave = await sendEdit(flow, editor, { technicalDesign: 'Technical change based on selected D2' }, 'selected-D2-design');
  await sendEdit(flow, findEditor((await flow.http('GET', designSave.first.json().resumeUrl)).body, 'plan'), { integrationApproach: 'Plan change retains selected D2' }, 'selected-D2-plan');
  const current = flow.store.get('project-1', design.id); assert.ok(current?.kind === 'design_revision');
  assert.equal(current.productBehavior, 'Explicitly selected D2 behavior must survive');
  assert.equal(current.technicalDesign, 'Technical change based on selected D2');
  const currentPlan = flow.store.get('project-1', plan.id); assert.ok(currentPlan?.kind === 'implementation_plan_revision');
  assert.equal(currentPlan.integrationApproach, 'Plan change retains selected D2');
});

for (const replace of [false, true]) test(`review 1328 finding 2: ${replace ? 'replaced' : 'added'} draft task IDs get editors and retain their edits`, async (t) => {
  const flow = setup(t);
  const path = '/projects/project-1/features/feature-1';
  const editor = findEditor((await flow.http('GET', path)).body, 'design');
  const at = new Date().toISOString();
  const command = buildEditCommand(editor.context, { ...editor.values, reason: 'Prepare a draft with changed task IDs' }, 'changed-task-set', at);
  assert.ok(command.command === 'design_plan_feature' && 'tasks' in command.payload);
  const payload = command.payload;
  const replacements = new Map(payload.tasks.map((task) => [task.id, `draft-${task.id}`]));
  if (replace) {
    payload.tasks = payload.tasks.map((task) => ({ ...task, id: replacements.get(task.id)!, revision: 1, createdAt: at }));
    payload.plan.workflow!.slices = payload.plan.workflow!.slices.map((slice) => ({ ...slice,
      tasks: slice.tasks.map((task) => ({ id: replacements.get(task.id)!, revision: 1 })) }));
  } else {
    const original = payload.tasks[0]!;
    payload.tasks.push({ ...original, id: 'draft-added-task', revision: 1, createdAt: at, expectedBehavior: 'Refine the newly added task' });
    payload.plan.workflow!.slices[0]!.tasks.push({ id: 'draft-added-task', revision: 1 });
  }
  payload.plan.deliverySequence = payload.tasks.map((task) => ({ id: task.id, revision: task.revision }));
  payload.plan.priorities = payload.tasks.map((task, priority) => ({ taskId: task.id, priority }));
  const created = await flow.http('POST', '/canonical', command); assert.equal(created.status, 200, created.body);
  const page = await flow.http('GET', created.json().resumeUrl);
  const taskEditors = editors(page.body).filter((editor) => editor.context.kind === 'plan-task');
  assert.deepEqual(taskEditors.map((editor) => editor.context.kind === 'plan-task' && editor.context.taskId), payload.tasks.map((task) => task.id));
  const target = replace ? 'draft-task-1' : 'draft-added-task';
  const taskEditor = taskEditors.find((editor) => editor.context.kind === 'plan-task' && editor.context.taskId === target); assert.ok(taskEditor);
  const edited = await sendEdit(flow, taskEditor, { outputs: 'Persist this new task draft output' }, 'edit-new-task');
  const saved = flow.store.get('project-1', target); assert.ok(saved?.kind === 'detailed_plan_task');
  assert.deepEqual(saved.outputs, ['Persist this new task draft output']);
  const next = await flow.http('GET', edited.first.json().resumeUrl);
  const resumed = editors(next.body).find((editor) => editor.context.kind === 'plan-task' && editor.context.taskId === target); assert.ok(resumed);
  assert.equal(resumed.values.outputs, 'Persist this new task draft output');
  const historical = next.body.match(/<div id="historical-plan-tasks">([\s\S]*?)<\/div>/u)?.[1]; assert.ok(historical);
  assert.doesNotMatch(historical, /<form/u);
  assert.match(historical, /inspect\/assignment-1\?revision=1/u);
});

test('review 1335: explicit saved-bundle URLs identify the saved revisions independently of selection', async (t) => {
  const flow = setup(t);
  const path = '/projects/project-1/features/feature-1';
  const designSave = await sendEdit(flow, findEditor((await flow.http('GET', path)).body, 'design'), { productBehavior: 'Design saved in the explicitly named bundle' }, 'named-design');
  const first = designSave.first.json();
  assert.equal(typeof first.resumeUrl, 'string');
  assert.deepEqual(first.bundle.design, { id: 'design-1', revision: 2 });
  assert.deepEqual(first.bundle.plan, { id: 'plan-1', revision: 2 });
  const named = await flow.http('GET', first.resumeUrl);
  assert.equal(findEditor(named.body, 'design').values.productBehavior, 'Design saved in the explicitly named bundle');
  const selected = findEditor((await flow.http('GET', path)).body, 'plan'); assert.ok(selected.context.kind === 'plan');
  assert.equal(selected.context.plan.revision, 1);
  assert.equal(selected.context.design.revision, 1);
});

test('review 1335: selecting another plan cannot automatically resume the previous plan draft', async (t) => {
  const flow = setup(t);
  const path = '/projects/project-1/features/feature-1';
  await sendEdit(flow, findEditor((await flow.http('GET', path)).body, 'design'), { productBehavior: 'Draft of the previous plan' }, 'previous-plan-draft');
  const original = flow.store.get('project-1', 'plan-1', 1); assert.ok(original?.kind === 'implementation_plan_revision');
  const stage = flow.store.get('project-1', 'stage-plan'); assert.ok(stage?.kind === 'stage_revision');
  const at = new Date().toISOString();
  const tasks = original.deliverySequence.map((ref) => {
    const task = flow.store.get('project-1', ref.id, ref.revision); assert.ok(task?.kind === 'detailed_plan_task');
    return { ...task, id: `alternative-${task.id}`, plan: { id: 'alternative-plan', revision: 1 } };
  });
  const plan = { ...original, id: 'alternative-plan', updatedAt: '2026-11-11T00:00:00Z',
    deliverySequence: tasks.map((task) => ({ id: task.id, revision: task.revision })),
    priorities: tasks.map((task, priority) => ({ taskId: task.id, priority })),
    workflow: { ...original.workflow!, slices: original.workflow!.slices.map((slice) => ({ ...slice,
      tasks: slice.tasks.map((task) => ({ ...task, id: `alternative-${task.id}` })) })) } };
  const select = await flow.http('POST', '/canonical', { schemaVersion: 1, id: 'select-alternative', projectId: 'project-1',
    issuedAt: at, idempotencyKey: 'select-alternative', command: 'design_plan_feature', targetId: stage.id, expectedRevision: stage.revision,
    payload: { action: 'record_stage', stage: { ...stage, revision: stage.revision + 1, updatedAt: at, artifact: { id: plan.id, revision: 1 } }, records: [plan, ...tasks] } });
  assert.equal(select.status, 200, select.body);
  const page = await flow.http('GET', path);
  for (const editor of editors(page.body).filter((editor) => ['design', 'plan', 'plan-task'].includes(editor.context.kind))) {
    assert.ok('plan' in editor.context); assert.equal(editor.context.plan.id, plan.id);
  }
  assert.doesNotMatch(page.body, /Conflict/u);
});

test('review 1335: old-format drafts resume only through their explicit Inspect/Resume link', async (t) => {
  const flow = setup(t);
  const path = '/projects/project-1/features/feature-1';
  const editor = findEditor((await flow.http('GET', path)).body, 'design');
  const command = buildEditCommand(editor.context, { ...editor.values, productBehavior: 'Legacy draft behavior', reason: 'Old-format draft without base metadata' }, 'old-format-draft', new Date().toISOString());
  assert.ok(command.command === 'design_plan_feature' && 'plan' in command.payload);
  command.payload.existingDesignRefs = [];
  const first = await flow.http('POST', '/canonical', command); assert.equal(first.status, 200, first.body);
  const oldUrl = first.json().resumeUrl; assert.equal(typeof oldUrl, 'string');
  const newer = await sendEdit(flow, findEditor((await flow.http('GET', oldUrl)).body, 'plan'), { integrationApproach: 'Newer explicitly saved plan draft' }, 'newer-format-draft');
  const page = await flow.http('GET', path);
  assert.match(page.body, /Inspect\/Resume/u);
  assert.ok(page.body.includes(`href="${oldUrl}"`));
  assert.ok(page.body.includes(`href="${newer.first.json().resumeUrl}"`));
  const selected = findEditor(page.body, 'plan'); assert.ok(selected.context.kind === 'plan'); assert.equal(selected.context.plan.revision, 1);
  const old = findEditor((await flow.http('GET', oldUrl)).body, 'plan'); assert.ok(old.context.kind === 'plan');
  assert.equal(old.context.plan.revision, 2);
  assert.equal(old.context.design.productBehavior, 'Legacy draft behavior');
  await sendEdit(flow, old, { integrationApproach: 'Explicitly continued old draft' }, 'resume-old-draft');
  const current = flow.store.get('project-1', 'design-1'); assert.ok(current?.kind === 'design_revision'); assert.equal(current.productBehavior, 'Legacy draft behavior');
  const unavailable = `${path}?bundle=${encodeURIComponent(JSON.stringify({ ...first.json().bundle, plan: { id: 'missing-plan', revision: 1 } }))}`;
  const missing = await flow.http('GET', unavailable);
  assert.match(missing.body, /Conflict — named bundle no longer exists/u);
  assert.equal(editors(missing.body).filter((editor) => ['design', 'plan', 'plan-task'].includes(editor.context.kind)).length, 0);
});

test('review 1335: legacy assignment references select the bundle instead of a newer unstaged revision', async (t) => {
  const flow = setup(t, baseline);
  const path = '/projects/project-1/features/feature-1';
  const selected = findEditor((await flow.http('GET', path)).body, 'design');
  const saved = await sendEdit(flow, selected, { productBehavior: 'Explicit legacy draft remains separate from assigned work' }, 'legacy-unselected');
  const bare = findEditor((await flow.http('GET', path)).body, 'plan'); assert.ok(bare.context.kind === 'plan');
  assert.equal(bare.context.plan.revision, 1);
  assert.equal(bare.context.design.revision, 1);
  const resumed = findEditor((await flow.http('GET', saved.first.json().resumeUrl)).body, 'design'); assert.ok(resumed.context.kind === 'design');
  assert.equal(resumed.context.design.revision, 2);
  assert.equal(resumed.values.productBehavior, 'Explicit legacy draft remains separate from assigned work');
});

test('review 1335: an explicit saved bundle is editable without any selected stage or assignment', async (t) => {
  const history = baseline.filter((record) => ['project', 'request', 'feature_revision', 'criterion', 'design_revision', 'implementation_plan_revision', 'detailed_plan_task'].includes(record.kind));
  const flow = setup(t, history);
  const path = '/projects/project-1/features/feature-1';
  const page = await flow.http('GET', path);
  assert.equal(editors(page.body).filter((editor) => ['design', 'plan', 'plan-task'].includes(editor.context.kind)).length, 0);
  const href = page.body.match(/href="([^"]+\?bundle=[^"]+)">Inspect\/Resume/u)?.[1]; assert.ok(href);
  const named = await flow.http('GET', decode(href));
  const editor = findEditor(named.body, 'design'); assert.ok(editor.context.kind === 'design');
  assert.equal(editor.context.design.revision, 1);
  await sendEdit(flow, editor, { productBehavior: 'Explicitly edited without guessing a selection' }, 'explicit-unselected');
});

test('review 1349 finding 4: named bundle main content, editors and evidence describe the same revisions', async (t) => {
  const flow = setup(t, baseline);
  const path = '/projects/project-1/features/feature-1';
  assert.match(projectView(flow.store, { projectId: 'project-1' }).features[0]!.completeness, /^Complete/u);
  const designSave = await sendEdit(flow, findEditor((await flow.http('GET', path)).body, 'design'), { productBehavior: 'Named design body for revision-specific inspection' }, 'inspection-design');
  const planSave = await sendEdit(flow, findEditor((await flow.http('GET', designSave.first.json().resumeUrl)).body, 'plan'), { integrationApproach: 'Named plan body for revision-specific inspection' }, 'inspection-plan');
  const result = planSave.first.json();
  const page = await flow.http('GET', result.resumeUrl);
  const designEditor = findEditor(page.body, 'design'); assert.ok(designEditor.context.kind === 'design');
  const planEditor = findEditor(page.body, 'plan'); assert.ok(planEditor.context.kind === 'plan');
  const withoutForms = (html: string) => html.replace(/<form data-editor>[\s\S]*?<\/form>/gu, '');
  const designBody = withoutForms(page.body.match(/<section id="design">([\s\S]*?)<\/section>/u)?.[1] ?? '');
  const planBody = withoutForms(page.body.match(/<section id="plan">([\s\S]*?)<\/section>/u)?.[1] ?? '');
  assert.ok(designBody.includes(`<h3>Product behavior</h3><p class="prose">${designEditor.values.productBehavior}</p>`));
  assert.ok(planBody.includes(`<p class="prose">${planEditor.values.integrationApproach}</p>`));
  assert.equal(designEditor.context.design.revision, result.bundle.design.revision);
  assert.equal(planEditor.context.plan.revision, result.bundle.plan.revision);
  const selected = page.body.match(/<p id="selected-stage-context">([\s\S]*?)<\/p>/u)?.[1]; assert.ok(selected);
  assert.match(selected, /Selected-stage context/u);
  assert.match(selected, /inspect\/design-1\?revision=1/u);
  assert.match(selected, /inspect\/plan-1\?revision=1/u);
  const readiness = planBody.match(/<p>Readiness for ([\s\S]*?)<\/p>/u)?.[1]; assert.ok(readiness);
  assert.ok(readiness.includes(`/inspect/plan-1?revision=${result.bundle.plan.revision}`));
  assert.ok(readiness.includes(`/inspect/design-1?revision=${result.bundle.design.revision}`));
  assert.match(readiness, /Incomplete or stale/u);
  const criteria = page.body.match(/<section id="criteria">([\s\S]*?)<\/section>/u)?.[1]; assert.ok(criteria);
  const evidenceScope = criteria.match(/<p>Evidence for displayed bundle: ([\s\S]*?)<\/p>/u)?.[1]; assert.ok(evidenceScope);
  assert.ok(evidenceScope.includes(`/inspect/design-1?revision=${result.bundle.design.revision}`));
  assert.ok(evidenceScope.includes(`/inspect/plan-1?revision=${result.bundle.plan.revision}`));
  assert.match(criteria, /Incomplete — no current passing evidence/u);
  assert.match(criteria, /Stale or non-passing evidence; retained as history/u);
  assert.doesNotMatch(criteria, /Demonstrated \(reviewed\)|Reported current evidence/u);
  const briefs = page.body.match(/<section id="briefs">([\s\S]*?)<\/section>/u)?.[1]; assert.ok(briefs);
  assert.match(briefs, /Stale — assignment references earlier product revisions/u);
  assert.doesNotMatch(briefs, /Current referenced revisions/u);
  const stages = page.body.match(/<h2>Stage progress<\/h2>([\s\S]*?)<\/section>/u)?.[1]; assert.ok(stages);
  assert.match(stages, /Selected-stage history/u);
  assert.match(criteria, /Evidence revisions:[\s\S]*inspect\/design-1\?revision=1[\s\S]*inspect\/plan-1\?revision=1/u);
  assert.match(page.body, /Incomplete — product behavior still needs verification/u);
  assert.doesNotMatch(page.body, /Complete — current product review passed/u);
});

// BUILD-13 uses the same handler and canonical operation path as BUILD-12.
const workSnapshot = WorkSnapshotSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/ui-work-snapshot.json', import.meta.url), 'utf8')));
const workScreens = ['/projects/project-1/work', '/projects/project-1/dependencies', '/projects/project-1/work/mapping-2'];
for (const screen of workScreens) for (const action of ['set_priority', 'edit_dependencies', 'pause', 'cancel'] as const) test(`work action ${action} from ${screen} uses revision/idempotency protected BUILD-08`, async (t) => {
  const flow = setup(t);
  const page = await flow.http('GET', screen);
  assert.equal(page.status, 200, page.body);
  const editor = findEditor(page.body, 'task', action);
  const { command } = await sendEdit(flow, editor, { priority: '0', dependencies: '' });
  assert.equal(command.command, 'map_manage_execution_task');
  assert.equal(command.targetId, 'mapping-2');
  assert.equal(command.expectedRevision, 1);
  assert.equal(command.idempotencyKey, 'edit-1');
  const mapping = flow.store.get('project-1', 'mapping-2'); assert.ok(mapping?.kind === 'task_mapping');
  assert.ok(mapping.revision > command.expectedRevision, 'Intent and reconciliation advance the canonical mapping');
  const task = flow.backend.read().tasks['pilot-verify']!;
  assert.notEqual(task.state, 'done');
  if (action === 'set_priority') assert.equal(task.priority, 0);
  if (action === 'cancel') {
    assert.equal(mapping.disposition.state, 'cancelled');
    assert.equal(editors((await flow.http('GET', screen)).body).some(({ context }) => context.kind === 'task' && context.mapping.id === mapping.id), false);
  }
  if (action === 'edit_dependencies') {
    assert.deepEqual(task.deps, []);
    const next = await flow.http('GET', screen);
    await sendEdit(flow, findEditor(next.body, 'task', 'edit_dependencies'), { dependencies: 'pilot-build' }, 'add-prerequisite');
    assert.deepEqual(flow.backend.read().tasks['pilot-verify']!.deps, [{ type: 'blocked-by', id: 'pilot-build' }]);
  }
  if (action === 'pause') {
    assert.ok(task.hold);
    const held = await flow.http('GET', screen);
    assert.match(held.body, /Task is paused/u);
    assert.match(held.body, /Hold:/u);
    await sendEdit(flow, findEditor(held.body, 'task', 'resume'), {}, 'unhold-task');
    assert.equal(flow.backend.read().tasks['pilot-verify']!.hold, null);
  }
});

test('work and dependencies preserve blockers, correction deliveries, review waits and missing observations', async (t) => {
  const history = structuredClone(fixture);
  const correction = history.find((record) => record.kind === 'observation' && record.correction); assert.ok(correction?.kind === 'observation' && correction.correction);
  correction.correction.facts = correction.correction.facts.filter((fact) => fact.fact !== 'incorporated');
  const mapping = history.find((record) => record.id === 'mapping-2'); assert.ok(mapping?.kind === 'task_mapping');
  mapping.dependencies.push('unobserved-prerequisite');
  const flow = setup(t, history, { readSnapshot: () => workSnapshot });
  for (const screen of workScreens.slice(0, 2)) {
    const page = await flow.http('GET', screen);
    assert.match(page.body, /Product readiness — selected plan is incomplete or stale/u);
    assert.match(page.body, /Unresolved correction delivery\/incorporation: observation-1/u);
    assert.match(page.body, /Review wait: Independent product review pending/u);
    assert.match(page.body, /Review wait — current product behavior still needs verification/u);
    assert.match(page.body, /Dependency unobserved-prerequisite: Unknown/u);
    assert.match(page.body, /Worker: Unknown · Execution: Unknown · Waiting: Unknown/u);
    assert.match(page.body, /Unknown — omitted: Historical execution and waiting intervals/u);
    assert.match(page.body, /inspect\/feature-1\?revision=1/u);
    assert.match(page.body, /inspect\/task-1\?revision=1/u);
    assert.match(page.body, /inspect\/assignment-1\?revision=1/u);
    assert.doesNotMatch(page.body, /Execution: 0|Waiting: 0/u);
  }
  assert.equal(flow.backend.read().calls.length, 0, 'Read views never query FirstMate');
});

test('focused work retains exact feature, plan-task and assignment links; returned worker is not completion', async (t) => {
  const flow = setup(t, fixture, { readSnapshot: () => workSnapshot });
  const before = flow.store.exportProject('project-1');
  const list = await flow.http('GET', '/projects/project-1/work');
  assert.match(list.body, /href="\/projects\/project-1\/work\/mapping-1"/u);
  const page = await flow.http('GET', '/projects/project-1/work/mapping-1');
  assert.match(page.body, /Worker: returned/u);
  assert.match(page.body, /Execution: 1 h 30 min · Waiting: 15 min/u);
  for (const id of ['feature-1', 'task-1', 'assignment-1']) assert.ok(page.body.includes(`/inspect/${id}?revision=1`));
  assert.match(page.body, /Feature completeness: Incomplete/u);
  assert.doesNotMatch(page.body, /Complete — current product review passed/u);
  assert.deepEqual(flow.store.exportProject('project-1'), before);
  assert.equal((await flow.http('GET', '/projects/project-1/work/missing')).status, 404);
});

test('ready PR age and next action come only from observations and snapshot freshness uses its own timestamp', async (t) => {
  const snapshot = structuredClone(workSnapshot);
  const reference = 'https://example.test/forge/pull/13';
  snapshot.tasks[0]!.ready = [{ kind: 'pr', reference, readySince: '2026-11-12T11:30:00Z', nextAction: 'Independent review against the plan' }];
  const flow = setup(t, fixture, { readSnapshot: () => snapshot, staleAfterMs: 120000 });
  const now = Date.parse('2026-11-12T12:01:00Z');
  const fresh = workView(projectView(flow.store, flow.api.options, now));
  assert.equal(fresh.ready[0]!.age, '31 min');
  assert.equal(fresh.stale, false);
  assert.equal(fresh.snapshot?.provenance, snapshot.provenance);
  const stale = workView(projectView(flow.store, flow.api.options, now + 120001));
  assert.equal(stale.stale, true);
  assert.match(stale.snapshotLabel, /^Stale — FirstMate snapshot taken 2026-11-12T12:00:00Z/u);
  const page = await flow.http('GET', '/projects/project-1/work');
  assert.ok(page.body.includes(`href="${reference}"`));
  assert.match(page.body, /Next action: Independent review against the plan/u);
  assert.match(page.body, /data-stale-after-ms="120000"/u);
  assert.match(page.body, /Stale — FirstMate snapshot taken/u);
  assert.match(page.body, /Ready since: 2026-11-12T11:30:00Z/u);
});

for (const [name, readSnapshot] of [
  ['missing', () => undefined], ['malformed', () => ({ tasks: [] })],
  ['future', () => ({ ...workSnapshot, observedAt: '2099-01-01T00:00:00Z' })],
  ['failure', () => { throw new Error('Unavailable'); }],
] as const) test(`${name} snapshot stays Unknown instead of an empty fleet`, async (t) => {
  const flow = setup(t, fixture, { readSnapshot });
  const page = await flow.http('GET', '/projects/project-1/work');
  assert.match(page.body, /Unknown — .*FirstMate snapshot/u);
  assert.match(page.body, /Unknown — ready-work observations unavailable/u);
  assert.match(page.body, /Worker: Unknown · Execution: Unknown · Waiting: Unknown/u);
  assert.doesNotMatch(page.body, /No ready PR or branch reported/u);
  assert.equal(flow.backend.read().calls.length, 0);
});

test('partial and ambiguous ready observations keep unknown age, action, and worker state', (t) => {
  const snapshot = structuredClone(workSnapshot);
  snapshot.tasks[0]!.ready = [{ kind: 'branch', reference: 'ready-without-timing', readySince: null, nextAction: null }];
  const flow = setup(t, fixture, { readSnapshot: () => snapshot });
  let work = workView(projectView(flow.store, flow.api.options));
  assert.equal(work.ready[0]!.age, 'Unknown');
  assert.equal(work.ready[0]!.nextAction, null);
  snapshot.tasks.push(structuredClone(snapshot.tasks[0]!));
  work = workView(projectView(flow.store, flow.api.options));
  assert.equal(work.ready.length, 0);
  assert.ok(work.rows[0]!.unknowns.includes('Unknown — ambiguous worker observations'));
  assert.equal(work.rows[0]!.observation, undefined);
});

test('lost work mutation output locks every action while preserving blockers and context', async (t) => {
  const flow = setup(t);
  const editor = findEditor((await flow.http('GET', '/projects/project-1/work')).body, 'task', 'set_priority');
  flow.backend.edit((state) => { state.failure = { action: 'update', when: 'after' }; });
  const command = buildEditCommand(editor.context, { priority: '0', reason: 'Change execution priority' }, 'work-lost-key', new Date().toISOString());
  const result = await flow.http('POST', '/canonical', command);
  assert.equal(result.status, 202);
  for (const screen of workScreens) {
    const page = await flow.http('GET', screen);
    assert.match(page.body, /Unknown outcome — reconciliation required/u);
    assert.match(page.body, /Edits unavailable — inspect and reconcile/u);
    assert.match(page.body, /Product readiness/u);
    assert.equal(editors(page.body).some(({ context }) => context.kind === 'task' && context.mapping.id === 'mapping-2'), false);
  }
});

test('observed zero time differs from unknown time and unmapped ready work remains visible', async (t) => {
  const snapshot = structuredClone(workSnapshot);
  snapshot.tasks[0]!.executionMs = 0;
  snapshot.tasks[0]!.waitingMs = null;
  snapshot.tasks.push({ firstMateTaskId: 'unmapped-ready-task', workerState: 'returned', executionMs: null, waitingMs: null,
    reviewWait: null, ready: [{ kind: 'branch', reference: 'unmapped/ready-branch', readySince: null, nextAction: null }] });
  const flow = setup(t, fixture, { readSnapshot: () => snapshot });
  const page = await flow.http('GET', '/projects/project-1/work');
  assert.match(page.body, /Execution: 0 ms · Waiting: Unknown/u);
  assert.match(page.body, /unmapped\/ready-branch/u);
  assert.match(page.body, /unmapped-ready-task — Unknown task mapping/u);
  assert.match(page.body, /Age since ready: Unknown · Ready since: Unknown · Next action: Unknown/u);
});

test('legacy execution mappings stay visible with unknown feature context and plain read-only Scotty navigation', async (t) => {
  const history = structuredClone(fixture);
  const mapping = history.find((record) => record.id === 'mapping-2'); assert.ok(mapping?.kind === 'task_mapping');
  mapping.feature = null; mapping.criteria = []; mapping.detailedPlanTask = null; mapping.legacy = true;
  const flow = setup(t, history, { scottyUrl: 'http://127.0.0.1:3186' });
  const page = await flow.http('GET', '/projects/project-1/dependencies');
  assert.match(page.body, /Feature: Unknown — feature not linked/u);
  assert.match(page.body, /Unknown — detailed plan task unavailable/u);
  assert.match(page.body, /href="http:\/\/127\.0\.0\.1:3186" rel="noreferrer">Scotty execution list \(read-only\)/u);
  assert.equal(flow.backend.read().calls.length, 0);
});

test('snapshot content and ready references stay escaped text rather than executable markup', async (t) => {
  const snapshot = structuredClone(workSnapshot);
  snapshot.provenance = '<script>untrusted()</script>';
  snapshot.tasks[0]!.ready = [{ kind: 'branch', reference: 'javascript:untrusted()', readySince: null, nextAction: '<img src=x onerror=untrusted()>' }];
  const flow = setup(t, fixture, { readSnapshot: () => snapshot });
  const page = await flow.http('GET', '/projects/project-1/work');
  assert.match(page.body, /&lt;script&gt;untrusted\(\)&lt;\/script&gt;/u);
  assert.match(page.body, /&lt;img src=x onerror=untrusted\(\)&gt;/u);
  assert.doesNotMatch(page.body, /href="javascript:|<img|<script>untrusted/u);
});

test('review 1377 finding 1: an undelivered operational correction retains its recipient problem and operation', async (t) => {
  const flow = setup(t, baseline);
  const at = new Date().toISOString();
  const queued = queueCorrection(flow.store, { schemaVersion: 1, id: 'resume-unknown', projectId: 'project-1', issuedAt: at,
    idempotencyKey: 'resume-unknown', command: 'deliver_correction', targetId: 'resume-correction', expectedRevision: 0,
    payload: { affectedRevision: { id: 'feature-1', revision: 1 }, assignment: { id: 'assignment-1', revision: 1 },
      originalCorrection: 'Resume the exact returned attempt after checking its recipient', action: 'resume', sequence: 2, supersedes: [], sourceRefs: [{ uri: 'fixture://resume' }] } });
  const operation = deliverCorrection(flow.store, 'project-1', queued.correction.id, { fmHome: flow.directory,
    sendExecutable: flow.backend.executable, controlExecutable: flow.backend.executable,
    recipients: [{ assignment: { id: 'assignment-1', revision: 1 }, attemptId: 'attempt-1', firstMateTaskId: 'pilot-build', state: 'unknown', observedAt: at }] });
  assert.equal(operation.state, 'pending');
  for (const path of ['/projects/project-1/work', '/projects/project-1/dependencies', '/projects/project-1/work/mapping-1']) {
    const page = await flow.http('GET', path);
    assert.ok(page.body.includes('resume-correction'), 'Unresolved resume must remain visible');
    assert.ok(page.body.includes(`/inspect/${operation.id}?revision=${operation.revision}`));
    assert.match(page.body, /resume.*pending/iu);
    assert.match(page.body, /Unresolved recipient/u);
  }
  assert.equal(flow.backend.read().calls.length, 0, 'Unknown recipient must never invoke the wrapper');
});

test('review 1377 finding 2: native observed dependency edges appear in both directions without becoming managed edits', async (t) => {
  const history = structuredClone(fixture);
  const mapping = history.find((record) => record.id === 'mapping-2'); assert.ok(mapping?.kind === 'task_mapping');
  mapping.dependencies = [];
  const flow = setup(t, history);
  flow.backend.edit((state) => { state.tasks['pilot-build']!.state = 'queued'; state.tasks['pilot-verify']!.deps = [
    { id: 'pilot-build', type: 'blocked-by' }, { id: 'unrelated-parent', type: 'parent' },
  ]; });
  await sendEdit(flow, findEditor((await flow.http('GET', '/projects/project-1/work')).body, 'task', 'set_priority'), { priority: '0' }, 'observe-native-edge');
  const model = workView(projectView(flow.store, flow.api.options));
  assert.ok(model.rows.find((row) => row.mapping.id === 'mapping-2')!.dependencies.some((edge) => edge.id === 'pilot-build'));
  assert.ok(model.rows.find((row) => row.mapping.id === 'mapping-1')!.consumers.some((row) => row.id === 'mapping-2'));
  assert.equal(model.rows.find((row) => row.mapping.id === 'mapping-2')!.dependencies.some((edge) => edge.id === 'unrelated-parent'), false);
  const calls = flow.backend.read().calls.length;
  const page = await flow.http('GET', '/projects/project-1/dependencies');
  assert.match(page.body, /Native observed blocked-by/u);
  const edit = findEditor(page.body, 'task', 'edit_dependencies');
  assert.equal(edit.values.dependencies, '', 'Observed native edges are not copied into managed dependency intent');
  const stale = workView(projectView(flow.store, flow.api.options, Date.now() + 120000));
  assert.ok(stale.rows.find((row) => row.mapping.id === 'mapping-2')!.dependencies.some((edge) => edge.id === 'pilot-build'));
  assert.equal(flow.backend.read().calls.length, calls);
});

test('review 1377 finding 3: priority-only feature revisions retain displayed canonical readiness', async (t) => {
  const flow = setup(t, baseline);
  const target = { id: 'assignment-1', revision: 1 };
  await sendEdit(flow, findEditor((await flow.http('GET', '/')).body, 'feature'), { priority: '4' }, 'work-priority-only');
  const model = workView(projectView(flow.store, flow.api.options));
  assert.deepEqual(model.rows[0]!.reasons.filter((reason) => reason.startsWith('Product readiness')), []);
  const page = await flow.http('GET', '/projects/project-1/work/mapping-1');
  assert.doesNotMatch(page.body, /Product readiness — selected plan is incomplete or stale|Product readiness — mapping names an earlier feature revision/u);
  assert.match(page.body, /<a href="\/projects\/project-1\/inspect\/feature-1\?revision=1">Mapped feature revision <span class="revision">r1<\/span><\/a>/u);
  await sendEdit(flow, findEditor((await flow.http('GET', '/')).body, 'feature'), { priority: '4', outcome: 'Changed product scope needs a new dispatch check' }, 'work-scope-change');
  assert.equal(validateAssignmentForDispatch(flow.store.history('project-1'), target).ok, false);
  assert.ok(workView(projectView(flow.store, flow.api.options)).rows[0]!.reasons.some((reason) => reason.startsWith('Product readiness')));
});

test('review 1377 finding 4: every rendered snapshot label ages together', async (t) => {
  const snapshot = structuredClone(workSnapshot);
  snapshot.observedAt = new Date().toISOString();
  const flow = setup(t, fixture, { readSnapshot: () => snapshot, staleAfterMs: 120000 });
  const page = await flow.http('GET', '/projects/project-1/work');
  const labels = [...page.body.matchAll(/<p([^>]*)>(Observed — FirstMate snapshot taken[^<]*)<\/p>/gu)].map((match) => ({
    textContent: match[2]!, dataset: { snapshotAt: match[1]!.match(/data-snapshot-at="([^"]+)"/u)?.[1],
      staleAfterMs: match[1]!.match(/data-stale-after-ms="([^"]+)"/u)?.[1] },
  }));
  assert.equal(labels.length, 2, 'Summary and ready-work card each have a freshness label');
  assert.ok(labels.every((label) => label.dataset.snapshotAt === snapshot.observedAt && label.dataset.staleAfterMs === '120000'));
  let now = Date.parse(snapshot.observedAt);
  let tick = () => {};
  const draft = { querySelector: () => ({}), addEventListener() {} };
  const pageState = { textContent: '' };
  const source = readFileSync(new URL('../src/ui-client.js', import.meta.url), 'utf8').replace(/^import .*;\n/gmu, '');
  runInNewContext(source, { buildEditCommand,
    document: { querySelector: (selector: string) => selector === 'main' ? { dataset: { staleAfterMs: '120000' } } : pageState,
      querySelectorAll: (selector: string) => selector === '[data-snapshot-at]' ? labels : [draft] },
    Date: class extends Date { static now() { return now; } }, window: { addEventListener() {} }, setInterval(callback: () => void) { tick = callback; },
  });
  now += 120001; tick();
  assert.ok(labels.every((label) => label.textContent.startsWith('Stale — FirstMate snapshot taken')));
});

test('review 1377 finding 5: standalone maintenance keeps its objective and exact source context', async (t) => {
  const history = structuredClone(baseline.filter((record) => ['project-1', 'request-1', 'design-1', 'plan-1', 'task-1', 'mapping-1', 'assignment-1'].includes(record.id)));
  for (const record of history) {
    if (record.kind === 'request') record.interpretationRefs = [];
    if (['design_revision', 'implementation_plan_revision', 'detailed_plan_task', 'task_mapping', 'assignment'].includes(record.kind) && 'feature' in record) record.feature = null;
    if (record.kind === 'detailed_plan_task') { record.criteria = []; record.maintenanceObjective = 'Remove the obsolete cache without changing product behavior'; }
    if (record.kind === 'task_mapping' || record.kind === 'assignment') record.criteria = [];
  }
  const flow = setup(t, history);
  assert.equal(validateAssignmentForDispatch(flow.store.history('project-1'), { id: 'assignment-1', revision: 1 }).ok, true);
  for (const path of ['/projects/project-1/work', '/projects/project-1/dependencies', '/projects/project-1/work/mapping-1']) {
    const page = await flow.http('GET', path);
    assert.match(page.body, /Standalone maintenance — no feature by design/u);
    assert.match(page.body, /Remove the obsolete cache without changing product behavior/u);
    for (const id of ['request-1', 'design-1', 'plan-1', 'task-1', 'assignment-1']) assert.ok(page.body.includes(`/inspect/${id}?revision=1`), `Missing exact ${id} context`);
    assert.doesNotMatch(page.body, /Unknown — feature context unavailable|Feature: Unknown|Original requests: Unknown/u);
  }
});

for (const route of ['/', '/projects/project-1/decisions']) test(`BUILD-14 answers a material question through the rendered form at ${route}`, async (t) => {
  const flow = setup(t);
  const page = await flow.http('GET', route);
  assert.equal(page.status, 200);
  assert.match(page.body, /Which second connected system/);
  assert.match(page.body, /Criteria:/);
  assert.match(page.body, /Related work:/);
  const before = flow.store.exportProject('project-1');
  const editor = findEditor(page.body, 'answer');
  const answer = 'Use the second CRM with independent authentication.';
  await sendEdit(flow, editor, { answer }, 'answer-material');
  const decision = flow.store.get('project-1', 'decision-open'); assert.ok(decision?.kind === 'decision_change');
  assert.equal(decision.answer?.text, answer);
  assert.equal(decision.choice?.state, 'resolved');
  assert.equal(decision.revision, 2);
  assert.deepEqual(flow.store.get('project-1', 'decision-open', 1), before.history.find((record) => record.id === 'decision-open'));
  for (const record of before.history.filter((record) => record.kind !== 'decision_change')) {
    assert.deepEqual(flow.store.get('project-1', record.id, record.revision), record);
  }
  assert.equal(flow.backend.read().calls.length, 0);
  const refreshed = await flow.http('GET', '/projects/project-1/decisions');
  assert.match(refreshed.body, /No material product questions need input/);
  assert.match(refreshed.body, new RegExp(answer));
});

test('BUILD-14 existing answers reuse exact product context with provenance and reject stale or conflicting sources', async (t) => {
  const history = structuredClone(fixture);
  const question = history.find((record) => record.id === 'decision-open'); assert.ok(question?.kind === 'decision_change');
  const answered = { ...question, id: 'existing-answer', choice: { kind: 'product' as const, state: 'resolved' as const }, disposition: 'selected' as const,
    answer: { text: 'Use CRM B.' } };
  history.push(answered, { ...answered, id: 'other-scope', affectedRecords: [{ id: 'request-1', revision: 1 }], answer: { text: 'Wrong scope.' } });
  const flow = setup(t, history);
  const page = await flow.http('GET', '/projects/project-1/decisions');
  assert.match(page.body, /Existing answer available/);
  const editor = editors(page.body).find(({ context }) => context.kind === 'answer' && context.reuse); assert.ok(editor);
  await sendEdit(flow, editor, {}, 'reuse-answer');
  const saved = flow.store.get('project-1', question.id); assert.ok(saved?.kind === 'decision_change');
  assert.deepEqual(saved.answer, { text: 'Use CRM B.', reusedFrom: { id: answered.id, revision: 1 } });
  assert.equal(flow.backend.read().calls.length, 0);
  const conflictFlow = setup(t, [...history, { ...answered, id: 'disagreeing-answer', answer: { text: 'Use CRM C.' } }]);
  const conflict = await conflictFlow.http('GET', '/projects/project-1/decisions');
  assert.match(conflict.body, /matching previous answers disagree/);
  assert.equal(editors(conflict.body).filter(({ context }) => context.kind === 'answer' && context.reuse).length, 0);
  const forged = buildEditCommand({ kind: 'answer', decision: question, reuse: history.find((record) => record.id === 'other-scope') as typeof answered }, { reason: 'Attempt mismatched reuse' }, 'wrong-context', new Date().toISOString());
  const rejected = await conflictFlow.http('POST', '/canonical', forged);
  assert.equal(rejected.status, 409);
  const staleFlow = setup(t, history);
  const { answer: _answer, ...source } = answered;
  const updated = await staleFlow.http('POST', '/canonical', { schemaVersion: 1, id: 'source-update', projectId: 'project-1',
    issuedAt: new Date().toISOString(), idempotencyKey: 'source-update', command: 'record_decision_suggestion', targetId: source.id, expectedRevision: 1,
    payload: { decision: { ...source, revision: 2, rationale: 'Use a different representative system.' } } });
  assert.equal(updated.status, 200, updated.body);
  const staleReuse = buildEditCommand(editor.context, { reason: 'Reuse displayed answer' }, 'stale-source', new Date().toISOString());
  assert.equal((await staleFlow.http('POST', '/canonical', staleReuse)).status, 409);
});

test('BUILD-14 technical questions have no answer or approval controls and reads never mutate', async (t) => {
  const history = structuredClone(fixture);
  const product = history.find((record) => record.id === 'decision-open'); assert.ok(product?.kind === 'decision_change');
  history.push({ ...product, id: 'technical-open', questionOrChange: 'Choose an internal implementation helper', choice: { kind: 'technical', state: 'open' } });
  const flow = setup(t, history);
  const before = flow.store.exportProject('project-1');
  const page = await flow.http('GET', '/projects/project-1/decisions');
  const contexts = editors(page.body).map((editor) => editor.context);
  assert.ok(contexts.every((context) => context.kind === 'answer' && context.decision.choice?.kind === 'product'));
  assert.doesNotMatch(page.body, /<button[^>]*>[^<]*(approve|dispatch|run implementation)/iu);
  assert.match(page.body, /implementation question, handled with its work/);
  await flow.http('GET', '/projects/project-1/learning');
  assert.deepEqual(flow.store.exportProject('project-1'), before);
  const technical = history.find((record) => record.id === 'technical-open'); assert.ok(technical?.kind === 'decision_change');
  assert.throws(() => buildEditCommand({ kind: 'answer', decision: technical }, { reason: 'Routine work', answer: 'Approved' }, 'approve', new Date().toISOString()), /Only an open product question/);
});

test('BUILD-14 learning shows evidence, scope, replacement history and unresolved conflicts', async (t) => {
  const flow = setup(t);
  const page = await flow.http('GET', '/projects/project-1/learning');
  assert.equal(page.status, 200);
  assert.match(page.body, /Observation inbox/);
  assert.match(page.body, /Synthetic correction captured/);
  assert.match(page.body, /Project · topic/);
  assert.match(page.body, /Two sources disagree/);
  assert.match(page.body, /Superseded/);
  assert.match(page.body, /Replaced by: <a href="\/projects\/project-1\/inspect\/guidance-current\?revision=1/);
  assert.match(page.body, /no consolidation schedule supplied/);
  assert.match(page.body, /fixture-learning-window/);
  assert.match(page.body, /Before: <a href="\/projects\/project-1\/inspect\/guidance-old/);
  const historical = await flow.http('GET', '/projects/project-1/inspect/guidance-old?revision=1');
  assert.equal(historical.status, 200);
  assert.match(historical.body, /Write a new general rule after every correction/);
  assert.match(historical.body, /Superseded guidance/);
  assert.match(historical.body, /Replaced by: <a href="\/projects\/project-1\/inspect\/guidance-current/);
});

test('BUILD-14 explicit standing instruction updates canonical guidance through BUILD-11 with replay and stale-scope conflict', async (t) => {
  const flow = setup(t);
  const page = await flow.http('GET', '/projects/project-1/learning');
  const editor = findEditor(page.body, 'standing-instruction'); assert.ok(editor.context.kind === 'standing-instruction');
  const identity = editor.context.identities.find((identity) => identity.scope.kind === 'project' && identity.topic === 'rule-writing'); assert.ok(identity);
  const values = { identity: JSON.stringify(identity), instruction: 'Consolidate inferred lessons once daily.', evidenceUri: 'fixture:explicit-user-instruction', evidenceRevision: 'transcript-2', reason: 'Explicit user standing instruction' };
  const command = buildEditCommand(editor.context, values, 'standing', new Date().toISOString());
  const first = await flow.http('POST', '/canonical', command); assert.equal(first.status, 200, first.body);
  const snapshot = flow.store.exportProject('project-1');
  assert.deepEqual((await flow.http('POST', '/canonical', command)).json(), first.json());
  assert.deepEqual(flow.store.exportProject('project-1'), snapshot);
  const guidance = flow.store.get('project-1', 'ui-standing:guidance'); assert.ok(guidance?.kind === 'guidance_revision');
  assert.equal(guidance.text, values.instruction);
  assert.deepEqual(guidance.supersededGuidance, [{ id: 'guidance-current', revision: 1 }]);
  assert.equal(guidance.learning?.authority, 'explicit');
  const stale = await flow.http('POST', '/canonical', buildEditCommand(editor.context, values, 'stale-standing', new Date().toISOString()));
  assert.equal(stale.status, 409, stale.body);
  const changed = structuredClone(command); assert.ok(changed.command === 'capture_consolidate_learning' && changed.payload.action === 'capture');
  changed.payload.observation.finding = 'Different standing instruction';
  assert.equal((await flow.http('POST', '/canonical', changed)).status, 400);
  assert.equal(flow.backend.read().calls.length, 0);
  const current = (await flow.http('GET', '/projects/project-1/learning')).body;
  assert.match(current, /ui-standing%3Aguidance\?revision=1/);
});

test('BUILD-14 last-run diff comes from real consolidation receipts with a fake agent; schedule preview never runs it', async (t) => {
  const flow = setup(t);
  const executable = join(flow.directory, 'fake-learning.mjs');
  const fake = new URL('../../fixtures/fake-learning-agent.mjs', import.meta.url);
  writeFileSync(executable, `#!/usr/bin/env node\nawait import(${JSON.stringify(fake.href)});\n`, { mode: 0o755 });
  const config = { ...structuredClone(fakeJudge), executables: { codex: executable, claude: executable } };
  consolidateLearning(flow.store, { projectId: 'project-1', id: 'ui-consolidation-run', idempotencyKey: 'ui-consolidation-run',
    issuedAt: '2026-11-12T10:00:00Z', scheduledWindowId: 'fixture-window', scheduledFor: '2026-11-12T07:00:00Z', scheduleDigest: 'fixture-schedule', timezone: 'Asia/Jerusalem' }, config);
  const page = await flow.http('GET', '/projects/project-1/learning');
  assert.match(page.body, /fixture-window/);
  assert.match(page.body, /Guidance written by this run/);
  assert.match(page.body, /After: <a href="\/projects\/project-1\/inspect\/ui-consolidation-run/);
  assert.doesNotMatch(page.body, /this imported run has no mutation receipt/);
  const schedule = { id: 'daily', projectId: 'project-1', timezone: 'Asia/Jerusalem', hours: [9, 21], startsAt: '2026-11-01T00:00:00Z' };
  assert.equal(nextLearningWindow(schedule, '2026-11-12T08:30:00Z')?.scheduledFor, '2026-11-12T19:00:00.000Z');
  const api = new ToolkitApi(flow.store, undefined, { projectId: 'project-1', learningSchedule: schedule });
  const before = flow.store.exportProject('project-1');
  assert.match(String(api.handle('GET', '/projects/project-1/learning').body), /Configured windows/);
  assert.deepEqual(flow.store.exportProject('project-1'), before);
});

test('BUILD-14 imported answer provenance and product classification remain validated', () => {
  const history = structuredClone(fixture);
  const question = history.find((record) => record.id === 'decision-open'); assert.ok(question?.kind === 'decision_change');
  question.choice = { kind: 'product', state: 'resolved' }; question.disposition = 'selected';
  question.answer = { text: 'Use CRM B.', reusedFrom: { id: 'missing-answer', revision: 1 } };
  const missing = validateRecords(history); assert.equal(missing.ok, false); assert.ok(!missing.ok && missing.issues.some((issue) => issue.path === 'answer.reusedFrom'));
  delete question.answer.reusedFrom;
  question.choice.kind = 'technical';
  const technical = validateRecords(history); assert.equal(technical.ok, false); assert.ok(!technical.ok && technical.issues.some((issue) => issue.code === 'invalid_product_answer'));
});

test('BUILD-14 next consolidation preview respects future start seconds and DST duplicate windows', () => {
  const base = { id: 'next', projectId: 'project-1', timezone: 'UTC', hours: [9], startsAt: '2027-01-01T09:00:30Z' };
  assert.equal(nextLearningWindow(base, '2026-11-12T08:30:00Z')?.scheduledFor, '2027-01-02T09:00:00.000Z');
  const fold = { ...base, timezone: 'America/New_York', hours: [1], startsAt: '2026-01-01T00:00:00Z' };
  assert.equal(nextLearningWindow(fold, '2026-11-01T05:30:00Z')?.scheduledFor, '2026-11-02T06:00:00.000Z');
});

test('review 1384 finding 1: answering an older feature question retains exact criteria and request context after an edit', async (t) => {
  const flow = setup(t);
  const feature = flow.store.get('project-1', 'feature-1', 1); assert.ok(feature?.kind === 'feature_revision');
  const criterion = flow.store.get('project-1', feature.criteria[0]!.id, feature.criteria[0]!.revision); assert.ok(criterion?.kind === 'criterion');
  const request = flow.store.get('project-1', feature.sourceRequests[0]!.id, feature.sourceRequests[0]!.revision); assert.ok(request?.kind === 'request');
  const editPage = await flow.http('GET', '/projects/project-1/features/feature-1');
  await sendEdit(flow, findEditor(editPage.body, 'criterion'), { expectedBehavior: 'Changed criterion that belongs only to feature revision two.' }, 'revision-context');
  const page = await flow.http('GET', '/projects/project-1/decisions');
  const question = page.body.match(/<article class="question"[\s\S]*?<\/article>/u)?.[0]; assert.ok(question);
  const primary = question.split('Current feature context')[0]!;
  assert.ok(primary.includes(criterion.expectedBehavior), 'Show the criterion wording referenced by the affected feature revision');
  assert.ok(primary.includes(`/inspect/${criterion.id}?revision=${criterion.revision}`));
  assert.ok(primary.includes(`/inspect/${feature.id}?revision=${feature.revision}`));
  assert.ok(primary.includes(request.originalText));
  assert.ok(primary.includes(`/inspect/${request.id}?revision=${request.revision}`));
  assert.ok(!primary.includes('Changed criterion that belongs only to feature revision two.'));
  assert.match(question, /Current feature context/);
  assert.match(question, /feature-1\?revision=2/);
  const answerEditor = findEditor(page.body, 'answer'); assert.ok(answerEditor.context.kind === 'answer');
  assert.deepEqual(answerEditor.context.decision.affectedRecords, [{ id: feature.id, revision: feature.revision }]);
  await sendEdit(flow, answerEditor, { answer: 'Answer for the original product scope.' }, 'historical-answer');
});

test('review 1384 finding 2: classified captures normalize omitted optional arrays before comparison and persistence', async (t) => {
  const flow = setup(t);
  const editor = findEditor((await flow.http('GET', '/projects/project-1/learning')).body, 'standing-instruction');
  assert.ok(editor.context.kind === 'standing-instruction');
  for (const inputKind of ['standing_instruction', 'inferred', 'operational'] as const) {
    for (const omitted of ['legacy', 'supersedes', 'both']) {
      const key = `omitted-${inputKind}-${omitted}`;
      const command = buildEditCommand(editor.context, { identity: JSON.stringify(editor.context.identities[0]), topic: key,
        instruction: 'Preserve this classified capture.', reason: 'Evidence from the user', evidenceUri: 'fixture:classified', evidenceRevision: '1' }, key, new Date().toISOString());
      assert.ok(command.command === 'capture_consolidate_learning' && command.payload.action === 'capture' && command.payload.observation.learning);
      command.payload.observation.learning.inputKind = inputKind;
      command.payload.observation.consolidationState = inputKind === 'standing_instruction' ? 'consolidated' : 'pending';
      const explicit = structuredClone(command);
      if (omitted !== 'supersedes') delete command.payload.observation.legacySections;
      if (omitted !== 'legacy') delete command.payload.supersedes;
      const response = await flow.http('POST', '/canonical', command);
      assert.equal(response.status, 200, `${inputKind}/${omitted}: ${response.body}`);
      assert.deepEqual((await flow.http('POST', '/canonical', explicit)).json(), response.json());
      const receipt = flow.store.receipt('project-1', key); assert.ok(receipt?.command.command === 'capture_consolidate_learning' && receipt.command.payload.action === 'capture');
      assert.deepEqual(receipt.command.payload.observation.legacySections, []);
      assert.deepEqual(receipt.command.payload.supersedes, []);
    }
  }
});

test('review 1384 finding 3: reuse requires explicit answer text and never substitutes legacy rationale or instruction', async (t) => {
  const history = structuredClone(fixture);
  const question = history.find((record) => record.id === 'decision-open'); assert.ok(question?.kind === 'decision_change');
  const legacy = { ...question, id: 'legacy-decision', disposition: 'selected' as const, choice: { kind: 'product' as const, state: 'resolved' as const },
    originalInstruction: 'Select the system named in the product instruction.', rationale: 'This rationale explains the tradeoff; it is not an answer.' };
  history.push(legacy);
  const flow = setup(t, history);
  const page = await flow.http('GET', '/projects/project-1/decisions');
  assert.equal(projectView(flow.store, { projectId: 'project-1' }).questions[0]!.answers.length, 0);
  assert.match(page.body, /Legacy decision — no explicit answer recorded/);
  assert.ok(page.body.includes(legacy.originalInstruction));
  assert.ok(page.body.includes(legacy.rationale));
  assert.throws(() => buildEditCommand({ kind: 'answer', decision: question, reuse: legacy }, { reason: 'Reuse source' }, 'legacy-reuse-builder', new Date().toISOString()), /explicit answer/);
  const forged = buildEditCommand({ kind: 'answer', decision: question }, { answer: legacy.rationale, reason: 'Attempt legacy fallback' }, 'legacy-reuse-canonical', new Date().toISOString());
  assert.ok(forged.command === 'record_decision_suggestion' && forged.payload.decision.answer);
  forged.payload.decision.answer.reusedFrom = { id: legacy.id, revision: legacy.revision };
  assert.equal((await flow.http('POST', '/canonical', forged)).status, 409);
  const imported = validateRecords([...history, { ...question, id: 'invalid-legacy-reuse', disposition: 'selected', choice: { kind: 'product', state: 'resolved' },
    answer: { text: legacy.rationale, reusedFrom: { id: legacy.id, revision: legacy.revision } } }]);
  assert.ok(!imported.ok && imported.issues.some((issue) => issue.code === 'invalid_answer_reuse'));
  const explicit = { ...legacy, id: 'explicit-answer', answer: { text: 'Use CRM Z for the second-system acceptance.' } };
  const explicitFlow = setup(t, [...history, explicit]);
  const explicitPage = await explicitFlow.http('GET', '/projects/project-1/decisions');
  const reuse = editors(explicitPage.body).find(({ context }) => context.kind === 'answer' && context.reuse); assert.ok(reuse);
  await sendEdit(explicitFlow, reuse, {}, 'explicit-reuse');
  const result = explicitFlow.store.get('project-1', question.id); assert.ok(result?.kind === 'decision_change');
  assert.equal(result.answer?.text, explicit.answer.text);
});

test('review 1384 finding 4: displayed current guidance agrees with canonical worker scope resolution', async (t) => {
  const history = structuredClone(fixture);
  const template = history.find((record) => record.id === 'guidance-current'); assert.ok(template?.kind === 'guidance_revision');
  const { learning: _learning, ...legacy } = template;
  history.push(
    { ...legacy, id: 'opaque-legacy', text: 'Unclassifiable legacy guidance', supersededGuidance: [], scope: [{ uri: 'fixture:unclassified' }] },
    { ...legacy, id: 'project-legacy', text: 'Resolved legacy project guidance', supersededGuidance: [], scope: [{ uri: 'factory:project/project-1', record: { id: 'project-1', revision: 1 } }] },
    { ...legacy, id: 'feature-legacy', text: 'Resolved legacy feature guidance', supersededGuidance: [], scope: [{ uri: 'factory:feature/feature-1', record: { id: 'feature-1', revision: 1 } }] },
    { ...legacy, id: 'mixed-legacy', text: 'Partially unclassified legacy guidance', supersededGuidance: [], scope: [{ uri: 'factory:project/project-1', record: { id: 'project-1', revision: 1 } }, { uri: 'fixture:unclassified' }] },
    { ...template, id: 'project-default', text: 'Project default with a feature override', supersededGuidance: [], learning: { scope: { kind: 'project' }, topic: 'review-scope', authority: 'inferred' } },
    { ...template, id: 'feature-override', text: 'Explicit feature override', supersededGuidance: [], learning: { scope: { kind: 'feature', featureId: 'feature-1' }, topic: 'review-scope', authority: 'explicit' } },
  );
  const flow = setup(t, history);
  const view = projectView(flow.store, { projectId: 'project-1' });
  const expected = new Set([undefined, ...view.features.map((item) => item.feature.id)].flatMap((featureId) => guidanceForContext(history, featureId).map((record) => record.id)));
  assert.deepEqual(new Set(view.learning.active.map((record) => record.id)), expected);
  for (const item of view.learning.guidance) assert.equal(item.active, expected.has(item.record.id));
  assert.deepEqual(view.learning.guidance.find((item) => item.record.id === 'project-default')?.contexts, ['Project/default context']);
  assert.deepEqual(view.learning.guidance.find((item) => item.record.id === 'feature-override')?.contexts, ['Feature feature-1']);
  const page = await flow.http('GET', '/projects/project-1/learning');
  const current = page.body.split('<h2>Current guidance</h2>')[1]!.split('<h3>Revision and supersession history</h3>')[0]!;
  assert.ok(!current.includes('Unclassifiable legacy guidance'));
  const visible = current.split('<form data-editor>')[0]!;
  assert.match(visible, /Resolved legacy project guidance/u);
  assert.match(visible, /Resolved legacy feature guidance/u);
  const opaque = await flow.http('GET', '/projects/project-1/inspect/opaque-legacy?revision=1');
  assert.match(opaque.body, /Inactive guidance/);
});

// Reuse is selected explicitly for r2 while artifact contents still originate at r1.
function reusedEditorHistory(mode: 'split' | 'renamed' | 'request') {
  const history = structuredClone(fixture);
  const feature = history.find(r => r.kind === 'feature_revision'); assert.ok(feature?.kind === 'feature_revision');
  const original = history.find(r => r.id === feature.criteria[0]!.id); assert.ok(original?.kind === 'criterion');
  const current = { ...feature, revision: 2, previousRevision: 1, updatedAt: '2026-11-12T12:00:00Z',
    changeReason: 'Checked reuse for revised request', criteria: [...feature.criteria], sourceRequests: [...feature.sourceRequests] };
  if (mode !== 'request') {
    const added = { ...original, id: 'criterion-reused-target', expectedBehavior: 'Additional behavior from the checked mapping' };
    history.push(added);
    current.criteria = mode === 'split' ? [...current.criteria, { id: added.id, revision: 1 }] :
      current.criteria.map(c => c.id === original.id ? { id: added.id, revision: 1 } : c);
  } else {
    const request = history.find(r => r.kind === 'request'); assert.ok(request?.kind === 'request');
    history.push({ ...request, id: 'request-additional', clientRequestId: 'additional-request', interpretationRefs: [], dispositionRefs: [], disposition: 'unclassified' });
    current.sourceRequests.push({ id: 'request-additional', revision: 1 });
  }
  if (mode === 'renamed') {
    const template = history.find(r => r.kind === 'decision_change'); assert.ok(template?.kind === 'decision_change');
    const decision = { ...template, id: 'reuse-scope-decision', disposition: 'selected' as const, choice: undefined,
      affectedRecords: [{ id: current.id, revision: 2 }], scopeChanges: [{ featureId: current.id, fromRevision: 1, toRevision: 2, criterionId: original.id, action: 'remove' as const }] };
    history.push(decision); current.decisions = [...current.decisions, { id: decision.id, revision: 1 }];
  }
  const sourcePlan = history.find(r => r.kind === 'implementation_plan_revision'); assert.ok(sourcePlan?.kind === 'implementation_plan_revision');
  sourcePlan.dependencies = [{ consumerTaskId: 'task-2', prerequisiteTaskId: 'task-1', reason: 'Acceptance needs common behavior', needs: { kind: 'criterion', criterion: feature.criteria[0]! } }];
  history.push(current);
  const understanding = history.find(r => r.kind === 'understanding_revision'); assert.ok(understanding?.kind === 'understanding_revision');
  history.push({ ...understanding, revision: 2, feature: { id: current.id, revision: 2 }, criteria: current.criteria, sourceRequests: current.sourceRequests });
  for (const stage of history.filter(r => r.kind === 'stage_revision')) {
    const artifact = history.find(r => r.id === stage.artifact.id && r.revision === stage.artifact.revision)!;
    const design = history.find(r => r.kind === 'design_revision'); assert.ok(design?.kind === 'design_revision');
    const criterionMap = current.criteria.map(c => ({ current: c,
      existing: c.id === 'criterion-reused-target' ? feature.criteria[0]! : c }));
    history.push({ ...stage, revision: 2, updatedAt: current.updatedAt, feature: { id: current.id, revision: 2 },
      criteria: current.criteria, sourceRequests: current.sourceRequests,
      previousStage: stage.previousStage ? { ...stage.previousStage, revision: 2 } : undefined,
      artifact: stage.stage === 'understand' ? { ...stage.artifact, revision: 2 } : stage.artifact,
      ...(stage.stage === 'design' || stage.stage === 'plan' ? { reuse: {
        check: { ...design.sourceComparison, sourceRefs: [...current.sourceRequests, artifact].map(r => ({
          uri: `factory:record/${r.id}@${r.revision}`, record: { id: r.id, revision: r.revision } })) }, criterionMap } } : {}) });
  }
  return history;
}
for (const mode of ['split', 'renamed', 'request'] as const) for (const kind of ['design', 'plan', 'plan-task'] as const)
test(`checked reuse ${mode} survives ${kind} save${mode === 'renamed' ? ' after priority revision' : ''}`, async t => {
  const flow = setup(t, reusedEditorHistory(mode));
  if (mode === 'renamed') await sendEdit(flow, findEditor((await flow.http('GET', '/')).body, 'feature'), { priority: '4' }, 'reuse-priority');
  const page = await flow.http('GET', '/projects/project-1/features/feature-1');
  const { first } = await sendEdit(flow, findEditor(page.body, kind), {}, `reuse-${mode}-${kind}`);
  const task = flow.store.get('project-1', 'task-1'); assert.ok(task?.kind === 'detailed_plan_task');
  const plan = flow.store.get('project-1', 'plan-1'); assert.ok(plan?.kind === 'implementation_plan_revision');
  const feature = flow.store.get('project-1', 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  if (mode !== 'request') {
    const expected = mode === 'split' ? [{ id: 'criterion-general', revision: 1 }, { id: 'criterion-reused-target', revision: 1 }] : [{ id: 'criterion-reused-target', revision: 1 }];
    assert.deepEqual(task.criteria, [...expected, { id: 'criterion-second-system', revision: 1 }]);
    assert.deepEqual(plan.workflow?.slices[0]?.criteria, task.criteria);
    assert.deepEqual(plan.dependencies.filter(d => d.needs.kind === 'criterion').map(d => d.needs.kind === 'criterion' && d.needs.criterion), expected);
  }
  const design = flow.store.get('project-1', 'design-1'); assert.ok(design?.kind === 'design_revision');
  assert.ok(feature.sourceRequests.every(r => design.sourceComparison.sourceRefs.some(s => s.record?.id === r.id && s.record.revision === r.revision)));
  // A resumed draft is already translated; do not apply the old split twice.
  await sendEdit(flow, findEditor((await flow.http('GET', first.json().resumeUrl)).body, kind), {}, `resume-${mode}-${kind}`);
  const resumed = flow.store.get('project-1', 'task-1'); assert.ok(resumed?.kind === 'detailed_plan_task');
  assert.deepEqual(resumed.criteria, task.criteria);
  const resumedPlan = flow.store.get('project-1', 'plan-1'); assert.ok(resumedPlan?.kind === 'implementation_plan_revision');
  assert.deepEqual(resumedPlan.dependencies, plan.dependencies);
});

for (const mode of ['split', 'renamed'] as const) test(`non-ready Detail retains checked ${mode} slice criteria through save and resume`, async t => {
  const history = reusedEditorHistory(mode);
  const plan = history.find(r => r.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
  const detail = history.find(r => r.kind === 'stage_revision' && r.stage === 'detail' && r.revision === 2);
  assert.ok(detail?.kind === 'stage_revision');
  const flow = setup(t, history);
  recordStage(flow.store, { idempotencyKey: `refine-${mode}`, expectedRevision: 2, issuedAt: detail.updatedAt,
    stage: { ...detail, revision: 3, artifact: { id: plan.id, revision: 2 } },
    records: [{ ...plan, revision: 2, updatedAt: detail.updatedAt, feature: detail.feature, dependencies: [],
      workflow: { ...plan.workflow!, retainedTasks: plan.deliverySequence.map(task => ({ task, reason: 'Retain checked task detail' })) } }] });
  const refined = flow.store.get('project-1', plan.id); assert.ok(refined?.kind === 'implementation_plan_revision');
  assert.equal(refined.readiness.ready, false);
  assert.deepEqual(refined.workflow?.slices[0]?.criteriaProvenance,
    { feature: plan.feature, criteria: plan.workflow!.slices[0]!.criteria });
  assert.equal(refined.workflow?.slices[0]?.criteriaFeature, undefined);
  const expected = mode === 'split' ? [{ id: 'criterion-general', revision: 1 }, { id: 'criterion-reused-target', revision: 1 },
    { id: 'criterion-second-system', revision: 1 }] : [{ id: 'criterion-reused-target', revision: 1 }, { id: 'criterion-second-system', revision: 1 }];
  let path = '/projects/project-1/features/feature-1';
  for (const save of ['initial', 'resume']) {
    const editor = findEditor((await flow.http('GET', path)).body, 'plan'); assert.ok(editor.context.kind === 'plan');
    assert.deepEqual(editor.context.tasks[0]?.criteria, expected);
    assert.deepEqual(editor.context.plan.workflow?.slices[0]?.criteria, expected);
    const { first } = await sendEdit(flow, editor, {}, `detail-${mode}-${save}`);
    const saved = flow.store.get('project-1', plan.id); assert.ok(saved?.kind === 'implementation_plan_revision');
    assert.deepEqual(saved.workflow?.slices[0]?.criteria, expected);
    assert.deepEqual(saved.workflow?.slices[0]?.criteriaProvenance, { feature: detail.feature, criteria: expected });
    assert.equal(saved.workflow?.slices[0]?.criteriaFeature, undefined);
    path = first.json().resumeUrl;
  }
});

test('resolved question history links to the saved answer instead of a missing open-question anchor', async t => {
  const flow = setup(t);
  const page = await flow.http('GET', '/projects/project-1/decisions');
  const editor = findEditor(page.body, 'answer'); assert.ok(editor.context.kind === 'answer');
  await sendEdit(flow, editor, { answer: 'Saved answer for this question' }, 'resolved-question-link');
  const historical = await flow.http('GET', `/projects/project-1/inspect/${editor.context.decision.id}?revision=1`);
  assert.doesNotMatch(historical.body, /Answer in context/u);
  assert.match(historical.body, new RegExp(`href="/projects/project-1/inspect/${editor.context.decision.id}\\?revision=2">Saved answer`));
});

test('criterion-only question keeps separately labeled current context when its owner revision is ambiguous', async t => {
  const history = structuredClone(fixture);
  const question = history.find(r => r.kind === 'decision_change' && r.choice?.state === 'open'); assert.ok(question?.kind === 'decision_change');
  question.affectedRecords = [{ id: 'criterion-general', revision: 1 }];
  const flow = setup(t, history);
  await sendEdit(flow, findEditor((await flow.http('GET', '/')).body, 'feature'), { priority: '4' }, 'ambiguous-owner');
  const page = await flow.http('GET', '/projects/project-1/decisions');
  const article = page.body.match(/<article class="question"[\s\S]*?<\/article>/u)?.[0]; assert.ok(article);
  assert.doesNotMatch(article, /Affected feature revision:/u);
  assert.match(article, /Current feature context/u);
  assert.match(article, /href="\/projects\/project-1\/inspect\/feature-1\?revision=2"/u);
  assert.match(article, /href="\/projects\/project-1\/features\/feature-1"/u);
  assert.match(article, /Related current work:[\s\S]*inspect\/mapping-1/u);
});

test('each affected criterion resolves its own unique feature snapshot', async t => {
  const history = structuredClone(fixture);
  const question = history.find(r => r.kind === 'decision_change' && r.choice?.state === 'open'); assert.ok(question?.kind === 'decision_change');
  question.affectedRecords = [{ id: 'criterion-general', revision: 1 }, { id: 'criterion-second-system', revision: 2 }];
  const feature = history.find(r => r.kind === 'feature_revision'); assert.ok(feature?.kind === 'feature_revision');
  const criteria = history.filter(r => r.kind === 'criterion');
  history.push(...criteria.map(c => ({ ...c, revision: 2 })), { ...feature, revision: 2, previousRevision: 1,
    changeReason: 'Revised both criteria', criteria: feature.criteria.map(c => ({ ...c, revision: 2 })) });
  const flow = setup(t, history);
  const { context, currentContext } = projectView(flow.store, { projectId: 'project-1' }).questions[0]!;
  assert.deepEqual(context.map(item => item.feature.revision), [1, 2]);
  assert.ok(context.some(item => item.criteria.some(c => c.target.id === 'criterion-second-system' && c.target.revision === 2)));
  assert.deepEqual(currentContext, []);
  const page = await flow.http('GET', '/projects/project-1/decisions');
  const article = page.body.match(/<article class="question"[\s\S]*?<\/article>/u)?.[0]; assert.ok(article);
  assert.match(article, /Affected feature revision: <a href="\/projects\/project-1\/inspect\/feature-1\?revision=2"/u);
  assert.doesNotMatch(article, /Current feature context/u);
});

test('toolkit guard edges retain ownership and observation independently of editable prerequisites', async t => {
  const flow = setup(t);
  flow.backend.edit(state => {
    state.tasks['pilot-verify']!.hold = { reason: 'Independent hold', kind: 'future', until: '2026-11-30' };
    state.tasks['permanent-guard'] = fakeTask('permanent-guard', { held: true, hold: { reason: 'Permanent guard', kind: 'external', until: null } });
  });
  const page = await flow.http('GET', '/projects/project-1/work');
  await sendEdit(flow, findEditor(page.body, 'task', 'pause'), {}, 'guard-pause');
  const row = workView(projectView(flow.store, flow.api.options)).rows.find(r => r.mapping.id === 'mapping-2')!;
  assert.ok(row.mapping.management?.managedDependencies.includes('permanent-guard'));
  assert.ok(!row.mapping.dependencies.includes('permanent-guard'));
  const guard = row.dependencies.find(d => d.id === 'permanent-guard'); assert.ok(guard);
  assert.equal(guard.source, 'Toolkit-owned blocked-by');
  assert.equal(guard.observedAt, row.observedAt);
  assert.equal(guard.stale, row.stale);
});

for (const reviewerError of [false, true]) test(`BUILD-10 conformance read model distinguishes partial accomplishment${reviewerError ? ' and reviewer error' : ''}`, t => {
  const history = structuredClone(baseline);
  const review = history.find(r => r.kind === 'product_review'); assert.ok(review?.kind === 'product_review');
  review.outcome = 'incomplete';
  review.conformance = { inputDigest: 'fixture-digest', profile: { harness: 'codex' }, sessionId: 'fixture-session',
    deliveredFiles: [{ path: 'feature.ts', text: 'Feature behavior', artifact: { uri: 'fixture:delivery', revision: 'v1' } }],
    technicalReviews: [],
    ...(reviewerError ? { error: 'Reviewer returned malformed output' } : {}),
    verdict: reviewerError ? null : { sourceComparison: 'uncertain', instructionFidelity: 'passed', planConformance: 'uncertain',
      criteria: [{ criterion: { id: 'criterion-general', revision: 1 }, state: 'accomplished', behavior: 'General behavior demonstrated',
        quotes: [{ source: 'delivery', text: 'Feature behavior' }], limitations: [] },
      { criterion: { id: 'criterion-second-system', revision: 1 }, state: 'uncertain', behavior: 'Second-system behavior remains uncertain',
        quotes: [{ source: 'delivery', text: 'Feature behavior' }], limitations: ['No second-system acceptance'] }],
      findings: [], suggestions: [], unresolvedQuestions: [] } };
  const flow = setup(t, history);
  const feature = projectView(flow.store, { projectId: 'project-1' }).features[0]!;
  assert.equal(feature.criteria.find(c => c.target.id === 'criterion-general')?.label,
    reviewerError ? 'Reported evidence; product review pending' : 'Demonstrated (reviewed)');
  assert.equal(feature.criteria.find(c => c.target.id === 'criterion-second-system')?.label, 'Reported evidence; product review pending');
  assert.deepEqual(feature.remaining.map(c => c.target.id), reviewerError ? ['criterion-general', 'criterion-second-system'] : ['criterion-second-system']);
  assert.match(feature.completeness, /^Incomplete/u);
});

test('named bundle continuation retains selected stage transitions, rationale and artifact links', async t => {
  const flow = setup(t);
  const page = await flow.http('GET', '/projects/project-1/features/feature-1');
  const saved = await sendEdit(flow, findEditor(page.body, 'design'), {}, 'stage-history-save');
  const named = await flow.http('GET', saved.first.json().resumeUrl);
  const stages = named.body.match(/<h2>Stage progress<\/h2>([\s\S]*?)<\/section>/u)?.[1]; assert.ok(stages);
  assert.match(stages, /Selected-stage history/u);
  for (const stage of fixture.filter(r => r.kind === 'stage_revision')) {
    assert.ok(stages.includes(`/inspect/${stage.id}?revision=${stage.revision}`));
    assert.ok(stages.includes(`/inspect/${stage.artifact.id}?revision=${stage.artifact.revision}`));
    assert.ok(stages.includes(stage.changeReason));
  }
});
