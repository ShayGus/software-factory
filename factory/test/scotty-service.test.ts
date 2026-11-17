import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import test from 'node:test';

const service = () => import(new URL('../../scripts/scotty-service.mjs', import.meta.url).href);

test('Scotty setup migrates the factory actor, preserves explicit identity and settings, and is repeatable', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-scotty-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { configureScotty } = await service();
  const path = join(dir, 'config.json');
  const args = { name: 'factory', workspace: dir };
  assert.equal(configureScotty(path, args), 'Shay');
  let config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.humanActorChosen, true);
  assert.ok(config.humanAllowlist.includes('Shay'));
  writeFileSync(path, JSON.stringify({ ...config, humanActor: 'factory', humanActorChosen: false, orders: { factory: { ready: ['fm-a'] } } }));
  assert.equal(configureScotty(path, args), 'Shay');
  assert.equal(configureScotty(path, args), 'Shay');
  config = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(config.orders, { factory: { ready: ['fm-a'] } });
  assert.equal(configureScotty(path, { ...args, owner: 'Other person' }), 'Other person');
  assert.equal(configureScotty(path, args), 'Other person');
});

test('Scotty forwards native ticket request bodies, cookies and query-free routes while preserving origin protection', async t => {
  const { createScottyHandler } = await service();
  const received: { method: string | undefined; path: string | undefined; cookie: string | undefined; origin: string | undefined; body: string }[] = [];
  const listen = async (server: Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
  };
  const upstreamPort = await listen(createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      received.push({ method: req.method, path: req.url, cookie: req.headers.cookie, origin: req.headers.origin, body });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"saved":true}');
    });
  }));
  let handler: ReturnType<typeof createScottyHandler>;
  const port = await listen(createServer((req, res) => handler(req, res)));
  const origin = `http://127.0.0.1:${port}`;
  const remote = 'https://factory.example.ts.net:3000';
  handler = createScottyHandler({ authority: `127.0.0.1:${port}`, upstreamPort, tailnet: { scottyOrigin: remote } });
  const send = (method: string, path: string, headers = { Host: `127.0.0.1:${port}`, Origin: origin }) => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: { ...headers, Cookie: 'scotty-viewer-mode=editing', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(JSON.stringify({ title: 'Edited 雪', text: 'A comment' }))) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.setTimeout(3000, () => req.destroy(new Error(`Timed out: ${method} ${path} ${JSON.stringify(headers)} received=${received.length}`)));
    req.on('error', reject); req.end(JSON.stringify({ title: 'Edited 雪', text: 'A comment' }));
  });
  for (const headers of [{ Host: `127.0.0.1:${port}`, Origin: origin }, { Host: new URL(remote).host, Origin: remote }]) {
    for (const [method, path] of [
      ['POST', '/api/p/factory/beads'], ['PATCH', '/api/p/factory/beads/fm-a'],
      ['DELETE', '/api/p/factory/beads/fm-a'], ['POST', '/api/p/factory/beads/fm-a/status'],
      ['POST', '/api/p/factory/beads/fm-a/comments'], ['POST', '/api/p/factory/beads/fm-a/deps'],
      ['DELETE', '/api/p/factory/beads/fm-a/deps'], ['POST', '/api/p/factory/beads/fm-a/human'],
      ['PUT', '/api/config'], ['PUT', '/api/p/factory/order'], ['POST', '/api/viewer-mode'],
    ]) assert.equal(await send(method!, path!, headers), 200, `${method} ${path}`);
  }
  assert.ok(received.every(req => req.body.includes('Edited 雪') && req.cookie === 'scotty-viewer-mode=editing' && req.origin === `http://127.0.0.1:${upstreamPort}`));
  assert.equal(await send('GET', '/p/factory?bead=fm-a&view=needsyou'), 200);
  const count = received.length;
  assert.equal(await send('POST', '/api/p/factory/beads', { Host: 'hostile.invalid', Origin: 'http://hostile.invalid' }), 403);
  assert.equal(await send('PATCH', '/api/p/factory/beads/fm-a', { Host: new URL(remote).host, Origin: origin }), 403);
  for (const path of ['/api/fs', '/api/projects/scan', '/api/update/run', '/api/p/other/beads', '/api/p/factory/beads/fm-a/assist', '/api/p/factory/publish', '/api/p/factory/beads?db=other'])
    assert.equal(await send('POST', path), 405, path);
  assert.equal(received.length, count);
});

test('Scotty bd bridge sends native edits to its fixed database and preserves the configured actor', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-scotty-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { writeScottyService } = await service();
  const binary = join(dir, 'bd.cjs'), wrapper = join(dir, 'bridge.cjs'), launcher = join(dir, 'launch.mjs');
  writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()}));`, { mode: 0o755 });
  writeScottyService(launcher, wrapper, { binary, workspace: dir, socket: dir + '/sql.sock', database: 'scratch', owner: 'Shay', authority: '127.0.0.1:3000' });
  const args = ['update', 'fm-a', '--title', 'Edit title', '--description', 'Line one\nline two'];
  const result = spawnSync(process.execPath, [wrapper, ...args], { encoding: 'utf8', env: { ...process.env, BEADS_DIR: '/wrong', BEADS_DOLT_SERVER_DATABASE: 'wrong', BEADS_ACTOR: 'Chosen person' } });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.deepEqual(seen.args, args);
  assert.equal(seen.cwd, dir);
  assert.equal(seen.env.BEADS_DIR, dir + '/.beads');
  assert.equal(seen.env.BEADS_DOLT_SERVER_DATABASE, 'scratch');
  assert.equal(seen.env.BEADS_DOLT_SERVER_SOCKET, dir + '/sql.sock');
  assert.equal(seen.env.BEADS_DOLT_AUTO_START, '0');
  assert.equal(seen.env.BEADS_ACTOR, 'Chosen person');
  const shown = spawnSync(process.execPath, [wrapper, 'show', 'fm-a', '--json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(shown.stdout).args, ['show', 'fm-a', '--json', '--include-comments']);
  assert.equal(spawnSync(process.execPath, ['--check', launcher]).status, 0);
});
