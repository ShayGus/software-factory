import { spawnSync } from 'node:child_process';
import { stepAgentCommand } from './agent-profiles.js';

/** A new process per call, with no worker/main session or lifecycle identity. */
export function runStepAgent(config: unknown, projectId: string, step: 'instruction_check' | 'product_review', prompt: string) {
  const command = stepAgentCommand(config, projectId, step);
  const markers = new Set(['CLAUDECODE', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !markers.has(name) && !name.startsWith('FM_') && !name.startsWith('ORCA_')));
  const result = spawnSync(command.executable, command.args, { input: prompt, encoding: 'utf8', env,
    ...(command.cwd ? { cwd: command.cwd } : {}), timeout: command.timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0 || result.signal) throw new Error(`${step}_agent_failed: ${result.error?.message ?? result.signal ?? result.status}`);
  return { stdout: result.stdout, profile: command.profile };
}
