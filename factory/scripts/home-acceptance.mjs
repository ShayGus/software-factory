// Shared installation/acceptance operations. The service installer owns lifecycle.
import { verifyClaudeEvidence } from './claude-acceptance-evidence.mjs';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export const present = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
export const saveMissing = (path, value) => { if (!present(path)) save(path, value); };
export function replaceJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  save(temp, value);
  renameSync(temp, path);
}
export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['FM_', 'BEADS_', 'TASKS_AXI_', 'CODEX_'].some((prefix) => key.startsWith(prefix)) &&
  !['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDECODE'].includes(key)));

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout?.trim() ?? '';
}

export function executable(value, name) {
  const candidates = value ? [resolve(value)] : (process.env.PATH ?? '').split(':').map((dir) => resolve(dir, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (lstatSync(realpathSync(candidate)).isFile()) return candidate; } catch { /* Try next PATH entry. */ }
  }
  const remedy = {
    node: 'install Node.js >=22.13 from https://nodejs.org/en/download',
    npm: 'install Node.js with npm from https://nodejs.org/en/download',
    claude: 'install Claude Code from https://code.claude.com/docs/en/setup, then run claude auth login',
    codex: 'npm install -g @openai/codex && codex login',
    treehouse: 'curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh',
    'no-mistakes': 'curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh',
    'gh-axi': 'npm install -g gh-axi && gh-axi setup hooks',
    'chrome-devtools-axi': 'npm install -g chrome-devtools-axi && chrome-devtools-axi setup hooks',
    'quota-axi': 'npm install -g quota-axi',
  }[name] ?? `install ${name} with your system package manager (Debian/Ubuntu: sudo apt-get install ${name === 'python3' ? 'python3' : name})`;
  throw new Error(`Missing executable ${name}. Run: ${remedy}. Then start claude again.`);
}

export function dockerRunner(mode) {
  const direct = (args) => run('docker', args);
  const grouped = (args) => run('sg', ['docker', '-c', ['docker', ...args].map(quote).join(' ')]);
  if (mode !== 'sg-docker') {
    try { direct(['info', '--format', '{{.ServerVersion}}']); return direct; }
    catch (error) { if (mode === 'docker') throw error; }
  }
  try { grouped(['info', '--format', '{{.ServerVersion}}']); }
  catch (error) { throw new Error(`Docker Engine is unavailable to this user (direct access and sg docker failed). Install/start Docker Engine, then run: sudo usermod -aG docker "$USER"; log out and back in. Test: docker info (or sg docker -c 'docker info'). Then start claude again.\n${error.message}`); }
  return grouped;
}

export function containerExists(docker, name) {
  // Listing failures remain errors, not evidence that a name is free.
  return docker(['container', 'ls', '--all', '--format', '{{.Names}}']).split('\n').includes(name);
}

export function startCommand(home, claude = 'claude') {
  // Keep simple absolute paths readable while quoting paths with shell metacharacters.
  const shellPath = (path) => /^[a-zA-Z0-9_./-]+$/.test(path) ? path : quote(path);
  return `cd ${shellPath(home)} && ${shellPath(claude)}`;
}

export async function installFactory(root, home, codex, claude, services) {
  const agentTemplate = join(home, 'config/software-factory.agents.json');
  const hookRegistry = join(home, 'config/software-factory.projects.json');
  const agents = json(join(root, 'fixtures/workflow-agents.json'));
  agents.executables = { codex, claude };
  agents.timeoutMs = 280000;
  agents.cwd = home;
  saveMissing(agentTemplate, agents);
  saveMissing(hookRegistry, { version: 1, projects: [] });
  // Validate against the installed factory's contract before enabling its hook.
  const { WorkerHookConfigSchema } = await import(pathToFileURL(join(root, 'dist/src/index.js')).href);
  WorkerHookConfigSchema.parse(json(hookRegistry));
  saveMissing(join(home, 'config/software-factory.json'), {
    factoryRoot: root, home, fork: home, agentTemplate, hookRegistry,
    mode: 'local-only', yolo: 'off', uiOrigin: services.uiOrigin, uiPort: services.uiPort,
    scottyOrigin: services.scottyOrigin, services: services.names
  });
  const hooksPath = join(home, 'config/hooks.json');
  const hooks = existsSync(hooksPath) ? json(hooksPath) : { version: 1, hooks: [] };
  if (hooks.version !== 1 || !Array.isArray(hooks.hooks)) throw new Error('Expected FirstMate version 1 hook configuration');
  const entry = { id: 'software-factory-instruction-check', event: 'worker.start.before',
    argv: [join(root, 'scripts/worker-start-before.mjs'), hookRegistry], timeout_seconds: 300 };
  const previous = hooks.hooks.find(hook => hook.id === entry.id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error('Conflicting factory hook; inspect config/hooks.json');
  if (!previous) { hooks.hooks.push(entry); replaceJson(hooksPath, hooks); }
  for (const harness of ['.agents', '.claude']) {
    const parent = join(home, harness, 'skills');
    mkdirSync(parent, { recursive: true });
    const target = join(parent, 'software-factory');
    // FirstMate's .claude/skills can already alias .agents/skills.
    if (present(target)) {
      if (realpathSync(target) !== realpathSync(join(root, 'skills/software-factory'))) throw new Error(`Conflicting skill link: ${target}`);
    } else symlinkSync(join(root, 'skills/software-factory'), target, 'dir');
  }
  const settingsPath = join(home, '.claude/settings.local.json');
  const settings = existsSync(settingsPath) ? json(settingsPath) : {};
  const path = settings.env?.PATH ?? process.env.PATH ?? '';
  if (!path.split(':').includes(join(home, '.tools/bin'))) {
    replaceJson(settingsPath, { ...settings, env: { ...settings.env, PATH: `${join(home, '.tools/bin')}:${path}` } });
  }
}

export function taskWrapper(home) {
  return argv => run('bash', [join(home, 'bin/fm-tasks-axi.sh'), ...argv], { cwd: home,
    env: { ...cleanEnv(), FM_HOME: home, PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}`, BEADS_DOLT_AUTO_START: '0' } });
}

export function acceptWithClaude(home, claude, { isolatedState = false } = {}) {
  const probe = 'sf-claude-install-check';
  const started = Date.now();
  // A chat update runs inside a live primary. Its child is a genuinely separate
  // session, so use FirstMate's existing state override instead of sharing or
  // stealing the caller's lock. Code, settings, backlog and services stay real.
  const stateDirectory = isolatedState ? join(home, 'state/software-factory-acceptance', String(started)) : join(home, 'state');
  if (isolatedState) mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const pathEvidencePath = join(home, `data/software-factory.acceptance-path.${started}.txt`);
  if (present(pathEvidencePath)) throw new Error('Refusing to reuse existing Claude path evidence');
  const prompt = `This is an installation acceptance check in ${home}, not a factory feature request.
Use the normal FirstMate session-start digest from the SessionStart hook.
If startup reports READ-ONLY or unverified fleet-lock ownership, stop before any backlog mutation and report failure. If it is absent, run bash ${quote(join(home, 'bin/fm-session-start.sh'))} once.
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
  env.SF_FACTORY_SETUP_ACTIVE = home;
  if (isolatedState) env.FM_STATE_OVERRIDE = stateDirectory;
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
  verifyClaudeEvidence(events, { home, probe, pathEvidencePath, stateDirectory });
  const remaining = run('bash', [join(home, 'bin/fm-tasks-axi.sh'), 'list'], { cwd: home,
    env: { ...cleanEnv(), FM_HOME: home, PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}` } });
  if (remaining.includes(probe)) throw new Error('Claude left its acceptance probe in the backlog');
  console.log('Claude acceptance passed: normal startup, software-factory skill, backlog add/list/rm');
}
