import assert from 'node:assert/strict';
import test from 'node:test';

test('screen acceptance requires both exact ticket IDs and the exact blocking edge', async () => {
  const { screenProbeObserved } = await import(new URL('../../scripts/folder-services.mjs', import.meta.url).href);
  const payload = { meta: { readOnly: true }, beads: [
    { id: 'fm-probe', dependencies: [] },
    { id: 'fm-probe-dep', dependencies: [{ depends_on_id: 'fm-probe', type: 'blocks' }] },
  ] };
  assert.equal(screenProbeObserved(payload, 'probe', 'probe-dep'), true);
  for (const beads of [
    [payload.beads[1]],
    [payload.beads[0]],
    [payload.beads[0], { id: 'fm-probe-dep', dependencies: [] }],
    [payload.beads[0], { id: 'fm-probe-dep', dependencies: [{ depends_on_id: 'fm-probe-other', type: 'blocks' }] }],
    [payload.beads[0], { id: 'fm-probe-dep', dependencies: [{ depends_on_id: 'fm-probe', type: 'related' }] }],
  ]) assert.equal(screenProbeObserved({ ...payload, beads }, 'probe', 'probe-dep'), false);
  assert.equal(screenProbeObserved({ ...payload, meta: { readOnly: false } }, 'probe', 'probe-dep'), false);
});
