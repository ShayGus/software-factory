import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { UiSpikeApi } from '../src/index.js';

test('canonical HTTP request preserves a multibyte note split across byte chunks', async () => {
  const { createSpikeRequestHandler } = await import(new URL('../../scripts/ui-spike-http.mjs', import.meta.url).href);
  const { seedSpike } = await import(new URL('../../scripts/ui-spike-scenario.mjs', import.meta.url).href);
  const { store, api }: { store: UiSpikeApi['store']; api: UiSpikeApi } = seedSpike(':memory:',
    { fmHome: '/unused', tasksExecutable: '/unused' });
  try {
    const finding = 'Keep the original wording: שלום ☕ café';
    const previous = store.get('project-1', 'observation-1');
    assert.equal(previous?.kind, 'observation');
    const command = { schemaVersion: 1, id: 'split-note-command', projectId: 'project-1',
      issuedAt: new Date().toISOString(), idempotencyKey: 'split-note-key',
      command: 'capture_consolidate_learning', targetId: 'split-note', expectedRevision: 0,
      payload: { action: 'capture', observation: { ...previous, id: 'split-note', finding, correction: undefined } } };
    const bytes = Buffer.from(JSON.stringify(command));
    const split = bytes.indexOf(Buffer.from('☕')) + 1;
    assert.ok(split > 0 && split < bytes.length);
    const request = Object.assign(Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
      { headers: {}, method: 'POST', url: '/canonical' });
    const response = { status: 0, body: '', writeHead(status: number) { this.status = status; return this; },
      end(body = '') { this.body = body; } };
    await createSpikeRequestHandler(api)(request, response);
    assert.equal(response.status, 200, response.body);
    const saved = store.get('project-1', 'split-note');
    assert.equal(saved?.kind, 'observation');
    assert.equal(saved?.kind === 'observation' && saved.finding, finding);
  } finally { store.close(); }
});

test('canonical HTTP request enforces the byte limit before invoking the API', async () => {
  const { createSpikeRequestHandler } = await import(new URL('../../scripts/ui-spike-http.mjs', import.meta.url).href);
  let called = false;
  const request = Object.assign(Readable.from([Buffer.alloc(1024 * 1024), Buffer.from('x')]),
    { headers: {}, method: 'POST', url: '/canonical' });
  const response = { status: 0, writeHead(status: number) { this.status = status; return this; }, end() {} };
  await createSpikeRequestHandler({ handle() { called = true; } })(request, response);
  assert.equal(response.status, 413);
  assert.equal(called, false);
});
