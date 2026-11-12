import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  ProjectStore, RecordsSchema, ToolkitApi, buildEditCommand, createToolkitRequestHandler, projectView, renderFeature,
  type EditContext, type EditValues, type FactoryRecord, captureRequest, validateAssignmentForDispatch, checkPlanReadiness,
} from '../src/index.js';
import { fakeTask, fakeTaskWrapper } from './task-wrapper-helper.js';

const fixture = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/ui-overview.json', import.meta.url), 'utf8')));
function setup(t: test.TestContext, history: FactoryRecord[] = fixture) {
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
  const adapter = { fmHome: directory, tasksExecutable: backend.executable };
  const api = new ToolkitApi(store, adapter, { projectId: 'project-1', fixture: true });
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
  if (kind !== 'criterion') {
    const plan = flow.store.get('project-1', 'plan-1');
    assert.ok(plan?.kind === 'implementation_plan_revision'); assert.equal(plan.readiness.ready, false);
  }
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
    assert.deepEqual(flow.backend.read().tasks['pilot-verify']!.deps, [{ id: 'pilot-build', type: 'blocked-by' }]);
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
  assert.ok(flow.backend.read().trace.every((item) => item.mappingSaved));
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
    const response = await flow.http('GET', path); assert.equal(response.status, 200); assert.doesNotMatch(response.body, /from ['"]node:/u);
    if (path === '/assets/ui-client.js') assert.match(response.body, /Loading — saving canonical operation/u);
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
  assert.ok(page.body.includes('/inspect/plan-1?revision=1'));
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

test('review 1335: explicit saved-bundle URLs preserve design, plan and task edits in sequence', async (t) => {
  const flow = setup(t);
  const path = '/projects/project-1/features/feature-1';
  const designSave = await sendEdit(flow, findEditor((await flow.http('GET', path)).body, 'design'), { productBehavior: 'Design saved in the explicitly named bundle' }, 'named-design');
  const first = designSave.first.json();
  assert.equal(typeof first.resumeUrl, 'string');
  assert.deepEqual(first.bundle.design, { id: 'design-1', revision: 2 });
  assert.deepEqual(first.bundle.plan, { id: 'plan-1', revision: 2 });
  const planSave = await sendEdit(flow, findEditor((await flow.http('GET', first.resumeUrl)).body, 'plan'), { integrationApproach: 'Plan saved after the named design' }, 'named-plan');
  const taskSave = await sendEdit(flow, findEditor((await flow.http('GET', planSave.first.json().resumeUrl)).body, 'plan-task'), { outputs: 'Task saved after the named plan' }, 'named-task');
  const named = await flow.http('GET', taskSave.first.json().resumeUrl);
  const designEditor = findEditor(named.body, 'design');
  const planEditor = findEditor(named.body, 'plan');
  const taskEditor = findEditor(named.body, 'plan-task');
  assert.equal(designEditor.values.productBehavior, 'Design saved in the explicitly named bundle');
  assert.equal(planEditor.values.integrationApproach, 'Plan saved after the named design');
  assert.equal(taskEditor.values.outputs, 'Task saved after the named plan');
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
  assert.match(criteria, /Evidence revisions:[\s\S]*inspect\/design-1\?revision=1[\s\S]*inspect\/plan-1\?revision=1/u);
  assert.match(page.body, /Incomplete — product behavior still needs verification/u);
  assert.doesNotMatch(page.body, /Complete — current product review passed/u);
});
