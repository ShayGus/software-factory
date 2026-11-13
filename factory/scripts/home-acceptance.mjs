// Shared installation/acceptance operations. The service installer owns lifecycle.
import { verifyClaudeEvidence } from './claude-acceptance-evidence.mjs';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export const present = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['FM_', 'BEADS_', 'TASKS_AXI_', 'CODEX_'].some((prefix) => key.startsWith(prefix)) &&
  !['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDECODE'].includes(key)));

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return result.stdout?.trim() ?? '';
}

export function executable(value, name) {
  const candidates = value ? [resolve(value)] : (process.env.PATH ?? '').split(':').map((dir) => resolve(dir, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (lstatSync(realpathSync(candidate)).isFile()) return candidate; } catch { /* Try next PATH entry. */ }
  }
  throw new Error(`Install/authenticate ${name}, or pass --${name} /absolute/executable`);
}

export function dockerRunner(mode) {
  const direct = (args) => run('docker', args);
  const grouped = (args) => run('sg', ['docker', '-c', ['docker', ...args].map(quote).join(' ')]);
  if (mode !== 'sg-docker') {
    try { direct(['info', '--format', '{{.ServerVersion}}']); return direct; }
    catch (error) { if (mode === 'docker') throw error; }
  }
  grouped(['info', '--format', '{{.ServerVersion}}']);
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

export function taskWrapper(home) {
  return argv => run('bash', [join(home, 'bin/fm-tasks-axi.sh'), ...argv], { cwd: home,
    env: { ...cleanEnv(), FM_HOME: home, PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}`, BEADS_DOLT_AUTO_START: '0' } });
}

export function acceptWithClaude(home, claude) {
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
