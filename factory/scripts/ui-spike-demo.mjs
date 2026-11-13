#!/usr/bin/env node
// Prepared BUILD-05 demonstration. Do not invoke during automated tests.
// Run only via the task's external run-demo.sh (sg docker -c ...).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] ?? '');
const { prepareTasksAxi } = await import(pathToFileURL(join(repo, 'scripts/prepare-spike-tasks-axi.mjs')).href);
const { seedSpike, exerciseSpike } = await import(pathToFileURL(join(repo, 'scripts/ui-spike-scenario.mjs')).href);
const { writeScottyReader, writeScottyLauncher } = await import(pathToFileURL(join(repo, 'scripts/scotty-spike-reader.mjs')).href);
const { createSpikeRequestHandler } = await import(pathToFileURL(join(repo, 'scripts/ui-spike-http.mjs')).href);
const parent = '/home/shayg/fm-homes/linux-mate/data/sf-build-05';
const root = mkdtempSync(join(parent, 'live-'));
const suffix = `${process.pid}-${Date.now()}`;
const names = { sql: `sf-build05-sql-${suffix}`, scotty: `sf-build05-scotty-${suffix}`, extract: `sf-build05-extract-${suffix}` };
const image = 'local/scotty:v0.4.0-cf6dda1';
const dolt = 'dolthub/dolt@sha256:1abcdd77083cc7dedce01f91d1314b48e55e5bdd512c575f086b929494c77a31';
const socket = join(root, 'sql/server.sock');
const workspace = join(root, 'workspace');
const database = `sf_build05_${suffix.replaceAll('-', '_')}`;
const canonicalUrl = 'http://127.0.0.1:3185/canonical';
const created = new Set();
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...options }).trim();
const docker = (...args) => run('docker', args);
let store, server;
const cleanup = () => {
  server?.close(); store?.close();
  for (const name of [...created].reverse()) spawnSync('docker', ['rm', '-f', name], { timeout: 15000, stdio: 'ignore' });
};
process.once('SIGINT', () => { cleanup(); process.exit(0); });
process.once('SIGTERM', () => { cleanup(); process.exit(0); });
try {
  // Existing images only. No pull, build, volume reuse, registry lookup or model.
  docker('image', 'inspect', image);
  docker('image', 'inspect', dolt);
  mkdirSync(join(root, 'sql'));
  docker('run', '--pull', 'never', '--rm', '-d', '--name', names.sql, '--network', 'none',
    '-v', `${root}:${root}:z`, '-w', join(root, 'sql'), dolt,
    'sql-server', '--host', '127.0.0.1', '--port', '3306', '--socket', socket);
  created.add(names.sql);
  const deadline = Date.now() + 15000;
  while (!existsSync(socket) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!existsSync(socket)) throw new Error('scratch_sql_socket_not_ready');
  docker('exec', names.sql, 'chmod', '777', socket);
  docker('create', '--pull', 'never', '--name', names.extract, '--network', 'none', '--entrypoint', 'bd', image, 'version');
  created.add(names.extract);
  const bd = join(root, 'bd');
  docker('cp', `${names.extract}:/usr/local/bin/bd`, bd);
  chmodSync(bd, 0o755);
  mkdirSync(workspace);
  run('git', ['-C', workspace, 'init', '-q']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BEADS_|BD_|FM_|TASKS_AXI_)/.test(key)));
  Object.assign(env, { BEADS_DIR: join(workspace, '.beads'), BEADS_DOLT_AUTO_START: '0' });
  run(bd, ['init', '--server', '--external', '--server-socket', socket, '--database', database,
    '--prefix', 'fm', '--skip-agents', '--skip-hooks', '--non-interactive'], { cwd: workspace, env });
  const prepared = prepareTasksAxi(join(root, 'tasks-axi-main'));
  const cli = join(root, 'scratch-tasks.cjs');
  writeFileSync(cli, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASKS_AXI_|BEADS_|BD_)/.test(k)));
env.HOME = ${JSON.stringify(root)};
const r = spawnSync(process.execPath, [${JSON.stringify(prepared.executable)}, ...process.argv.slice(2)],
  {cwd: ${JSON.stringify(workspace)}, env, stdio:'inherit'});
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(join(workspace, '.tasks.toml'), `backend = "beads"\n[beads]\npath = ${JSON.stringify(join(workspace, '.beads'))}\nbinary = ${JSON.stringify(bd)}\nprefix = "fm"\ndatabase = ${JSON.stringify(database)}\nserver_socket = ${JSON.stringify(socket)}\nserver_user = "root"\ntimeout_ms = 15000\ndone_keep = 10\n`);
  const seeded = seedSpike(join(root, 'toolkit.sqlite'), { fmHome: workspace, tasksExecutable: cli });
  store = seeded.store;
  const transcript = exerciseSpike(seeded.api);
  writeFileSync(join(root, 'round-trips.json'), JSON.stringify(transcript, null, 2));
  writeFileSync(join(root, 'toolkit-export.json'), JSON.stringify(store.exportProject('project-1'), null, 2));
  // API listens only locally. This is a JSON contract spike, not the final editor.
  server = createServer(createSpikeRequestHandler(seeded.api));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3185, '127.0.0.1', resolve); });
  const reader = join(root, 'scotty-bd.cjs');
  writeScottyReader(reader, { workspace: join(workspace, '.beads'), socket, database, canonicalUrl });
  const launcher = join(root, 'scotty-launch.mjs');
  writeScottyLauncher(launcher, canonicalUrl);
  const config = join(root, 'config/bead-me-up-scotty');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ humanActor: 'BUILD-05 scratch', humanAllowlist: [], pollIntervalMs: 5000,
    projects: [{ id: 'sf-build05', name: 'BUILD-05 scratch — one feature', path: workspace,
      addedAt: new Date().toISOString(), lastOpened: new Date().toISOString() }], orders: {}, gamification: false }));
  docker('run', '--pull', 'never', '--rm', '-d', '--name', names.scotty,
    '--user', `${process.getuid()}:${process.getgid()}`, '-p', '127.0.0.1:3186:3000',
    '-v', `${root}:${root}:z`, '-e', `BEADS_REPO=${workspace}`, '-e', `BEADS_FS_ROOT=${workspace}`,
    '-e', `XDG_CONFIG_HOME=${join(root, 'config')}`, '-e', `BD_BIN=${reader}`, '-e', 'SCOTTY_READ_ONLY=1',
    '-e', 'POSTHOG_KEY=', '--entrypoint', 'node', image, launcher);
  created.add(names.scotty);
  writeFileSync(join(root, 'proof.json'), JSON.stringify({ root, database, names, tasksAxi: prepared.revision,
    canonicalUrl, scotty: 'http://127.0.0.1:3186/p/sf-build05', status: 'scenario seeded; browser verification still required' }, null, 2));
  console.log(`Scratch only: http://127.0.0.1:3186/p/sf-build05\nCanonical API: ${canonicalUrl}\nEvidence: ${root}\nCtrl-C removes only these named containers; scratch evidence is retained.`);
} catch (error) { cleanup(); throw error; }
