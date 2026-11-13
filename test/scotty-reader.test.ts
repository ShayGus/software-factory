import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, request, type Server } from 'node:http';

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
  assert.equal(spawnSync(process.execPath, ['--check', launcher]).status, 0);
});

test('published Scotty guard refuses hostile headers without forwarding and forces read-only for valid local requests', async t => {
  const { createScottyReadHandler } = await import(new URL('../../scripts/scotty-spike-reader.mjs', import.meta.url).href);
  const received: unknown[] = [];
  const listen = async (server: Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return address.port;
  };
  const upstream = createServer((req, res) => {
    received.push({ method: req.method, path: req.url, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"read":true}');
  });
  const upstreamPort = await listen(upstream);
  let handler: ReturnType<typeof createScottyReadHandler>;
  const guard = createServer((req, res) => handler(req, res));
  const port = await listen(guard);
  const authority = `127.0.0.1:${port}`;
  handler = createScottyReadHandler({ canonicalUrl: 'http://127.0.0.1:3999', projectId: 'factory', folder: true, authority, upstreamPort });
  const send = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/api/p/factory/beads', headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(await send({ Host: authority, Origin: `http://${authority}`, Cookie: 'scotty-viewer-mode=editing' }), 200);
  assert.deepEqual(received, [{ method: 'GET', path: '/api/p/factory/beads', cookie: 'scotty-viewer-mode=read-only' }]);
  for (const headers of [{ Host: 'foreign.invalid' }, { Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal(await send({ Host: authority, ...headers }), 403);
    assert.equal(received.length, 1, 'Hostile request must not reach Scotty');
  }
});

test('folder Scotty reads arbitrary folder tickets but refuses alternate endpoints, options and every write', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-folder-reader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { scottyReadArgsAllowed, scottyReadRequestAllowed, writeScottyReader } =
    await import(new URL('../../scripts/scotty-spike-reader.mjs', import.meta.url).href);
  const fake = join(directory, 'bd.cjs');
  // Use an executable fake to observe whether refused arguments reached bd.
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 });
  const reader = join(directory, 'reader.cjs');
  writeScottyReader(reader, { binary: fake, workspace: directory, socket: `${directory}/sql.sock`, database: 'folder', canonicalUrl: 'http://127.0.0.1:3999', folder: true });
  for (const args of [['show', 'fm-new-task.2', '--json'], ['export', '--json']]) {
    assert.equal(scottyReadArgsAllowed(args, true), true);
    const result = spawnSync(process.execPath, [reader, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  }
  for (const args of [['show', '--help', '--json'], ['show', 'other-ticket', '--json'],
    ['show', 'fm-task', '--json', '--db', '/elsewhere'], ['sql', 'SELECT 1'], ['create', 'bad'], ['update', 'fm-task', '--title', 'bad']]) {
    const result = spawnSync(process.execPath, [reader, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  const allowed = (method: string, path: string) => scottyReadRequestAllowed(method, path, 'factory', true);
  assert.equal(allowed('GET', '/api/p/factory/beads/fm-any-task'), true);
  assert.equal(allowed('GET', '/api/p/factory/beads/stream'), true);
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) assert.equal(allowed(method, '/api/p/factory/beads'), false);
  for (const path of ['/api/fs', '/api/projects/scan', '/api/update/run', '/api/p/other/beads',
    '/api/p/factory/beads/fm-task/assist', '/api/p/factory/publish', '/api/p/factory/beads?db=other',
    '/api/p/factory/beads/%66m-task', '/_next/anything']) assert.equal(allowed('GET', path), false, path);
});
