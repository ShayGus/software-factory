import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reconcileManagedTask, scottyFields, type UiSpikeApi } from '../src/index.js';
import { beadsSpikeHarness } from './beads-spike-helper.js';

test('canonical stub round trips preserve intent through BUILD-08 and the real tasks-axi Beads backend with fake bd', {
  skip: process.env.SF_BEADS_INTEGRATION !== '1' && 'Opt in with npm run test:beads-spike; requires local tasks-axi source and install',
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-ui-beads-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backend = beadsSpikeHarness(directory);
  const { seedSpike, exerciseSpike } = await import(new URL('../../scripts/ui-spike-scenario.mjs', import.meta.url).href);
  const adapter = { fmHome: directory, tasksExecutable: backend.executable };
  const { store, api }: { store: UiSpikeApi['store']; api: UiSpikeApi } = seedSpike(join(directory, 'project.sqlite'), adapter);
  t.after(() => store.close());
  const original = store.get('project-1', 'request-1');
  const transcript = exerciseSpike(api);
  const state = backend.read();
  assert.deepEqual(Object.keys(state.rows).sort(), ['fm-pilot-build', 'fm-pilot-verify']);
  assert.equal(state.rows['fm-pilot-build']!.priority, 0);
  assert.equal(state.rows['fm-pilot-build']!.status, 'open');
  assert.equal(state.rows['fm-pilot-build']!.metadata.tasks_axi.task.hold, undefined);
  assert.deepEqual(state.rows['fm-pilot-verify']!.edges, [{ id: 'fm-pilot-build', type: 'blocks' }]);
  assert.match(state.rows['fm-pilot-build']!.description, /records\/request-1/);
  for (const id of ['observation-1', 'result-general', 'feature-1', 'decision-suggestion']) {
    assert.match(state.rows['fm-pilot-build']!.description, new RegExp(`records/${id}`));
    assert.equal(api.handle('GET', `/projects/project-1/records/${id}`).status, 200);
  }
  assert.deepEqual(store.get('project-1', 'request-1'), original);
  assert.equal(store.get('project-1', 'feature-1')!.revision, 2);
  assert.equal(store.get('project-1', 'criterion-second-system')!.revision, 2);
  assert.equal(store.get('project-1', 'decision-suggestion')!.revision, 2);
  assert.equal(store.get('project-1', 'spike-note')?.kind, 'observation');
  assert.equal(store.history('project-1').filter(r => r.id === 'feature-1').length, 2);
  assert.ok(state.calls.some(args => args[1]?.startsWith('CALL tasks_axi_apply_v1')));
  assert.ok(state.calls.every(args => ['sql', 'version'].includes(args[0]!)));

  // A successful-key replay does not touch bd; reusing it for new intent fails.
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
  backend.loseReply();
  const lost = api.handle('POST', '/canonical', pending);
  assert.equal(lost.status, 202, JSON.stringify(lost.body));
  assert.match(JSON.stringify(lost.body), /unknown/);
  const operation = store.operations('project-1').find(op => op.idempotencyKey === 'lost-key')!;
  assert.equal(reconcileManagedTask(store, 'project-1', operation.id, adapter).state, 'succeeded');
  assert.equal(backend.read().rows['fm-pilot-build']!.priority, 4);
  assert.equal(Object.keys(backend.read().rows).length, 2);

  // Source compilation is pinned to main, never the older globally installed backend.
  const proof = JSON.parse(readFileSync(join(directory, 'tasks-axi-main/source.json'), 'utf8'));
  assert.equal(proof.revision, execFileSync('git', ['-C', proof.source, 'rev-parse', 'main'], { encoding: 'utf8' }).trim());
});
