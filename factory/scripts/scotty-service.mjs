// Installed Scotty: native ticket edits in the same external Beads database.
// Only the fixed project is exposed; app updates, filesystem discovery, AI and
// publishing are not installation operations. The BUILD-05 scratch reader is separate.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { replaceJson } from './home-acceptance.mjs';

export function configureScotty(path, { owner, name, workspace }) {
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // Migrate the old installer's project-name actor. Preserve an owner's explicit
  // Scotty choice, including the hand-configured Shay identity, across rebuilds.
  const humanActor = owner ?? (previous.humanActor && previous.humanActor !== name ? previous.humanActor : 'Shay');
  if (typeof humanActor !== 'string' || !humanActor.trim()) throw new Error('Scotty owner must be a nonempty name');
  const now = new Date().toISOString();
  replaceJson(path, { pollIntervalMs: 5000, orders: {}, gamification: false, ...previous,
    humanActor, humanActorChosen: true,
    humanAllowlist: [...new Set([...(previous.humanAllowlist ?? []), humanActor])],
    projects: [{ ...previous.projects?.find(project => project.id === 'factory'), id: 'factory', name, path: workspace,
      addedAt: previous.projects?.find(project => project.id === 'factory')?.addedAt ?? now, lastOpened: now }],
  });
  return humanActor;
}

export function scottyRequestAllowed(method, rawPath) {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return false;
  const url = new URL(rawPath, 'http://scotty.invalid');
  const path = url.pathname;
  if (/[%\\]/.test(path)) return false;
  // Page query parameters carry native ticket links and filters, not routing.
  if (['GET', 'HEAD'].includes(method) && path === '/p/factory') return true;
  if (url.search && !(path === '/api/p/factory/insights' && [...url.searchParams.keys()].every(key => key === 'days'))) return false;
  if (['GET', 'HEAD'].includes(method)) {
    return ['/', '/p/factory', '/favicon.ico', '/icon.svg', '/apple-icon.png', '/api/config', '/api/projects', '/api/viewer-mode'].includes(path) ||
      path.startsWith('/_next/static/') ||
      /^\/api\/p\/factory\/(beads(?:\/stream|\/fm-[A-Za-z0-9][A-Za-z0-9._-]*)?|order|gamification|insights|activity|doctor)$/.test(path);
  }
  if (method === 'POST' && ['/api/viewer-mode', '/api/p/factory/beads'].includes(path)) return true;
  if (method === 'PUT' && ['/api/config', '/api/p/factory/order'].includes(path)) return true;
  const ticket = '/api/p/factory/beads/fm-[A-Za-z0-9][A-Za-z0-9._-]*';
  if (['PATCH', 'DELETE'].includes(method) && new RegExp(`^${ticket}$`).test(path)) return true;
  return (method === 'POST' && new RegExp(`^${ticket}/(status|comments|deps|human|gate|archive)$`).test(path)) ||
    (method === 'DELETE' && new RegExp(`^${ticket}/deps$`).test(path));
}

export function createScottyHandler({ authority, tailnet, upstreamPort = 3001 }) {
  return (req, res) => {
    const origin = ['http://' + authority, ...(tailnet ? [tailnet.scottyOrigin] : [])].find(value => new URL(value).host === req.headers.host);
    if (!origin || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end(); return;
    }
    if (!scottyRequestAllowed(req.method, req.url)) {
      res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'operation_unavailable', error: 'This route is not available in the installed Scotty service' }));
      return;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
    // The public origin was checked above. Next's own guard sees the loopback
    // upstream authority, so translate Origin only after that strict check.
    if (headers.origin) headers.origin = `http://127.0.0.1:${upstreamPort}`;
    const upstream = request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.once('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  };
}

export function writeScottyService(launcher, wrapper, { workspace, socket, database, owner, authority, tailnet, binary = '/usr/local/bin/bd' }) {
  writeFileSync(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BEADS_|BD_)/.test(key)));
Object.assign(env, ${JSON.stringify({ BEADS_DIR: workspace + '/.beads', BEADS_DOLT_AUTO_START: '0', BEADS_DOLT_SERVER_SOCKET: socket,
    BEADS_DOLT_SERVER_DATABASE: database, BEADS_DOLT_SERVER_USER: 'root', BD_JSON_ENVELOPE: '1', BEADS_ACTOR: owner })});
env.BEADS_ACTOR = process.env.BEADS_ACTOR || env.BEADS_ACTOR;
const args = process.argv.slice(2);
// bd 1.1.0 omits full comments from show unless explicitly requested.
if (args[0] === 'show' && args.includes('--json')) args.push('--include-comments');
const result = spawnSync(${JSON.stringify(binary)}, args, {cwd:${JSON.stringify(workspace)}, env, stdio:'inherit', timeout:15000});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(launcher, `import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
const scottyRequestAllowed = ${scottyRequestAllowed.toString()};
const createScottyHandler = ${createScottyHandler.toString()};
const child = spawn(process.execPath, ['/app/server.js'], {cwd:'/app', stdio:'inherit',
  env:{...process.env, PORT:'3001', HOSTNAME:'127.0.0.1'}});
child.once('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {child.kill(signal); process.exit(0);});
createServer(createScottyHandler(${JSON.stringify({ authority, tailnet })})).listen(3000, '0.0.0.0');
`);
}
