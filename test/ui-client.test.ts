import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { buildEditCommand } from '../src/ui-edit.js';

// Run the actual compiled client against a minimal form surface and in-memory
// fetch. No browser, listener, timers, network or parallel command builder.
function client(fetch: (url: string, options: { body: string }) => Promise<unknown>, count = 1) {
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
    const values = new Map([['context', JSON.stringify({ kind: 'task', action: 'set_priority', mapping })], ['priority', '0'], ['reason', 'Preserve intent']]);
    const form = { values, querySelector: (selector: string) => selector === 'output' ? output : button,
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
    crypto: { randomUUID: () => `key-${++sequence}` }, window: { addEventListener(name: string, listener: Listener) { windows.set(name, listener); } }, setInterval() {},
    location: { reload: () => { reloads++; }, assign: (url: string) => { assigned.push(url); } }, confirm: () => true });
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
  assert.equal(form.values.get('priority'), '0');
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
test('review 2: input entered during a pending save is retained after that save succeeds', async () => {
  let respond!: (response: unknown) => void;
  const form = client(() => new Promise((resolve) => { respond = resolve; }));
  const saving = form.submit();
  form.edit(0, 'priority', '4');
  respond({ status: 200, ok: true, json: async () => ({ records: [] }) });
  await saving;
  assert.equal(form.reloads(), 0);
  assert.equal(form.guarded(), true);
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
