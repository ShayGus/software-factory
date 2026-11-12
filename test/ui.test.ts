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
  type EditContext, type EditValues,
} from '../src/index.js';
import { fakeTask, fakeTaskWrapper } from './task-wrapper-helper.js';

const fixture = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/ui-overview.json', import.meta.url), 'utf8')));
function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-ui-'));
  const database = join(directory, 'project.sqlite');
  const store = new ProjectStore(database);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history: fixture, receipts: [] });
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
  const page = await flow.http('GET', screen);
  const { command, first } = await sendEdit(flow, findEditor(page.body, 'task', action), { priority: '0', dependencies: 'pilot-build' });
  const saved = flow.backend.read().tasks['pilot-verify']!;
  assert.equal(saved.state, 'queued');
  if (action === 'set_priority') assert.equal(saved.priority, 0);
  if (action === 'edit_dependencies') assert.deepEqual(saved.deps, [{ id: 'pilot-build', type: 'blocked-by' }]);
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
  assert.match(page.body, /inspect\/task-1\?revision=1/u);
  assert.match(page.body, /inspect\/plan-1\?revision=1/u);
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
