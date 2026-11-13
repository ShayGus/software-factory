#!/usr/bin/env node
// Provision only a NEW home and dedicated Docker containers. No upgrades or cleanup
// of partial homes: inspect a failed installation before removing its named resources.
// Run --help for inputs. Sources may be local Git repositories or Git URLs.
import { verifyClaudeEvidence } from './claude-acceptance-evidence.mjs';
import { installFolderServices, acceptScreens, waitForScreens, serviceNames } from './folder-services.mjs';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const help = `Usage: node scripts/setup-firstmate-home.mjs \\
  --home /absolute/new-home --name home-name --container home-name-dolt \\
  --database home_database --fork-source PATH_OR_GIT_URL \\
  --tasks-source PATH_OR_GIT_URL --factory-source PATH_OR_GIT_URL

Required: all seven options above. The home and container must not exist.
The temporary <container>-bd-extract container must not exist either.
Options:
  --crew-dispatch PATH   Owner's worker rules (default: Codex/GPT-6.1 Sol/high)
  --docker auto|docker|sg-docker   Default: auto (docker, then sg docker)
  --codex PATH           Installed executable (default: find codex on PATH)
  --claude PATH          Installed executable (default: find claude on PATH)
  --fork-ref REF         Default: fm/sf-beads-firstmate-fixes
  --tasks-ref REF        Default: main (must include the Beads backend)
  --factory-ref REF      Default: main
  --ui-port PORT        Factory screen port (default: automatic free loopback port)
  --scotty-port PORT    Scotty port (default: automatic free loopback port)
  --check               Re-run screen and live Claude acceptance on a completed home
  --help                Show this help

Prerequisites: Linux, Node >=22.13, npm, Git with commit identity, Docker,
authenticated Codex/Claude, and images local/scotty:v0.4.0-cf6dda1 and
dolthub/dolt:2.7.2. No pnpm required. Images are not pulled automatically.
Setup creates dedicated Dolt, guarded Scotty and factory UI containers with
unless-stopped restart policies. The Docker daemon must start at boot.
Their loopback addresses and the Claude launch command are printed at completion.
The final acceptance check spends a real Claude session (claude -p), using
normal project/local settings and hooks. It must complete startup, load the
factory skill and add/list/remove a probe through this home's task wrapper.
Its full output is saved under the home's data/software-factory.acceptance.*.
Re-running the same command on a completed, intact home reports complete.
Partial/existing homes and containers are refused, never overwritten.
The final line prints the exact command for starting Claude in this home.
`;
const bdImage = 'local/scotty:v0.4.0-cf6dda1';
const doltImage = 'dolthub/dolt:2.7.2';
const markerName = 'config/software-factory.install.json';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const present = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['FM_', 'BEADS_', 'TASKS_AXI_', 'CODEX_'].some((prefix) => key.startsWith(prefix)) &&
  !['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDECODE'].includes(key)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return result.stdout?.trim() ?? '';
}

function executable(value, name) {
  const candidates = value ? [resolve(value)] : (process.env.PATH ?? '').split(':').map((dir) => resolve(dir, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (lstatSync(realpathSync(candidate)).isFile()) return candidate; } catch { /* Try next PATH entry. */ }
  }
  throw new Error(`Install/authenticate ${name}, or pass --${name} /absolute/executable`);
}

function dockerRunner(mode) {
  const direct = (args) => run('docker', args);
  const grouped = (args) => run('sg', ['docker', '-c', ['docker', ...args].map(quote).join(' ')]);
  if (mode !== 'sg-docker') {
    try { direct(['info', '--format', '{{.ServerVersion}}']); return direct; }
    catch (error) { if (mode === 'docker') throw error; }
  }
  grouped(['info', '--format', '{{.ServerVersion}}']);
  return grouped;
}

function containerExists(docker, name) {
  // Listing failures remain errors, not evidence that a name is free.
  return docker(['container', 'ls', '--all', '--format', '{{.Names}}']).split('\n').includes(name);
}

function parse(argv) {
  if (argv.includes('--help')) { console.log(help); return; }
  const allowed = ['home', 'name', 'container', 'database', 'fork-source', 'tasks-source', 'factory-source',
    'crew-dispatch', 'docker', 'codex', 'claude', 'fork-ref', 'tasks-ref', 'factory-ref', 'ui-port', 'scotty-port'];
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || key in args) {
      throw new Error(`Unknown, duplicate, or missing-value option: ${argv[i]}. Run --help.`);
    }
    args[key] = argv[i + 1];
  }
  for (const key of allowed.slice(0, 7)) if (!args[key]) throw new Error(`Missing --${key}. Run --help.`);
  if (!isAbsolute(args.home) || resolve(args.home) === '/') throw new Error('--home must be an absolute new directory');
  // Canonicalize the existing parent, so symlinked parents cannot disguise reuse.
  args.home = join(realpathSync(dirname(resolve(args.home))), basename(resolve(args.home)));
  if (/[:\n\r]/.test(args.home)) throw new Error('--home must not contain colons or line breaks (Docker volume and PATH addressing)');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(args.name)) throw new Error('Invalid --name: use letters, numbers, underscores or hyphens');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(args.container)) throw new Error('Invalid --container');
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(args.database)) throw new Error('Invalid --database: use an SQL identifier');
  if (Buffer.byteLength(join(args.home, 'beads/sql/server.sock')) > 100) throw new Error('--home is too long for the Dolt Unix socket; choose a shorter path');
  for (const key of ['ui-port', 'scotty-port']) {
    args[key] ??= 'auto';
    if (args[key] !== 'auto' && (!/^[0-9]+$/.test(args[key]) || Number(args[key]) < 1 || Number(args[key]) > 65535)) throw new Error(`Invalid --${key}`);
  }
  args.docker ??= 'auto';
  if (!['auto', 'docker', 'sg-docker'].includes(args.docker)) throw new Error('Invalid --docker');
  args['fork-ref'] ??= 'fm/sf-beads-firstmate-fixes';
  args['tasks-ref'] ??= 'main';
  args['factory-ref'] ??= 'main';
  for (const kind of ['fork', 'tasks', 'factory']) {
    const source = args[`${kind}-source`];
    if (existsSync(source)) args[`${kind}-source`] = realpathSync(source);
    if (source.startsWith('-') || args[`${kind}-ref`].startsWith('-')) throw new Error('Sources and refs must not start with a dash');
  }
  if (args['crew-dispatch']) args['crew-dispatch'] = realpathSync(args['crew-dispatch']);
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
}

function startCommand(home) {
  // Keep simple absolute paths readable while quoting paths with shell metacharacters.
  const shellPath = (path) => /^[a-zA-Z0-9_./-]+$/.test(path) ? path : quote(path);
  return `cd ${shellPath(home)} && claude`;
}

async function installFactory(root, home, codex, claude, services) {
  const agentTemplate = join(home, 'config/software-factory.agents.json');
  const hookRegistry = join(home, 'config/software-factory.projects.json');
  const agents = json(join(root, 'fixtures/workflow-agents.json'));
  agents.executables = { codex, claude };
  agents.timeoutMs = 280000;
  agents.cwd = home;
  save(agentTemplate, agents);
  save(hookRegistry, { version: 1, projects: [] });
  // Validate against the installed factory's contract before enabling its hook.
  const { WorkerHookConfigSchema } = await import(pathToFileURL(join(root, 'dist/src/index.js')).href);
  WorkerHookConfigSchema.parse(json(hookRegistry));
  save(join(home, 'config/software-factory.json'), {
    factoryRoot: root, home, fork: home, agentTemplate, hookRegistry,
    mode: 'local-only', yolo: 'off', uiOrigin: services.uiOrigin, uiPort: services.uiPort,
    scottyOrigin: services.scottyOrigin, services: services.names
  });
  const hooksPath = join(home, 'config/hooks.json');
  const hooks = existsSync(hooksPath) ? json(hooksPath) : { version: 1, hooks: [] };
  if (hooks.version !== 1 || !Array.isArray(hooks.hooks)) throw new Error('Expected FirstMate version 1 hook configuration');
  if (hooks.hooks.some((entry) => entry.id === 'software-factory-instruction-check')) throw new Error('Factory hook already exists in source home');
  hooks.hooks.push({ id: 'software-factory-instruction-check', event: 'worker.start.before',
    argv: [join(root, 'scripts/worker-start-before.mjs'), hookRegistry], timeout_seconds: 300 });
  // A source containing local configuration is not a clean fork; never overwrite it.
  save(hooksPath, hooks);
  for (const harness of ['.agents', '.claude']) {
    const parent = join(home, harness, 'skills');
    mkdirSync(parent, { recursive: true });
    const target = join(parent, 'software-factory');
    // FirstMate's .claude/skills can already alias .agents/skills.
    if (present(target)) {
      if (realpathSync(target) !== realpathSync(join(root, 'skills/software-factory'))) throw new Error(`Conflicting skill link: ${target}`);
    } else symlinkSync(join(root, 'skills/software-factory'), target, 'dir');
  }
  save(join(home, '.claude/settings.local.json'), { env: { PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}` } });
}

function taskWrapper(home) {
  return argv => run('bash', [join(home, 'bin/fm-tasks-axi.sh'), ...argv], { cwd: home,
    env: { ...cleanEnv(), FM_HOME: home, PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}`, BEADS_DOLT_AUTO_START: '0' } });
}

function acceptWithClaude(home, claude) {
  const probe = 'sf-claude-install-check';
  const started = Date.now();
  const pathEvidencePath = join(home, `data/software-factory.acceptance-path.${started}.txt`);
  if (present(pathEvidencePath)) throw new Error('Refusing to reuse existing Claude path evidence');
  const prompt = `This is an installation acceptance check in ${home}, not a factory feature request.
Use the normal FirstMate session-start digest from the SessionStart hook. If it is absent, run bash ${quote(join(home, 'bin/fm-session-start.sh'))} once.
Do not start workers, create projects, run factory phases, change source, install tools, update shared services, or inspect another home's state.
Load the software-factory skill with the Skill tool solely to confirm it is available; do not execute its workflow.
Use Bash to run this command without changing PATH; the evidence file must contain only the command's stdout:
command -v tasks-axi > ${quote(pathEvidencePath)}
The path in that file must be exactly ${quote(join(home, '.tools/bin/tasks-axi'))}.
Then run these commands separately, checking each exit code and reading each result:
bash ${quote(join(home, 'bin/fm-tasks-axi.sh'))} add ${probe} 'Claude installation acceptance'
bash ${quote(join(home, 'bin/fm-tasks-axi.sh'))} list
bash ${quote(join(home, 'bin/fm-tasks-axi.sh'))} rm ${probe}
The list must contain ${probe}. Confirm normal session start completed and the software-factory skill loaded.
Report the result and any command failure. Setup checks machine evidence, not your final wording.`;
  // A setup launched by a worker must not route its child session into that
  // worker's home/inbox. Leave PATH unchanged: Claude's installed local settings
  // must supply the tasks-axi shim, just as they will on an ordinary launch.
  const env = cleanEnv();
  const result = spawnSync(claude, ['--tools', 'Bash,Read,Skill', '-p', prompt, '--verbose', '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions'], {
    cwd: home, env, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024
  });
  const log = join(home, `data/software-factory.acceptance${existsSync(join(home, 'data/software-factory.acceptance.jsonl')) ? `.${started}` : ''}`);
  writeFileSync(log + '.jsonl', result.stdout ?? '', { flag: 'wx', mode: 0o600 });
  writeFileSync(log + '.stderr', result.stderr ?? '', { flag: 'wx', mode: 0o600 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0 || result.error) throw new Error(`Claude acceptance failed: ${result.error?.message ?? `exit ${result.status}`}`);
  const events = (result.stdout ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  verifyClaudeEvidence(events, { home, probe, pathEvidencePath });
  const remaining = run('bash', [join(home, 'bin/fm-tasks-axi.sh'), 'list'], { cwd: home,
    env: { ...cleanEnv(), FM_HOME: home, PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}` } });
  if (remaining.includes(probe)) throw new Error('Claude left its acceptance probe in the backlog');
  console.log('Claude acceptance passed: normal startup, software-factory skill, backlog add/list/rm');
}

async function verifyCompleted(args, docker) {
  const home = args.home;
  const marker = join(home, markerName);
  if (!existsSync(marker)) throw new Error(`Refusing existing home: ${home} (no completion record)`);
  const installed = json(marker);
  if (installed.version !== 1 || installed.state !== 'complete' || JSON.stringify(installed.inputs) !== JSON.stringify(args)) {
    throw new Error('Existing home has different setup inputs or is incomplete; refusing to change it');
  }
  for (const file of ['.tasks.toml', 'data/projects.md', 'config/crew-harness', '.tools/bin/tasks-axi',
    'beads/bin/bd', 'beads/workspace/.beads/metadata.json', '.tools/software-factory/dist/src/index.js',
    'config/software-factory.json', 'config/software-factory.agents.json', 'config/software-factory.projects.json',
    '.claude/settings.local.json', 'data/software-factory.acceptance.jsonl', 'state/.session-start-complete']) {
    if (!existsSync(join(home, file))) throw new Error(`Completed home is missing ${file}; refusing repair`);
  }
  for (const harness of ['.agents', '.claude']) {
    if (realpathSync(join(home, harness, 'skills/software-factory')) !== realpathSync(join(home, '.tools/software-factory/skills/software-factory'))) {
      throw new Error('Completed home has a changed factory skill link');
    }
  }
  const hook = json(join(home, 'config/hooks.json')).hooks.find((entry) => entry.id === 'software-factory-instruction-check');
  if (hook?.event !== 'worker.start.before' || hook.timeout_seconds !== 300 ||
      JSON.stringify(hook.argv) !== JSON.stringify([join(home, '.tools/software-factory/scripts/worker-start-before.mjs'), join(home, 'config/software-factory.projects.json')])) {
    throw new Error('Completed home has a missing or changed factory hook');
  }
  const [container] = JSON.parse(docker(['inspect', args.container]));
  if (!container.State.Running || container.Image !== installed.images[doltImage] ||
      container.HostConfig.RestartPolicy.Name !== 'unless-stopped' || container.HostConfig.NetworkMode !== 'none' ||
      !container.Mounts.some((mount) => mount.Source === join(home, 'beads') && mount.Destination === join(home, 'beads'))) {
    throw new Error('Completed home needs its original running Dolt container; refusing to change containers');
  }
  const services = installed.services;
  if (!services) throw new Error('Completed home predates folder screens; refusing an implicit upgrade');
  for (const [kind, image, port, internal] of [['scotty', installed.images[bdImage], services.scottyPort, 3000],
    ['ui', services.runtimeImage, services.uiPort, services.uiPort]]) {
    const [service] = JSON.parse(docker(['inspect', services.names[kind]]));
    const bindings = service.HostConfig.PortBindings[`${internal}/tcp`];
    if (!service.State.Running || service.Image !== image || service.HostConfig.RestartPolicy.Name !== 'unless-stopped' ||
      !bindings || bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== String(port) ||
      !service.Mounts.some(mount => mount.Source === home && mount.Destination === home && mount.RW === (kind === 'ui'))) {
      throw new Error(`Completed home needs its original running ${kind} container; refusing to change containers`);
    }
  }
  const settings = json(join(home, 'config/software-factory.json'));
  if (settings.uiOrigin !== services.uiOrigin || settings.scottyOrigin !== services.scottyOrigin ||
    settings.hookRegistry !== join(home, 'config/software-factory.projects.json')) throw new Error('Completed home has changed screen settings');
  await waitForScreens(services);
  console.log(`Software Factory home complete: ${home}`);
  console.log(`Factory screens: ${services.uiOrigin}`);
  console.log(`Scotty (read-only): ${services.scottyOrigin}/p/factory`);
  console.log(startCommand(home));
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const args = parse(argv.filter((value) => value !== '--check'));
  if (!args) return;
  if (process.platform !== 'linux' || process.getuid === undefined) throw new Error('This setup reproduces the Linux Unix-socket configuration');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node >=22.13 is required');
  // An unowned existing path must be refused even when Docker is unavailable.
  if (present(args.home) && (!lstatSync(args.home).isDirectory() || lstatSync(args.home).isSymbolicLink() || !existsSync(join(args.home, markerName)))) {
    throw new Error(`Refusing existing home: ${args.home}`);
  }
  const docker = dockerRunner(args.docker);
  if (present(args.home)) {
    await verifyCompleted(args, docker);
    if (check) {
      await acceptScreens(args.home, json(join(args.home, markerName)).services, taskWrapper(args.home));
      acceptWithClaude(args.home, executable(args.claude, 'claude'));
    }
    return;
  }
  if (check) throw new Error('--check requires a completed home');
  const extractName = `${args.container}-bd-extract`;
  for (const name of [args.container, extractName, ...Object.values(serviceNames(args.container))]) if (containerExists(docker, name)) throw new Error(`Refusing existing container: ${name}`);
  const codex = executable(args.codex, 'codex');
  const claude = executable(args.claude, 'claude');
  if (args['crew-dispatch']) json(args['crew-dispatch']);
  run('npm', ['--version']);
  run('git', ['var', 'GIT_AUTHOR_IDENT']);
  run('git', ['var', 'GIT_COMMITTER_IDENT']);
  const images = {};
  for (const image of [bdImage, doltImage]) images[image] = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  // Check every source ref before allocating the home or a container.
  for (const kind of ['fork', 'tasks', 'factory']) {
    const ref = args[`${kind}-ref`];
    if (!run('git', ['ls-remote', '--exit-code', '--', args[`${kind}-source`], `refs/heads/${ref}`, `refs/tags/${ref}`])) {
      throw new Error(`Missing ${kind} ref: ${ref}`);
    }
  }
  mkdirSync(args.home); // Exclusive reservation; a concurrent creator is refused.
  const home = args.home;
  const revisions = {};
  const clone = (kind, destination) => {
    run('git', ['clone', '--no-hardlinks', '--branch', args[`${kind}-ref`], '--', args[`${kind}-source`], destination]);
    revisions[kind] = run('git', ['-C', destination, 'rev-parse', 'HEAD']);
  };
  console.log(`Creating FirstMate home: ${home}`);
  clone('fork', home);
  // Normal FirstMate bootstrap requires its primary checkout on the default
  // branch. Keep the selected fork fixes as main's baseline in this new clone.
  run('git', ['-C', home, 'checkout', '-B', 'main', '--']);
  // This tracked file is intentionally replaced only inside our newly cloned home.
  writeFileSync(join(home, '.tasks.toml'), `backend = "beads"\n[beads]\npath = "beads/workspace/.beads"\nbinary = "beads/bin/bd"\nprefix = "fm"\ndatabase = "${args.database}"\nserver_socket = "beads/sql/server.sock"\nserver_user = "root"\ntimeout_ms = 15000\ndone_keep = 10\n`);
  run('git', ['-C', home, 'add', '.tasks.toml']);
  run('git', ['-C', home, 'commit', '-m', `Configure ${args.name} Beads backlog`]);
  for (const dir of ['data', 'state', 'config', 'projects', 'beads/bin', 'beads/sql', 'beads/server', '.tools/bin']) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, 'data/projects.md'), '', { flag: 'wx' });
  writeFileSync(join(home, 'config/crew-harness'), 'codex\n', { flag: 'wx' });
  if (args['crew-dispatch']) copyFileSync(args['crew-dispatch'], join(home, 'config/crew-dispatch.json'), constants.COPYFILE_EXCL);
  else save(join(home, 'config/crew-dispatch.json'), { default: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
  const exclude = join(home, '.git/info/exclude');
  writeFileSync(exclude, readFileSync(exclude, 'utf8') + '\nbeads/\n.agents/skills/software-factory\n.claude/skills/software-factory\n');
  console.log('Extracting and checking bd 1.1.0');
  const extraction = docker(['create', '--name', extractName, '--entrypoint', 'bd', bdImage]);
  try { docker(['cp', `${extraction}:/usr/local/bin/bd`, join(home, 'beads/bin/bd')]); }
  finally { docker(['rm', extraction]); }
  const bd = join(home, 'beads/bin/bd');
  const version = run(bd, ['version']);
  console.log(version);
  if (!/\b1\.1\.0\b/.test(version) || !version.includes('8e4e59d39f34')) throw new Error('Expected bd 1.1.0 build 8e4e59d39f34');
  const socket = join(home, 'beads/sql/server.sock');
  console.log(`Starting dedicated Dolt 2.7.2 container: ${args.container}`);
  docker(['run', '-d', '--name', args.container, '--restart', 'unless-stopped', '--user', `${process.getuid()}:${process.getgid()}`,
    '--network', 'none', '-e', 'HOME=/tmp', '-v', `${join(home, 'beads')}:${join(home, 'beads')}`, '-w', join(home, 'beads/server'),
    '--entrypoint', 'sh', doltImage, '-c', `rm -f ${quote(socket)}; exec dolt sql-server --host 127.0.0.1 --port 3306 --socket ${quote(socket)}`]);
  const deadline = Date.now() + 60000;
  while (!present(socket) || !lstatSync(socket).isSocket()) {
    if (Date.now() > deadline) throw new Error(`Dolt socket did not appear; inspect docker logs ${args.container}`);
    await delay(250);
  }
  const workspace = join(home, 'beads/workspace');
  run('git', ['init', workspace]);
  const beadsEnv = { ...cleanEnv(), BEADS_DIR: join(workspace, '.beads'), BEADS_DOLT_AUTO_START: '0' };
  console.log(run(bd, ['init', '--server', '--external', '--server-socket', socket, '--database', args.database,
    '--prefix', 'fm', '--skip-agents', '--skip-hooks', '--non-interactive'], { cwd: workspace, env: beadsEnv }));
  console.log(run(bd, ['stats'], { cwd: workspace, env: beadsEnv }));
  console.log('Building tasks-axi main with npm and tsc');
  const tasks = join(home, '.tools/tasks-axi');
  clone('tasks', tasks);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tasks });
  run(join(tasks, 'node_modules/.bin/tsc'), [], { cwd: tasks });
  writeFileSync(join(home, '.tools/bin/tasks-axi'), `#!/bin/sh\nexec \"\${SF_NODE_BINARY:-${process.execPath}}\" ${quote(join(tasks, 'dist/bin/tasks-axi.js'))} "$@"\n`, { flag: 'wx', mode: 0o755 });
  const env = { ...cleanEnv(), FM_HOME: home, PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}`, BEADS_DOLT_AUTO_START: '0' };
  const wrapper = (argv) => run('bash', [join(home, 'bin/fm-tasks-axi.sh'), ...argv], { cwd: home, env });
  const probeId = 'sf-install-check';
  for (const argv of [['add', probeId, 'Software Factory installation check'], ['hold', probeId, '--reason', 'Installation verification', '--kind', 'captain'], ['rm', probeId]]) {
    console.log(`fm-tasks-axi.sh ${argv.join(' ')}\n${wrapper(argv)}`);
  }
  console.log('Building and installing Software Factory');
  const factory = join(home, '.tools/software-factory');
  clone('factory', factory);
  run('npm', ['ci'], { cwd: factory });
  run('npm', ['run', 'build'], { cwd: factory });
  console.log('Installing persistent folder screens');
  const services = await installFolderServices(args, docker, images[bdImage]);
  await installFactory(factory, home, codex, claude, services);
  await acceptScreens(home, services, wrapper);
  console.log('Running automatic Claude acceptance with normal session startup');
  acceptWithClaude(home, claude);
  save(join(home, markerName), { version: 1, state: 'complete', inputs: args, revisions, images, services,
    bdVersion: version, homeCommit: run('git', ['-C', home, 'rev-parse', 'HEAD']), completedAt: new Date().toISOString() });
  await verifyCompleted(args, docker);
}

main().catch((error) => {
  console.error(`Setup refused/failed: ${error.message}\nNo existing resources were removed. Inspect any newly created home/container before cleanup.`);
  process.exitCode = 1;
});
