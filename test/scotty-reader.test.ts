import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('scratch Scotty refuses every native mutation and model/update route even with an editing cookie', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-scotty-reader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { scottyReadArgsAllowed, scottyReadRequestAllowed, writeScottyReader, writeScottyLauncher } =
    await import(new URL('../../scripts/scotty-spike-reader.mjs', import.meta.url).href);
  for (const args of [['--version'], ['export', '--json'], ['show', 'fm-pilot-build', '--json']]) assert.equal(scottyReadArgsAllowed(args), true);
  const nativeWrites = [
    ['create', 'copy'], ['update', 'fm-pilot-build', '--title', 'copy'], ['close', 'fm-pilot-build'],
    ['dep', 'remove', 'fm-pilot-verify', 'fm-pilot-build'], ['defer', 'fm-pilot-build'],
    ['comments', 'add', 'fm-pilot-build', 'copy'], ['import', '--json'], ['sql', 'SELECT 1'],
    ['export', '--json', '--db', '/somewhere-else'], ['show', 'foreign-id', '--json'],
  ];
  const fake = join(directory, 'fake-bd.cjs');
  writeFileSync(fake, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({args:process.argv.slice(2), workspace:process.env.BEADS_DIR, socket:process.env.BEADS_DOLT_SERVER_SOCKET}));
`, { mode: 0o755 });
  const reader = join(directory, 'reader.cjs');
  writeScottyReader(reader, { binary: fake, workspace: directory, socket: `${directory}/scratch.sock`, database: 'scratch', canonicalUrl: 'http://127.0.0.1:3185/canonical' });
  for (const args of nativeWrites) {
    assert.equal(scottyReadArgsAllowed(args), false, String(args));
    const result = spawnSync(process.execPath, [reader, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '', 'Refused commands must never reach bd');
    assert.match(result.stderr, /canonical_operation_required/);
  }
  const result = spawnSync(process.execPath, [reader, 'export', '--json'], {
    encoding: 'utf8', env: { ...process.env, BEADS_DIR: '/wrong', BEADS_DOLT_SERVER_SOCKET: '/wrong.sock' },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).workspace, directory);
  assert.equal(JSON.parse(result.stdout).socket, `${directory}/scratch.sock`);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(scottyReadRequestAllowed(method, '/api/p/sf-build05/beads'), false);
    assert.equal(scottyReadRequestAllowed(method, '/api/viewer-mode'), false);
  }
  for (const path of ['/api/update/check', '/api/update/run', '/api/p/sf-build05/publish',
    '/api/p/sf-build05/beads/fm-pilot-build/assist', '/api/p/personal/beads', '/api/fs']) {
    assert.equal(scottyReadRequestAllowed('GET', path), false, path);
  }
  assert.equal(scottyReadRequestAllowed('GET', '/api/p/sf-build05/beads'), true);
  assert.equal(scottyReadRequestAllowed('GET', '/api/p/sf-build05/beads/fm-pilot-build'), true);
  assert.equal(scottyReadRequestAllowed('HEAD', '/p/sf-build05'), true);
  const launcher = join(directory, 'launch.mjs');
  writeScottyLauncher(launcher, 'http://127.0.0.1:3185/canonical');
  assert.match(readFileSync(launcher, 'utf8'), /cookie:'scotty-viewer-mode=read-only'/);
  assert.equal(spawnSync(process.execPath, ['--check', launcher]).status, 0);
});
