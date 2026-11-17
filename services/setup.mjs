#!/usr/bin/env node
// Install into this standalone clone, never into another home. No cleanup on failure.
// Usage: node services/setup.mjs [--docker auto|docker|sg-docker]
//   [--claude PATH] [--codex PATH] [--ui-port PORT] [--scotty-port PORT] [--owner NAME]
//   [--check] [--help]
// Linux amd64/arm64; Node >=22.13. All persistent resources are home-owned.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { run, executable, dockerRunner, containerExists, cleanEnv, present, json, save, quote,
  installFactory, taskWrapper, acceptWithClaude, startCommand, saveMissing, replaceJson } from '../factory/scripts/home-acceptance.mjs';
import { configureTailnet, verifyTailnet } from '../factory/scripts/tailnet.mjs';
import { installFolderServices, planFolderServices, serviceNames, waitForScreens, acceptScreens, verifyFolderService } from '../factory/scripts/folder-services.mjs';
import { installExecutable } from './install-executable.mjs';

export const home = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
export const marker = join(home, 'config/software-factory.install.json');
export const pins = json(join(home, 'services/dependencies.json'));
const label = 'com.software-factory.home';
const help = `Usage: node services/setup.mjs [options]
Install/resume the complete system in this clean standalone Git checkout (Linux amd64/arm64).
Prerequisites: Node >=22.13, npm, git, bash, jq, curl, tar, tmux, flock (util-linux), Docker Engine
(starting at boot), authenticated Claude Code and Codex, and FirstMate runtime tools.
Options:
  --docker auto|docker|sg-docker  Docker access (default auto)
  --claude PATH                  Claude executable (default PATH)
  --codex PATH                   Codex executable (default PATH)
  --ui-port PORT                 Factory screens (default free loopback port)
  --scotty-port PORT             Scotty tickets (default free loopback port)
  --owner NAME                  Scotty person (default Shay; preserved on update)
  --check                       Repeat live acceptance on a completed installation
  --help                        Show help without dependencies or side effects
Setup downloads verified public dependencies, builds bundled sources and starts
three dedicated persistent containers. It ends with real claude -p acceptance.
Re-running a completed install verifies it; owned partial installs resume from checkpoints.
Private data stays inside this folder. Full acceptance logs are in data/.
When Tailscale HTTPS is available, setup adds persistent tailnet-only Serve entries
for these ports, preserving other services. Otherwise it reports why it skipped them.
No existing resource is deleted, and no Git commit is made.
`;

export function parse(argv) {
  const args = { docker: 'auto', 'ui-port': 'auto', 'scotty-port': 'auto' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !['docker', 'claude', 'codex', 'ui-port', 'scotty-port', 'owner', 'check'].includes(key) || seen.has(key)) {
      throw new Error(`Unknown or duplicate option: ${argv[i]}. Run --help.`);
    }
    seen.add(key);
    if (key === 'check') { args.check = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing --${key} value`);
    args[key] = value;
  }
  if (args.owner !== undefined && !args.owner.trim()) throw new Error('Invalid --owner');
  if (!['auto', 'docker', 'sg-docker'].includes(args.docker)) throw new Error('Invalid --docker');
  for (const key of ['ui-port', 'scotty-port']) {
    const value = args[key];
    if (value !== 'auto' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error(`Invalid --${key}`);
  }
  return args;
}

export function assertClone({ defaultBranch = true } = {}) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Setup supports Linux amd64/arm64 Unix-socket homes');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node >=22.13 is required');
  if (!existsSync(join(home, '.git')) || !lstatSync(join(home, '.git')).isDirectory()) throw new Error('Setup requires a standalone clone, not a linked worktree');
  if (run('git', ['-C', home, 'rev-parse', '--show-toplevel']) !== home) throw new Error('Repository root mismatch');
  if (run('git', ['-C', home, 'status', '--porcelain'])) throw new Error('Refusing dirty source; commit or resolve changes before setup/update');
  if (/[:\n\r]/.test(home) || Buffer.byteLength(join(home, 'beads/sql/server.sock')) > 100) throw new Error('Choose a shorter home path without colons or line breaks (Dolt Unix socket limit)');
  if (defaultBranch) {
    const branch = run('git', ['-C', home, 'symbolic-ref', '--short', 'HEAD']);
    const target = run('git', ['-C', home, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (branch !== target.replace(/^origin\//, '')) throw new Error('Refusing non-default branch for update; switch to the default branch without discarding local work');
  }
}

export function writeJson(path, value) {
  replaceJson(path, value);
}

export function inspectOwned(docker, name) {
  const [container] = JSON.parse(docker(['inspect', name]));
  if (container.Config.Labels?.[label] !== home) throw new Error(`Refusing foreign container: ${name}`);
  return container;
}

export async function build(docker) {
  for (const component of ['tools/tasks-axi', 'factory']) {
    console.log(`Building bundled ${component}`);
    console.log(run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: join(home, component) }));
    console.log(run('npm', ['run', 'build'], { cwd: join(home, component) }));
  }
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const download = join(home, '.tools/downloads');
  mkdirSync(download, { recursive: true });
  const filename = `beads_${pins.beads.version}_linux_${arch}.tar.gz`;
  const archive = join(download, filename);
  if (!existsSync(archive)) {
    console.log(`Downloading official Beads ${pins.beads.version} (${arch})`);
    run('curl', ['--fail', '--location', '--retry', '2', '--output', archive + '.partial', `${pins.beads.release}/${filename}`]);
    renameSync(archive + '.partial', archive);
  }
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== pins.beads[`linux_${arch}`]) throw new Error('Beads archive checksum mismatch; refusing extraction');
  run('tar', ['-xzf', archive, '-C', download, 'bd']);
  mkdirSync(join(home, 'beads/bin'), { recursive: true });
  installExecutable(join(download, 'bd'), join(home, 'beads/bin/bd'));
  const version = run(join(home, 'beads/bin/bd'), ['version']);
  if (!version.includes(pins.beads.version) || !version.includes(pins.beads.build)) throw new Error(`Unexpected bd version: ${version}`);
  console.log(version);
  const source = join(home, '.tools/src/scotty');
  if (!present(source)) {
    run('git', ['clone', '--no-checkout', '--filter=blob:none', '--', pins.scotty.repository, source]);
    run('git', ['-C', source, 'checkout', '--detach', pins.scotty.commit, '--']);
  }
  if (run('git', ['-C', source, 'rev-parse', 'HEAD']) !== pins.scotty.commit || run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Scotty source differs from its public pin; refusing build');
  }
  mkdirSync(join(source, '.sf'), { recursive: true });
  installExecutable(join(download, 'bd'), join(source, '.sf/bd'));
  console.log('Pulling digest-pinned public Dolt and Node images');
  console.log(docker(['pull', pins.dolt]));
  console.log(docker(['pull', pins.node]));
  const tag = `local/software-factory-${createHash('sha256').update(home).digest('hex').slice(0, 12)}:runtime`;
  console.log('Building Scotty from its pinned public source (no pre-existing local image needed)');
  console.log(docker(['build', '--build-arg', `NODE_IMAGE=${pins.node}`, '-t', tag, '-f', join(home, 'services/scotty.Dockerfile'), source]));
  return { runtime: docker(['image', 'inspect', tag, '--format', '{{.Id}}']), dolt: docker(['image', 'inspect', pins.dolt, '--format', '{{.Id}}']), bdVersion: version };
}

export async function verify(installed, docker, { replacementImages } = {}) {
  if (installed.version !== 2 || installed.state !== 'complete' || installed.home !== home) throw new Error('Invalid/incomplete installation record; refusing changes');
  for (const file of ['beads/bin/bd', 'beads/workspace/.beads/metadata.json', '.tools/bin/tasks-axi', 'factory/dist/src/index.js', 'tools/tasks-axi/dist/bin/tasks-axi.js',
    'config/software-factory.json', 'config/software-factory.agents.json', 'config/software-factory.projects.json', 'data/software-factory.acceptance.jsonl', '.claude/settings.local.json']) {
    if (!existsSync(join(home, file))) throw new Error(`Completed installation is missing ${file}`);
  }
  const config = json(join(home, 'config/software-factory.json'));
  if (config.home !== home || config.factoryRoot !== join(home, 'factory') || config.uiOrigin !== installed.services.uiOrigin || config.scottyOrigin !== installed.services.scottyOrigin) throw new Error('Installation settings do not match this home');
  const hooks = json(join(home, 'config/hooks.json'));
  const hook = hooks.hooks?.find(entry => entry.id === 'software-factory-instruction-check');
  if (hooks.version !== 1 || hook?.event !== 'worker.start.before' || hook.timeout_seconds !== 300 || JSON.stringify(hook.argv) !== JSON.stringify([join(home, 'factory/scripts/worker-start-before.mjs'), join(home, 'config/software-factory.projects.json')])) throw new Error('Factory instruction-check hook is missing or changed');
  if (realpathSync(join(home, '.claude/skills/software-factory')) !== join(home, 'factory/skills/software-factory')) throw new Error('Factory skill discovery link changed');
  const dolt = inspectOwned(docker, installed.args.container);
  if (!dolt.State.Running || dolt.Image !== installed.images.dolt || dolt.HostConfig.RestartPolicy.Name !== 'unless-stopped' || dolt.HostConfig.NetworkMode !== 'none' ||
    Object.keys(dolt.HostConfig.PortBindings ?? {}).length !== 0 || dolt.Mounts.length !== 1 ||
    !dolt.Mounts.some(m => m.Type === 'bind' && m.Source === join(home, 'beads') && m.Destination === join(home, 'beads') && m.RW)) throw new Error('Dedicated Dolt service is stopped or changed');
  for (const [kind, port, internal] of [['ui', installed.services.uiPort, installed.services.uiPort], ['scotty', installed.services.scottyPort, 3000]]) {
    const name = installed.services.names[kind];
    // Only a validated update checkpoint may allow an absent/stopped service or
    // either recorded image during the non-atomic two-container replacement.
    if (replacementImages && !containerExists(docker, name)) continue;
    const service = inspectOwned(docker, name);
    verifyFolderService(service, home, kind, port, internal,
      replacementImages ? [installed.images.runtime, replacementImages.runtime] : [installed.images.runtime],
      { editable: installed.services.editable || !!replacementImages, allowLegacy: !!replacementImages });
    if (!replacementImages && !service.State.Running) throw new Error(`Dedicated ${kind} service is stopped`);
  }
  verifyTailnet(installed.services);
  if (!replacementImages) await waitForScreens(installed.services);
}

export async function accept(installed, options) {
  await acceptScreens(home, installed.services, taskWrapper(home));
  console.log('Running automatic Claude acceptance with normal session startup');
  acceptWithClaude(home, installed.executables.claude, options);
}

export function report(installed) {
  const tailnet = installed.services.tailnet;
  console.log(`Software Factory complete: ${home}\nFactory screens: ${installed.services.uiOrigin}\nScotty: ${installed.services.scottyOrigin}/p/factory\n${tailnet?.enabled ? `Factory screens (tailnet): ${tailnet.uiOrigin}\nScotty (tailnet): ${tailnet.scottyOrigin}/p/factory` : `Tailnet not configured: ${tailnet?.reason ?? 'run the one-step factory update to enable it'}`}\n${startCommand(home, installed.executables.claude)}`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(help); return; }
  const options = parse(argv);
  assertClone({ defaultBranch: false });
  const docker = dockerRunner(options.docker);
  if (existsSync(marker)) {
    const installed = json(marker);
    if (installed.version !== 2 || installed.state !== 'complete' || installed.home !== home) throw new Error('Invalid/incomplete installation record; refusing changes');
    for (const key of ['claude', 'codex']) if (options[key] && executable(options[key], key) !== installed.executables[key]) throw new Error(`Existing installation has a different --${key}`);
    for (const key of ['ui-port', 'scotty-port']) if (options[key] !== 'auto' && String(options[key]) !== String(installed.services[key === 'ui-port' ? 'uiPort' : 'scottyPort'])) throw new Error(`Existing installation has a different --${key}`);
    if (options.owner && options.owner !== json(join(home, 'config/software-factory-services/bead-me-up-scotty/config.json')).humanActor) throw new Error('Existing installation has a different --owner; change the person in Scotty settings');
    if (installed.services.tailnet?.enabled) configureTailnet(installed.services);
    await verify(installed, docker);
    if (installed.commit !== run('git', ['-C', home, 'rev-parse', 'HEAD'])) throw new Error('Source changed since the last build; run node services/update.mjs --local to rebuild and accept the approved commit');
    if (options.check) await accept(installed, { isolatedState: true });
    report(installed);
    return;
  }
  if (options.check) throw new Error('--check requires a completed installation');
  const pending = join(home, 'state/software-factory.setup.pending.json');
  const commit = run('git', ['-C', home, 'rev-parse', 'HEAD']);
  let transaction = existsSync(pending) ? json(pending) : undefined;
  if (transaction && (transaction.version !== 1 || transaction.home !== home || transaction.commit !== commit)) {
    throw new Error('Setup checkpoint belongs to a different home or source commit; inspect state/software-factory.setup.pending.json. No data was changed');
  }
  if (!transaction) {
    // Existing FirstMate homes are valid input. Only factory-owned resources
    // need an installation transaction before they may be reused.
    for (const path of ['beads', '.tools/src/scotty', '.tools/bin/tasks-axi', 'config/software-factory.json',
      'config/software-factory.agents.json', 'config/software-factory.projects.json', 'config/software-factory-services']) {
      if (present(join(home, path))) throw new Error(`Refusing existing factory path without a setup checkpoint: ${path}; inspect it before retrying. Other home data was retained`);
    }
    if (existsSync(join(home, 'config/hooks.json'))) {
      const hooks = json(join(home, 'config/hooks.json'));
      if (hooks.version !== 1 || !Array.isArray(hooks.hooks) || hooks.hooks.some(entry => entry.id === 'software-factory-instruction-check')) {
        throw new Error('Conflicting config/hooks.json; preserve it and resolve the factory hook conflict before retrying');
      }
    }
  }
  const codex = executable(options.codex, 'codex');
  const claude = executable(options.claude, 'claude');
  for (const tool of ['npm', 'bash', 'python3', 'jq', 'curl', 'tar', 'tmux', 'git', 'gh', 'treehouse', 'no-mistakes', 'gh-axi', 'chrome-devtools-axi', 'quota-axi']) executable(undefined, tool);
  const id = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const args = transaction?.args ?? { ...options, tailnet: true, home, name: 'factory', database: 'factory_backlog', container: `sf-${id}-dolt`, factoryRoot: join(home, 'factory') };
  if (!transaction) {
    for (const name of [args.container, ...Object.values(serviceNames(args.container))]) if (containerExists(docker, name)) throw new Error(`Refusing existing container: ${name}`);
    for (const dir of ['config', 'data', 'state', 'projects']) mkdirSync(join(home, dir), { recursive: true });
    transaction = { version: 1, home, commit, args, startedAt: new Date().toISOString() };
    writeJson(pending, transaction);
  }
  const checkpoint = () => writeJson(pending, transaction);
  for (const dir of ['.tools/bin', 'beads/sql', 'beads/server']) mkdirSync(join(home, dir), { recursive: true });
  if (!transaction.images) { transaction.images = await build(docker); checkpoint(); }
  else console.log('Resuming with the already-built service images');
  const images = transaction.images;
  for (const [path, content] of [['data/projects.md', ''], ['config/crew-harness', 'codex\n']]) {
    if (!present(join(home, path))) writeFileSync(join(home, path), content, { flag: 'wx' });
  }
  saveMissing(join(home, 'config/crew-dispatch.json'), { default: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
  if (!existsSync(join(home, '.tools/bin/tasks-axi'))) writeFileSync(join(home, '.tools/bin/tasks-axi'), `#!/bin/sh\nexec "\${SF_NODE_BINARY:-${process.execPath}}" ${quote(join(home, 'tools/tasks-axi/dist/bin/tasks-axi.js'))} "$@"\n`, { flag: 'wx', mode: 0o755 });
  const socket = join(home, 'beads/sql/server.sock');
  console.log(`Starting/resuming dedicated Dolt: ${args.container}`);
  if (containerExists(docker, args.container)) {
    const container = inspectOwned(docker, args.container);
    if (container.Image !== images.dolt || container.HostConfig.NetworkMode !== 'none' ||
      !container.Mounts.some(m => m.Source === join(home, 'beads') && m.Destination === join(home, 'beads') && m.RW)) throw new Error('Refusing changed Dolt container');
    if (!container.State.Running) docker(['start', args.container]);
  } else console.log(docker(['run', '-d', '--name', args.container, '--label', `${label}=${home}`, '--restart', 'unless-stopped', '--user', `${process.getuid()}:${process.getgid()}`,
    '--network', 'none', '-e', 'HOME=/tmp', '-v', `${join(home, 'beads')}:${join(home, 'beads')}`, '-w', join(home, 'beads/server'),
    '--entrypoint', 'sh', images.dolt, '-c', `rm -f ${quote(socket)}; exec dolt sql-server --host 127.0.0.1 --port 3306 --socket ${quote(socket)}`]));
  const deadline = Date.now() + 60000;
  while (!present(socket) || !lstatSync(socket).isSocket()) {
    if (Date.now() > deadline) throw new Error(`Dolt socket did not appear; inspect with: docker logs ${args.container}`);
    await delay(250);
  }
  const workspace = join(home, 'beads/workspace');
  if (!existsSync(join(workspace, '.beads/metadata.json'))) {
    run('git', ['init', workspace]);
    console.log(run(join(home, 'beads/bin/bd'), ['init', '--server', '--external', '--server-socket', socket, '--database', args.database,
      '--prefix', 'fm', '--skip-agents', '--skip-hooks', '--non-interactive'], { cwd: workspace, env: { ...cleanEnv(), BEADS_DIR: join(workspace, '.beads'), BEADS_DOLT_AUTO_START: '0' } }));
  }
  // Persist selected ports before Serve or container mutations. A restart can
  // reuse the exact owned ports, including after a partially completed phase.
  if (!transaction.ports) { transaction.ports = await planFolderServices(args); checkpoint(); }
  console.log('Starting/resuming factory screens and Scotty');
  const services = await installFolderServices(args, docker, images.runtime, transaction.ports);
  await installFactory(join(home, 'factory'), home, codex, claude, services);
  const installed = { version: 2, state: 'complete', home, args, images, services, executables: { codex, claude }, pins,
    commit, completedAt: new Date().toISOString() };
  await accept(installed, { isolatedState: true });
  await verify(installed, docker);
  save(marker, installed);
  renameSync(pending, join(home, `data/software-factory.setup.${Date.now()}.json`));
  report(installed);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const entry = async () => {
    const argv = process.argv.slice(2);
    if ((argv.length === 1 && argv[0] === '--help') || process.env.SF_FACTORY_SETUP_LOCK === home) return main(argv);
    parse(argv);
    assertClone({ defaultBranch: false });
    executable(undefined, 'flock');
    mkdirSync(join(home, 'state'), { recursive: true });
    // Kernel-owned lock survives neither a crash nor a killed hook, so the
    // next startup can resume; simultaneous setup commands cannot race writes.
    const result = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', join(home, 'state/software-factory.setup.lock'),
      process.execPath, fileURLToPath(import.meta.url), ...argv], { stdio: 'inherit', env: { ...process.env, SF_FACTORY_SETUP_LOCK: home } });
    if (result.status === 75) throw new Error('Another setup is running for this folder; wait for it to finish, then start claude again');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  };
  entry().catch(error => { console.error(`Setup refused/failed: ${error.message}\nExisting resources were not removed. Fix the requirement above, then start claude again (or rerun node services/setup.mjs) to resume.`); process.exitCode = 1; });
}
