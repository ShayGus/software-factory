// Dedicated services owned by setup-firstmate-home. No shared service changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeScottyLauncher, writeScottyReader } from './scotty-spike-reader.mjs';

export const serviceNames = container => ({ scotty: `${container}-scotty`, ui: `${container}-ui` });
async function freePort(value) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(value === 'auto' ? 0 : Number(value), '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function installFolderServices(args, docker, baseImage, previous) {
  const home = args.home;
  const root = args.factoryRoot ?? join(home, '.tools/software-factory');
  const directory = join(home, 'config/software-factory-services');
  mkdirSync(join(directory, 'bead-me-up-scotty'), { recursive: true });
  const uiPort = await freePort(previous?.uiPort ?? args['ui-port']);
  const scottyPort = await freePort(previous?.scottyPort ?? args['scotty-port']);
  if (uiPort === scottyPort) throw new Error('Factory and Scotty ports must differ');
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  const scottyOrigin = `http://127.0.0.1:${scottyPort}`;
  const names = serviceNames(args.container);
  const reader = join(directory, 'scotty-bd.cjs');
  const launcher = join(directory, 'scotty-launch.mjs');
  const workspace = join(home, 'beads/workspace');
  writeScottyReader(reader, { workspace: join(workspace, '.beads'), socket: join(home, 'beads/sql/server.sock'),
    database: args.database, canonicalUrl: uiOrigin, folder: true });
  writeScottyLauncher(launcher, uiOrigin, { projectId: 'factory', folder: true, authority: `127.0.0.1:${scottyPort}` });
  const now = new Date().toISOString();
  if (!previous) writeFileSync(join(directory, 'bead-me-up-scotty/config.json'), JSON.stringify({
    humanActor: args.name, humanAllowlist: [], pollIntervalMs: 5000, orders: {}, gamification: false,
    projects: [{ id: 'factory', name: args.name, path: workspace, addedAt: now, lastOpened: now }],
  }, null, 2) + '\n', { flag: 'wx' });
  const runtimeImage = baseImage;
  const common = ['--label', `com.software-factory.home=${home}`, '--restart', 'unless-stopped', '--user', `${process.getuid()}:${process.getgid()}`];
  docker(['run', '--pull', 'never', '-d', '--name', names.scotty, ...common, '-p', `127.0.0.1:${scottyPort}:3000`,
    '-v', `${home}:${home}:ro`, '-e', `BEADS_REPO=${workspace}`, '-e', `BEADS_FS_ROOT=${workspace}`,
    '-e', `XDG_CONFIG_HOME=${directory}`, '-e', `BD_BIN=${reader}`, '-e', 'SCOTTY_READ_ONLY=1', '-e', 'POSTHOG_KEY=',
    '--entrypoint', 'node', baseImage, launcher]);
  docker(['run', '--pull', 'never', '-d', '--name', names.ui, ...common, '-p', `127.0.0.1:${uiPort}:${uiPort}`,
    '-v', `${home}:${home}`, '-w', home, '-e', `SF_UI_PORT=${uiPort}`, '-e', 'SF_UI_HOST=0.0.0.0',
    '-e', `SF_UI_HOME=${home}`, '-e', `SF_UI_REGISTRY=${join(home, 'config/software-factory.projects.json')}`,
    '-e', `SF_SCOTTY_URL=${scottyOrigin}`, '-e', `FM_HOME=${home}`, '-e', 'BEADS_DOLT_AUTO_START=0',
    '-e', 'SF_NODE_BINARY=/usr/local/bin/node', '-e', `PATH=${join(home, '.tools/bin')}:/usr/local/bin:/usr/bin:/bin`,
    '--entrypoint', 'node', runtimeImage, join(root, 'scripts/ui.mjs')]);
  return { names, uiPort, scottyPort, uiOrigin, scottyOrigin, runtimeImage };
}

export async function waitForScreens(services) {
  const deadline = Date.now() + 60000;
  for (const url of [services.uiOrigin, `${services.scottyOrigin}/api/p/factory/beads`]) {
    while (true) {
      try { const response = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (response.ok) break; } catch { /* Startup/reboot may still be in progress. */ }
      if (Date.now() > deadline) throw new Error(`Screen did not answer: ${url}; inspect dedicated container logs`);
      await delay(500);
    }
  }
}

export function screenProbeObserved(payload, probe, successor) {
  const beads = payload.beads;
  return payload.meta?.readOnly === true && Array.isArray(beads) && beads.some(bead => bead.id === `fm-${probe}`) &&
    beads.some(bead => bead.id === `fm-${successor}` && bead.dependencies?.some(edge => edge.depends_on_id === `fm-${probe}` && edge.type === 'blocks'));
}

export async function acceptScreens(home, services, wrapper) {
  await waitForScreens(services);
  const probe = `sf-screen-check-${Date.now()}`;
  const successor = `${probe}-dep`;
  const evidence = { ui: services.uiOrigin, scotty: services.scottyOrigin, probe, checks: [] };
  const check = async (path, init) => {
    const response = await fetch(services.scottyOrigin + path, { ...init, signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    evidence.checks.push({ path, method: init?.method ?? 'GET', status: response.status, body: text });
    return { response, text };
  };
  let added = false;
  let dependentAdded = false;
  try {
    wrapper(['add', probe, 'Software Factory screen acceptance']); added = true;
    wrapper(['add', successor, 'Screen dependency acceptance', '--blocked-by', probe]); dependentAdded = true;
    const page = await check('/p/factory');
    if (!page.response.ok || !page.response.headers.get('content-type')?.includes('text/html')) throw new Error('Scotty page did not answer');
    const { response, text } = await check('/api/p/factory/beads', { headers: { cookie: 'scotty-viewer-mode=editing' } });
    const payload = JSON.parse(text);
    if (!response.ok || !screenProbeObserved(payload, probe, successor)) {
      throw new Error('Scotty did not show tasks-axi probe and dependency edge');
    }
    for (const [method, path, body] of [
      ['POST', '/api/p/factory/beads', { title: 'Must be refused' }],
      ['PATCH', `/api/p/factory/beads/fm-${probe}`, { title: 'Must be refused' }],
      ['DELETE', `/api/p/factory/beads/fm-${probe}`, {}],
      ['POST', '/api/viewer-mode', { mode: 'editing' }],
    ]) {
      const result = await check(path, { method, headers: { 'Content-Type': 'application/json', cookie: 'scotty-viewer-mode=editing' }, body: JSON.stringify(body) });
      if (result.response.status !== 405 || !result.text.includes('canonical_operation_required')) throw new Error(`Scotty allowed ${method} ${path}`);
    }
    const after = wrapper(['list']);
    if (!after.includes(probe) || !after.includes(successor) || after.includes('Must be refused')) throw new Error('Scotty write boundary changed the backlog');
    const ui = await fetch(services.uiOrigin, { signal: AbortSignal.timeout(5000) });
    const html = await ui.text();
    evidence.factory = { status: ui.status, body: html };
    if (!ui.ok || !html.includes('Projects')) throw new Error('Factory folder screen did not answer');
    console.log('Screen acceptance passed: folder UI, tasks-axi probe/dependency in Scotty, native writes refused');
  } finally {
    try { if (dependentAdded) wrapper(['rm', successor]); }
    finally {
      try { if (added) wrapper(['rm', probe]); }
      finally { writeFileSync(join(home, `data/software-factory.screens.${Date.now()}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    }
  }
}
