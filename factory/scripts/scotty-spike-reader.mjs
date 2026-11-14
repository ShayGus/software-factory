import { writeFileSync } from 'node:fs';
import { request } from 'node:http';

/** Only the fixed scratch scenario's read commands. No option can change DB,
 * workspace, actor, endpoint, or execute SQL through Scotty's process.
 */
export function scottyReadArgsAllowed(args, folder = false) {
  return (args.length === 1 && args[0] === '--version') ||
    (args.length === 2 && args[0] === 'export' && args[1] === '--json') ||
    (args.length === 3 && args[0] === 'show' && (folder ? /^fm-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args[1]) : ['fm-pilot-build', 'fm-pilot-verify'].includes(args[1])) && args[2] === '--json');
}

export function scottyReadRequestAllowed(method, rawPath, projectId = 'sf-build05', folder = false) {
  if (!['GET', 'HEAD'].includes(method)) return false;
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return false;
  const url = new URL(rawPath, 'http://scratch.invalid');
  // Scotty needs no caller-controlled query parameters for these reads.
  if (url.search) return false;
  const path = url.pathname;
  if (folder) {
    const base = `/api/p/${projectId}`;
    return path === '/' || path === `/p/${projectId}` || path.startsWith('/_next/static/') ||
      ['/favicon.ico', '/icon.svg', '/apple-icon.png', '/api/config', '/api/projects', '/api/viewer-mode'].includes(path) ||
      ['beads', 'beads/stream', 'order', 'gamification', 'insights', 'activity'].some(part => path === `${base}/${part}`) ||
      (path.startsWith(`${base}/beads/`) && /^fm-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path.slice(`${base}/beads/`.length)));
  }
  if (path === '/' || path === '/p/sf-build05' || path.startsWith('/_next/') ||
    ['/favicon.ico', '/icon.svg', '/apple-icon.png'].includes(path)) return true;
  return ['/api/config', '/api/projects', '/api/viewer-mode', '/api/p/sf-build05/beads',
    '/api/p/sf-build05/beads/stream', '/api/p/sf-build05/order', '/api/p/sf-build05/gamification',
    '/api/p/sf-build05/insights', '/api/p/sf-build05/activity',
    '/api/p/sf-build05/beads/fm-pilot-build', '/api/p/sf-build05/beads/fm-pilot-verify'].includes(path);
}

/** The published HTTP boundary. Tests exercise this same handler against a
 * local upstream; the launcher embeds it so no other server route is exposed. */
export function createScottyReadHandler({ canonicalUrl, projectId = 'sf-build05', folder = false, authority, tailnet, upstreamPort = 3001 }) {
  return (req, res) => {
    const origin = ['http://' + authority, ...(tailnet ? [tailnet.scottyOrigin] : [])].find(value => new URL(value).host === req.headers.host);
    if (authority && (!origin ||
      (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')) {
      res.writeHead(403).end(); return;
    }
    if (!scottyReadRequestAllowed(req.method, req.url, projectId, folder)) {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'GET, HEAD' });
      res.end(JSON.stringify({ code: 'canonical_operation_required', error: 'Use the canonical operation', operation: tailnet && origin === tailnet.scottyOrigin ? tailnet.uiOrigin : canonicalUrl }));
      return;
    }
    const upstream = request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}`, cookie: 'scotty-viewer-mode=read-only' } }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
    upstream.once('error', () => { res.writeHead(503).end(); });
    res.once('close', () => upstream.destroy());
    upstream.end();
  };
}

/** Next listens on container loopback at 3001; only the guard is published. */
export function writeScottyLauncher(path, canonicalUrl, { projectId = 'sf-build05', folder = false, authority, tailnet } = {}) {
  writeFileSync(path, `import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
const scottyReadRequestAllowed = ${scottyReadRequestAllowed.toString()};
const createScottyReadHandler = ${createScottyReadHandler.toString()};
const child = spawn(process.execPath, ['/app/server.js'], {cwd:'/app', stdio:'inherit',
  env:{...process.env, PORT:'3001', HOSTNAME:'127.0.0.1'}});
child.once('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {child.kill(signal); process.exit(0);});
createServer(createScottyReadHandler(${JSON.stringify({ canonicalUrl, projectId, folder, authority, tailnet })})).listen(3000, '0.0.0.0');
`);
}

export function writeScottyReader(path, { binary = '/usr/local/bin/bd', workspace, socket, database, canonicalUrl, folder = false }) {
  writeFileSync(path, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const allowed = ${scottyReadArgsAllowed.toString()};
const args = process.argv.slice(2);
if (!allowed(args, ${folder})) {
  process.stderr.write(${JSON.stringify(JSON.stringify({ code: 'canonical_operation_required', error: `Scotty is read only. Use ${canonicalUrl}` }) + '\n')});
  process.exit(2);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BEADS_|BD_)/.test(key)));
Object.assign(env, { BEADS_DIR: ${JSON.stringify(workspace)}, BEADS_DOLT_AUTO_START: '0',
  BEADS_DOLT_SERVER_SOCKET: ${JSON.stringify(socket)}, BEADS_DOLT_SERVER_DATABASE: ${JSON.stringify(database)},
  BEADS_DOLT_SERVER_USER: 'root', BD_JSON_ENVELOPE: '1' });
const result = spawnSync(${JSON.stringify(binary)}, args, {env, stdio:'inherit', timeout:15000});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
}
