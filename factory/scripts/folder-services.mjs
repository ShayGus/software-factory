// Dedicated services owned by setup-firstmate-home. No shared service changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configureTailnet } from './tailnet.mjs';
import { configureScotty, writeScottyService } from './scotty-service.mjs';
import { containerExists } from './home-acceptance.mjs';

export const serviceNames = container => ({ scotty: `${container}-scotty`, ui: `${container}-ui` });
async function freePort(value) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(value === 'auto' ? 0 : Number(value), '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function planFolderServices(args) {
  const uiPort = await freePort(args['ui-port']);
  let scottyPort = await freePort(args['scotty-port']);
  if (uiPort === scottyPort && args['scotty-port'] === 'auto') scottyPort = await freePort('auto');
  if (uiPort === scottyPort) throw new Error('Factory and Scotty ports must differ');
  return { uiPort, scottyPort };
}

export async function installFolderServices(args, docker, baseImage, previous) {
  const home = args.home;
  const root = args.factoryRoot ?? join(home, '.tools/software-factory');
  const directory = join(home, 'config/software-factory-services');
  mkdirSync(join(directory, 'bead-me-up-scotty'), { recursive: true });
  const { uiPort, scottyPort } = previous ?? await planFolderServices(args);
  const uiOrigin = new URL(`http://127.0.0.1:${uiPort}`).origin;
  const scottyOrigin = new URL(`http://127.0.0.1:${scottyPort}`).origin;
  const tailnet = args.tailnet ? configureTailnet({ uiPort, scottyPort, uiOrigin, scottyOrigin }) : undefined;
  const names = serviceNames(args.container);
  const reader = join(directory, 'scotty-bd.cjs');
  const launcher = join(directory, 'scotty-launch.mjs');
  const workspace = join(home, 'beads/workspace');
  const owner = configureScotty(join(directory, 'bead-me-up-scotty/config.json'), { owner: args.owner, name: args.name, workspace });
  writeScottyService(launcher, reader, { workspace, socket: join(home, 'beads/sql/server.sock'), database: args.database, owner,
    authority: new URL(scottyOrigin).host, tailnet: tailnet?.enabled ? tailnet : undefined });
  const runtimeImage = baseImage;
  const common = ['--label', `com.software-factory.home=${home}`, '--restart', 'unless-stopped', '--user', `${process.getuid()}:${process.getgid()}`];
  const ensure = (kind, port, internal, argv) => {
    if (!containerExists(docker, names[kind])) { docker(argv); return; }
    const [container] = JSON.parse(docker(['inspect', names[kind]]));
    verifyFolderService(container, home, kind, port, internal, [baseImage], { editable: true });
    if (!container.State.Running) docker(['start', names[kind]]);
  };
  ensure('scotty', scottyPort, 3000, ['run', '--pull', 'never', '-d', '--name', names.scotty, ...common, '-p', `127.0.0.1:${scottyPort}:3000`,
    '-v', `${home}:${home}:ro`, '-v', `${directory}:${directory}`, '-e', `BEADS_REPO=${workspace}`, '-e', `BEADS_FS_ROOT=${workspace}`,
    '-e', `XDG_CONFIG_HOME=${directory}`, '-e', `BD_BIN=${reader}`, '-e', 'SCOTTY_READ_ONLY=0', '-e', 'POSTHOG_KEY=',
    '--entrypoint', 'node', baseImage, launcher]);
  ensure('ui', uiPort, uiPort, ['run', '--pull', 'never', '-d', '--name', names.ui, ...common, '-p', `127.0.0.1:${uiPort}:${uiPort}`,
    '-v', `${home}:${home}`, '-w', home, '-e', `SF_UI_PORT=${uiPort}`, '-e', 'SF_UI_HOST=0.0.0.0',
    '-e', `SF_UI_HOME=${home}`, '-e', `SF_UI_REGISTRY=${join(home, 'config/software-factory.projects.json')}`,
    '-e', `SF_TAILNET=${tailnet?.enabled ? JSON.stringify(tailnet) : ''}`,
    '-e', `SF_SCOTTY_URL=${scottyOrigin}`, '-e', `FM_HOME=${home}`, '-e', 'BEADS_DOLT_AUTO_START=0',
    '-e', 'SF_NODE_BINARY=/usr/local/bin/node', '-e', `PATH=${join(home, '.tools/bin')}:/usr/local/bin:/usr/bin:/bin`,
    '--entrypoint', 'node', runtimeImage, join(root, 'scripts/ui.mjs')]);
  return { editable: true, owner, names, uiPort, scottyPort, uiOrigin, scottyOrigin, runtimeImage, ...(tailnet ? { tailnet } : {}) };
}

// Used by installation, completed-install verification and guarded update recovery.
export function verifyFolderService(container, home, kind, port, internal, images, { editable = false, allowLegacy = false } = {}) {
  const directory = join(home, 'config/software-factory-services');
  const legacyLayout = container.Mounts.length === 1;
  const editableLayout = container.Mounts.length === 2 && container.Mounts.some(m =>
    m.Type === 'bind' && m.Source === directory && m.Destination === directory && m.RW) &&
    container.Config.Env?.includes('SCOTTY_READ_ONLY=0');
  const layoutAllowed = kind === 'ui' || !editable ? legacyLayout : editableLayout || (allowLegacy && legacyLayout);
  const bindings = container.HostConfig.PortBindings?.[`${internal}/tcp`];
  if (container.Config.Labels?.['com.software-factory.home'] !== home || !images.includes(container.Image) ||
    container.HostConfig.RestartPolicy.Name !== 'unless-stopped' ||
    Object.keys(container.HostConfig.PortBindings ?? {}).length !== 1 || !bindings || bindings.length !== 1 ||
    bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== String(port) ||
    !layoutAllowed || !container.Mounts.some(m => m.Type === 'bind' && m.Source === home && m.Destination === home && m.RW === (kind === 'ui'))) {
    throw new Error(`Refusing foreign or changed ${kind} container`);
  }
}

export async function waitForScreens(services) {
  const deadline = Date.now() + 60000;
  const pairs = [services, ...(services.tailnet?.enabled ? [services.tailnet] : [])];
  for (const url of pairs.flatMap(pair => [pair.uiOrigin, `${pair.scottyOrigin}/api/p/factory/beads`])) {
    while (true) {
      // Synchronous backlog commands can outlive a server's idle timeout while
      // preventing Node from observing socket closure. Never pool these probes.
      try { const response = await fetch(url, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(5000) }); await response.arrayBuffer(); if (response.ok) break; } catch { /* Startup/reboot may still be in progress. */ }
      if (Date.now() > deadline) throw new Error(`Screen did not answer: ${url}; inspect dedicated container logs`);
      await delay(500);
    }
  }
}

export function screenProbeObserved(payload, probe, successor) {
  const beads = payload.beads;
  return payload.meta?.readOnly === false && Array.isArray(beads) && beads.some(bead => bead.id === `fm-${probe}`) &&
    beads.some(bead => bead.id === `fm-${successor}` && bead.dependencies?.some(edge => edge.depends_on_id === `fm-${probe}` && edge.type === 'blocks'));
}

export async function acceptScreens(home, services, wrapper) {
  await acceptScreenPair(home, services, wrapper);
  if (services.tailnet?.enabled) await acceptScreenPair(home, services.tailnet, wrapper);
}

async function acceptScreenPair(home, services, wrapper) {
  await waitForScreens(services);
  const probe = `sf-screen-check-${Date.now()}`;
  const successor = `${probe}-dep`;
  const evidence = { ui: services.uiOrigin, scotty: services.scottyOrigin, probe, checks: [] };
  const check = async (path, init) => {
    const response = await fetch(services.scottyOrigin + path, { ...init, headers: { ...init?.headers, Connection: 'close' }, signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    evidence.checks.push({ path, method: init?.method ?? 'GET', status: response.status, body: text });
    return { response, text };
  };
  let added = false;
  let dependentAdded = false;
  let nativeId;
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
    const edit = async (method, path, body) => {
      const result = await check(path, { method, headers: { Origin: services.scottyOrigin, 'Content-Type': 'application/json', cookie: 'scotty-viewer-mode=editing' }, body: JSON.stringify(body) });
      if (!result.response.ok) throw new Error(`Scotty ${method} ${path} failed: ${result.text}`);
      return JSON.parse(result.text);
    };
    const owner = payload.meta.humanActor;
    if (services.owner && owner !== services.owner) throw new Error('Scotty person changed from installation settings');
    const native = await edit('POST', '/api/p/factory/beads', { title: probe + ' native', description: 'Created in Scotty', assignee: owner });
    nativeId = native.id;
    if (!/^fm-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nativeId)) throw new Error('Scotty did not create a real Beads ticket');
    if (!wrapper(['show', nativeId.slice(3), '--full']).includes('Created in Scotty')) throw new Error('tasks-axi did not read the Scotty ticket');
    await edit('PATCH', `/api/p/factory/beads/${nativeId}`, { title: probe + ' edited', description: 'Edited in Scotty', priority: 1, assignee: owner, parent: `fm-${probe}`, labels: ['human'] });
    await edit('POST', `/api/p/factory/beads/${nativeId}/deps`, { depends_on_id: `fm-${successor}`, type: 'blocks' });
    await edit('POST', `/api/p/factory/beads/${nativeId}/comments`, { text: 'Scotty acceptance comment' });
    await edit('POST', `/api/p/factory/beads/${nativeId}/status`, { status: 'in_progress' });
    const shown = wrapper(['show', nativeId.slice(3), '--full']);
    if (!shown.includes('Edited in Scotty') || !shown.includes(probe) || !shown.includes(successor)) throw new Error('tasks-axi did not read Scotty edits and dependencies');
    wrapper(['update', nativeId.slice(3), '--title', probe + ' tasks-axi edit']);
    const updated = JSON.parse((await check(`/api/p/factory/beads/${nativeId}`)).text);
    if (updated.title !== probe + ' tasks-axi edit' || updated.assignee !== owner || !updated.labels.includes('human') ||
      !updated.comments.some(comment => comment.text === 'Scotty acceptance comment')) throw new Error('Scotty did not retain native data across a tasks-axi edit');
    const ui = await fetch(services.uiOrigin, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(5000) });
    const html = await ui.text();
    evidence.factory = { status: ui.status, body: html };
    if (!ui.ok || !html.includes('Projects')) throw new Error('Factory folder screen did not answer');
    if (!html.includes(`${services.scottyOrigin}/p/factory`)) throw new Error('Factory navigation points to the wrong Scotty origin');
    console.log(`Screen acceptance passed (${services.uiOrigin}): folder UI, tasks-axi probe/dependency in Scotty, Scotty native ticket edits and bidirectional Beads reads`);
  } finally {
    try { if (nativeId) wrapper(['rm', nativeId.slice(3)]); }
    finally {
      try { if (dependentAdded) wrapper(['rm', successor]); }
      finally {
        try { if (added) wrapper(['rm', probe]); }
        finally { writeFileSync(join(home, `data/software-factory.screens.${Date.now()}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      }
    }
  }
}
