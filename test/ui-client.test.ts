import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { buildEditCommand, type EditContext } from '../src/ui-edit.js';
import { applyCommand, ProjectStore, RecordsSchema } from '../src/index.js';

// Run the actual compiled client against a minimal form surface and in-memory
// fetch. No browser, listener, timers, network or parallel command builder.
function client(fetch: (url: string, options: { body: string }) => Promise<unknown>, count = 1, initialContext?: EditContext) {
  type Listener = (event: { preventDefault(): void }) => unknown;
  const pageState = { textContent: '' };
  const windows = new Map<string, Listener>();
  const surfaces = Array.from({ length: count }, (_, index) => {
    const listeners = new Map<string, Listener>();
    const output = { textContent: '', children: [] as unknown[], append(value: unknown) { this.children.push(value); } };
    const button = { disabled: false, textContent: 'Save change', type: 'submit', addEventListener() {} };
    const mapping = { kind: 'task_mapping', id: `mapping-${index + 1}`, projectId: 'project-1', revision: 1,
      feature: { id: 'feature-1', revision: 1 }, criteria: [], detailedPlanTask: { id: 'task-1', revision: 1 },
      firstMateTaskId: `worker-${index + 1}`, dependencies: [] };
    const values = new Map([['context', JSON.stringify(initialContext ?? { kind: 'task', action: 'set_priority', mapping })], ['priority', '0'], ['reason', 'Preserve intent']]);
    const contextInput = { get value() { return values.get('context')!; }, set value(value: string) { values.set('context', value); } };
    const form = { values, querySelector: (selector: string) => selector === 'output' ? output : selector === '[name=context]' ? contextInput : button,
      addEventListener(name: string, listener: Listener) { listeners.set(name, listener); } };
    return { form, output, button, values, listeners };
  });
  let reloads = 0;
  const assigned: string[] = [];
  let sequence = 0;
  const source = readFileSync(new URL('../src/ui-client.js', import.meta.url), 'utf8').replace(/^import .*;\n/gmu, '');
  runInNewContext(source, { buildEditCommand, fetch,
    document: { querySelector: () => pageState, querySelectorAll: () => surfaces.map((surface) => surface.form), createElement: () => ({ href: '', textContent: '' }) },
    FormData: class { constructor(readonly form: { values: Map<string, string> }) {} get(key: string) { return this.form.values.get(key); } entries() { return this.form.values.entries(); } },
    DOMParser: class { parseFromString(context: string) { return { querySelectorAll: () => [{ querySelector: () => ({ value: context }) }] }; } },
    crypto: { randomUUID: () => `key-${++sequence}` }, window: { addEventListener(name: string, listener: Listener) { windows.set(name, listener); } }, setInterval() {},
    location: { reload: () => { reloads++; }, assign: (url: string) => { assigned.push(url); }, href: 'http://127.0.0.1/projects/project-1/work' }, confirm: () => true });
  return { output: surfaces[0]!.output, button: surfaces[0]!.button, values: surfaces[0]!.values, surfaces, pageState, assigned, reloads: () => reloads,
    edit(index: number, key: string, value: string) { surfaces[index]!.values.set(key, value); surfaces[index]!.listeners.get('input')!({ preventDefault() {} }); },
    guarded() { let prevented = false; windows.get('beforeunload')!({ preventDefault() { prevented = true; } }); return prevented; },
    submit: async (index = 0) => { await surfaces[index]!.listeners.get('submit')!({ preventDefault() {} }); } };
}
for (const [status, state] of [[202, 'unknown'], [502, 'failed']] as const) test(`client locks ${state} task outcomes and links to the operation`, async () => {
  const form = client(async () => ({ status, ok: status < 400, json: async () => ({ operation: { id: 'operation-1', state },
    error: { code: state === 'unknown' ? 'unknown_outcome' : 'external_failure', message: 'Inspect the saved operation' } }) }));
  await form.submit();
  assert.equal(form.button.disabled, true);
  assert.equal(form.output.children.length, 1);
  assert.equal((form.output.children[0] as { href: string }).href, '/projects/project-1/inspect/operation-1');
  assert.equal(form.reloads(), 0);
});
test('a lost-response retry reuses the exact command even if form values were changed', async () => {
  const bodies: string[] = [];
  const form = client(async (_url, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) throw new TypeError('Response lost');
    return { status: 200, ok: true, json: async () => ({ operation: { state: 'succeeded' } }) };
  });
  await form.submit();
  assert.match(form.output.textContent, /Unknown — response unavailable/u);
  assert.equal(form.button.textContent, 'Retry same operation');
  form.values.set('priority', '4');
  await form.submit();
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]!).payload.priority, 0);
  assert.equal(form.reloads(), 1);
});
test('a revision conflict preserves typed values and labels the page stale', async () => {
  const form = client(async () => ({ status: 409, ok: false, json: async () => ({ error: { code: 'conflict' } }) }));
  await form.submit();
  assert.match(form.output.textContent, /Stale — revision conflict/u);
  assert.match(form.pageState.textContent, /Stale/u);
  assert.equal(form.button.textContent, 'Reload current records');
  assert.equal(form.reloads(), 0);
});


test('review 2: saving one editor preserves another editor draft and its leave-page guard', async () => {
  const form = client(async () => ({ status: 200, ok: true, json: async () => ({ records: [] }) }), 2);
  form.edit(1, 'priority', '3');
  await form.submit(0);
  assert.equal(form.reloads(), 0);
  assert.equal(form.guarded(), true);
  assert.match(form.surfaces[0]!.output.textContent, /Saved/u);
});
test('review 2: another save cannot discard a lost-response retry', async () => {
  const bodies: string[] = [];
  const form = client(async (_url, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) throw new TypeError('Response lost');
    return { status: 200, ok: true, json: async () => ({ records: [] }) };
  }, 2);
  await form.submit(0);
  assert.equal(form.guarded(), true);
  await form.submit(1);
  assert.equal(form.reloads(), 0);
  assert.equal(form.guarded(), true);
  await form.submit(0);
  assert.equal(bodies[0], bodies[2]);
  assert.equal(form.reloads(), 1);
});
test('input entered during a pending save can subsequently reach canonical records', async t => {
  const store = new ProjectStore(':memory:'); t.after(() => store.close());
  const history = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/ui-overview.json', import.meta.url), 'utf8')));
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history, receipts: [] });
  const context = (): EditContext => {
    const feature = store.get('project-1', 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
    return { kind: 'feature', feature };
  };
  let respond!: () => void;
  const commands: ReturnType<typeof buildEditCommand>[] = [];
  const form = client(async (_url, options) => {
    if (!options?.body) return { ok: true, text: async () => JSON.stringify(context()) };
    const command = JSON.parse(options.body); commands.push(command);
    const result = applyCommand(store, command);
    const response = { status: 200, ok: true, json: async () => result };
    if (commands.length === 1) return new Promise(resolve => { respond = () => resolve(response); });
    return response;
  }, 1, context());
  const saving = form.submit();
  form.edit(0, 'priority', '4');
  respond();
  await saving;
  assert.equal(form.reloads(), 0);
  assert.equal(form.guarded(), true);
  assert.equal(form.button.disabled, false);
  await form.submit();
  assert.equal(commands.length, 2);
  assert.notEqual(commands[0]!.idempotencyKey, commands[1]!.idempotencyKey);
  const feature = store.get('project-1', 'feature-1'); assert.ok(feature?.kind === 'feature_revision');
  assert.equal(feature.priority, 4);
  assert.equal(feature.revision, 3);
  assert.equal(form.reloads(), 1);
});

test('review 1335: an artifact save reloads with its exact returned bundle URL', async () => {
  const resumeUrl = '/projects/project-1/features/feature-1?bundle=exact-saved-revisions';
  const form = client(async () => ({ status: 200, ok: true, json: async () => ({ records: [], resumeUrl }) }));
  await form.submit();
  assert.deepEqual(form.assigned, [resumeUrl]);
  assert.equal(form.reloads(), 0);
});

test('work snapshot becomes stale at the configured threshold without polling or replacing drafts', () => {
  const source = readFileSync(new URL('../src/ui-client.js', import.meta.url), 'utf8').replace(/^import .*;\n/gmu, '');
  const at = '2026-11-12T12:00:00Z';
  let now = Date.parse(at);
  const pageState = { textContent: '' };
  const snapshot = { textContent: `Observed — FirstMate snapshot taken ${at}`, dataset: { snapshotAt: at, staleAfterMs: '120000' } };
  let tick = () => {};
  runInNewContext(source, { buildEditCommand,
    document: { querySelector: (selector: string) => selector === 'main' ? { dataset: { staleAfterMs: '120000' } } : pageState,
      querySelectorAll: (selector: string) => selector === '[data-snapshot-at]' ? [snapshot] : [] },
    Date: class extends Date { static now() { return now; } },
    window: { addEventListener() {} },
    setInterval(callback: () => void) { tick = callback; },
    fetch() { assert.fail('Freshness must not poll FirstMate or the network'); },
  });
  now += 61000; tick();
  assert.match(snapshot.textContent, /^Observed/u);
  assert.equal(pageState.textContent, '');
  now += 60000; tick();
  assert.match(snapshot.textContent, /^Stale — FirstMate snapshot taken/u);
  assert.match(pageState.textContent, /^Stale — page has exceeded its freshness threshold/u);
});

for (const competing of ['feature', 'design', 'feature-behind-design'] as const)
test(`review 1438 finding 1: ${competing} writer between save and refresh preserves draft and locks further submission`, async t => {
  const store = new ProjectStore(':memory:'); t.after(() => store.close());
  const history = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/ui-overview.json', import.meta.url), 'utf8')));
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history, receipts: [] });
  const feature = () => {
    const record = store.get('project-1', 'feature-1'); assert.ok(record?.kind === 'feature_revision'); return record;
  };
  const context = (): EditContext => {
    if (competing === 'feature') return { kind: 'feature', feature: feature() };
    const design = store.get('project-1', 'design-1'); assert.ok(design?.kind === 'design_revision');
    const plan = store.get('project-1', 'plan-1'); assert.ok(plan?.kind === 'implementation_plan_revision');
    const tasks = plan.deliverySequence.map(ref => {
      const task = store.get('project-1', ref.id, ref.revision); assert.ok(task?.kind === 'detailed_plan_task'); return task;
    });
    return { kind: 'design', feature: feature(), design, plan, tasks,
      expectedRevisions: [feature(), design, plan, ...tasks].map(({ id, revision }) => ({ id, revision })) };
  };
  const initial = context();
  let respond!: () => void;
  let submissions = 0;
  const form = client(async (_url, options) => {
    if (!options?.body) {
      const rival = competing === 'design' ? context() : { kind: 'feature' as const, feature: feature() };
      applyCommand(store, buildEditCommand(rival, { reason: 'Concurrent writer scope clarification',
        ...(competing === 'design' ? { productBehavior: 'Concurrent design behavior' } : { priority: '2', outcome: 'Concurrent feature outcome' }) },
        'competing-writer', new Date().toISOString()));
      return { ok: true, text: async () => JSON.stringify(context()) };
    }
    submissions++;
    const result = applyCommand(store, JSON.parse(options.body));
    const response = { status: 200, ok: true, json: async () => result };
    if (submissions === 1) return new Promise(resolve => { respond = () => resolve(response); });
    return response;
  }, 1, initial);
  if (initial.kind === 'feature') form.values.set('outcome', initial.feature.outcome);
  else if (initial.kind === 'design') form.values.set('productBehavior', initial.design.productBehavior);
  const saving = form.submit();
  const field = competing === 'feature' ? 'priority' : 'technicalDesign';
  const draft = competing === 'feature' ? '4' : 'Retained technical draft';
  form.edit(0, field, draft);
  respond(); await saving;
  assert.match(form.output.textContent, /revision conflict/u);
  assert.match(form.pageState.textContent, /Stale/u);
  assert.equal(form.values.get(field), draft);
  assert.deepEqual(JSON.parse(form.values.get('context')!), initial, 'Do not silently adopt the competing revisions');
  assert.equal(form.button.type, 'button');
  assert.equal(form.button.textContent, 'Reload current records');
  const before = store.exportProject('project-1');
  await form.submit();
  assert.equal(submissions, 1, 'Even a direct submit event is refused until reload');
  assert.deepEqual(store.exportProject('project-1'), before);
  if (competing === 'design') {
    const design = store.get('project-1', 'design-1'); assert.ok(design?.kind === 'design_revision');
    assert.equal(design.productBehavior, 'Concurrent design behavior');
  } else assert.equal(feature().outcome, 'Concurrent feature outcome');
  assert.equal(form.guarded(), true);
  assert.equal(form.reloads(), 0);
});
