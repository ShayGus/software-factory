import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reconcileManagedTask, scottyFields, type UiSpikeApi } from '../src/index.js';
import { fakeTaskWrapper } from './task-wrapper-helper.js';

test('canonical stub round trips preserve intent through BUILD-08 with a self-contained task transport', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-ui-beads-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backend = fakeTaskWrapper(directory, true, join(directory, 'project.sqlite'));
  const { seedSpike, exerciseSpike } = await import(new URL('../../scripts/ui-spike-scenario.mjs', import.meta.url).href);
  const adapter = { fmHome: directory, tasksExecutable: backend.executable };
  const { store, api }: { store: UiSpikeApi['store']; api: UiSpikeApi } = seedSpike(join(directory, 'project.sqlite'), adapter);
  t.after(() => store.close());
  const original = store.get('project-1', 'request-1');
  const transcript = exerciseSpike(api);
  const state = backend.read();
  assert.deepEqual(Object.keys(state.tasks).filter(id => id !== 'permanent-guard').sort(), ['pilot-build', 'pilot-verify']);
  assert.equal(state.tasks['pilot-build']!.priority, 0);
  assert.equal(state.tasks['pilot-build']!.state, 'queued');
  assert.equal(state.tasks['pilot-build']!.hold, null);
  assert.deepEqual(state.tasks['pilot-verify']!.deps, [{ id: 'pilot-build', type: 'blocked-by' }]);
  assert.match(state.tasks['pilot-build']!.body!, /records\/request-1/);
  for (const id of ['observation-1', 'result-general', 'feature-1', 'decision-suggestion']) {
    assert.match(state.tasks['pilot-build']!.body!, new RegExp(`records/${id}`));
    assert.equal(api.handle('GET', `/projects/project-1/records/${id}`).status, 200);
  }
  assert.deepEqual(store.get('project-1', 'request-1'), original);
  assert.equal(store.get('project-1', 'feature-1')!.revision, 2);
  assert.equal(store.get('project-1', 'criterion-second-system')!.revision, 2);
  assert.equal(store.get('project-1', 'decision-suggestion')!.revision, 2);
  assert.equal(store.get('project-1', 'spike-note')?.kind, 'observation');
  assert.equal(store.history('project-1').filter(r => r.id === 'feature-1').length, 2);
  assert.ok(state.calls.some(call => call.args[0] === 'hold'));
  assert.ok(state.calls.some(call => call.args[0] === 'unhold'));
  assert.equal(state.tasks['pilot-verify']!.blocked, true);

  // A successful-key replay does not touch the task transport; new intent fails.
  const command = transcript.find((entry: { command: { payload: { action: string } } }) => entry.command.payload.action === 'set_priority').command;
  assert.equal(api.handle('POST', '/canonical', command).status, 200);
  assert.equal(backend.read().calls.length, state.calls.length);
  assert.equal(api.handle('POST', '/canonical', { ...command, payload: { ...command.payload, priority: 3 } }).status, 400);

  // Every displayed field refuses writes to projected copies, including fields
  // without a tasks-axi mutation (labels) and immutable original intent.
  const before = store.exportProject('project-1');
  for (const field of Object.keys(scottyFields)) {
    const response = api.handle('POST', '/scotty-edit', { projectId: 'project-1', id: 'mapping-1', field, value: 'wrong copy' });
    assert.equal(response.status, 409, field);
    assert.match(JSON.stringify(response.body), /canonical_operation_required/);
  }
  assert.deepEqual(store.exportProject('project-1'), before);
  assert.equal(backend.read().calls.length, state.calls.length);
  assert.equal(api.handle('POST', '/canonical', { ...command, idempotencyKey: 'new-stale', payload: command.payload }).status, 409);
  assert.equal(api.handle('GET', '/projects/project-1/records/missing').status, 404);
  assert.equal(api.handle('GET', '/projects/project-1/records/feature-1?revision=1').status, 200);
  assert.equal(api.handle('GET', '/projects/project-1/records/feature-1?revision=garbage').status, 400);
  assert.equal(api.handle('POST', '/canonical', { ...command, payload: { ...command.payload, action: 'done' } }).status, 400);

  // Lost task mutation output remains unknown, then reconciles by stable ID.
  const mapping = store.get('project-1', 'mapping-1')!;
  const pending = { ...command, id: 'lost-command', idempotencyKey: 'lost-key', issuedAt: new Date().toISOString(), expectedRevision: mapping.revision,
    payload: { ...command.payload, priority: 4 } };
  backend.edit(state => { state.failure = { action: 'update', when: 'after' }; });
  const lost = api.handle('POST', '/canonical', pending);
  assert.equal(lost.status, 202, JSON.stringify(lost.body));
  assert.match(JSON.stringify(lost.body), /unknown/);
  const operation = store.operations('project-1').find(op => op.idempotencyKey === 'lost-key')!;
  assert.equal(reconcileManagedTask(store, 'project-1', operation.id, adapter).state, 'succeeded');
  assert.equal(backend.read().tasks['pilot-build']!.priority, 4);
  assert.equal(Object.keys(backend.read().tasks).filter(id => id !== 'permanent-guard').length, 2);
});
