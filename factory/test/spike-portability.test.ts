import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('default canonical routing tests need only Node and this checkout, without git or global tasks-axi', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-spike-path-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  symlinkSync(process.execPath, join(directory, 'node'));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('./ui-spike.test.js', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    env: { ...environment, PATH: directory, SF_BEADS_INTEGRATION: '' },
  });
  assert.match(result.stdout, /canonical stub round trips/, 'The child must actually run the routing test');
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
