import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { buildEditCommand } from '../src/ui-edit.js';

// Run the actual compiled client against a minimal form surface and in-memory
// fetch. No browser, listener, timers, network or parallel command builder.
function client(fetch: (url: string, options: { body: string }) => Promise<unknown>) {
  const listeners = new Map<string, (event: { preventDefault(): void }) => Promise<void>>();
  const pageState = { textContent: '' };
  const output = { textContent: '', children: [] as unknown[], append(value: unknown) { this.children.push(value); } };
  const button = { disabled: false, textContent: 'Save change', type: 'submit', addEventListener() {} };
  const mapping = { kind: 'task_mapping', id: 'mapping-1', projectId: 'project-1', revision: 1,
    feature: { id: 'feature-1', revision: 1 }, criteria: [], detailedPlanTask: { id: 'task-1', revision: 1 },
    firstMateTaskId: 'worker-1', dependencies: [] };
  const values = new Map([['context', JSON.stringify({ kind: 'task', action: 'set_priority', mapping })], ['priority', '0'], ['reason', 'Preserve intent']]);
  const form = { querySelector: (selector: string) => selector === 'output' ? output : button,
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => Promise<void>) { listeners.set(name, listener); } };
  let reloads = 0;
  let sequence = 0;
  const source = readFileSync(new URL('../src/ui-client.js', import.meta.url), 'utf8').replace(/^import .*;\n/gmu, '');
  runInNewContext(source, { buildEditCommand, fetch,
    document: { querySelector: () => pageState, querySelectorAll: () => [form], createElement: () => ({ href: '', textContent: '' }) },
    FormData: class { get(key: string) { return values.get(key); } entries() { return values.entries(); } },
    crypto: { randomUUID: () => `key-${++sequence}` }, window: { addEventListener() {} }, setInterval() {},
    location: { reload: () => { reloads++; } }, confirm: () => true });
  return { output, pageState, button, values, reloads: () => reloads,
    submit: () => listeners.get('submit')!({ preventDefault() {} }) };
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
