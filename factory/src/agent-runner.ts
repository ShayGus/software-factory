import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stepAgentCommand, type ExecutedAgentStep } from './agent-profiles.js';

type AgentInput = {
  evidence: unknown;
  runDirectory?: string | undefined;
  requestFile?: string;
  repositories?: string[] | undefined;
};

/** A new process per call, with no worker/main session or lifecycle identity. */
export function runStepAgent(config: unknown, projectId: string, step: ExecutedAgentStep, directions: string, input: AgentInput) {
  const command = stepAgentCommand(config, projectId, step);
  const { requestFile, repositories } = input;
  const runDirectory = input.runDirectory === undefined ? undefined : resolve(input.runDirectory);
  const directory = mkdtempSync(join(runDirectory ?? tmpdir(), `${step}-agent-`));
  const evidence = join(directory, 'input.json');
  writeFileSync(evidence, JSON.stringify(input.evidence, null, 2) + '\n');
  const prompt = directions.trimEnd() + '\nRead the evidence JSON at the absolute path below using read-only tools.\n' +
    JSON.stringify({ evidence, runDirectory: runDirectory ?? directory, requestFile, repositories }) + '\n';
  const markers = new Set(['CLAUDECODE', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !markers.has(name) && !name.startsWith('FM_') && !name.startsWith('ORCA_')));
  const result = spawnSync(command.executable, command.args, { input: prompt, encoding: 'utf8', env,
    cwd: command.cwd ?? directory, timeout: command.timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0 || result.signal) {
    const stderr = join(directory, 'agent.stderr');
    writeFileSync(stderr, result.stderr ?? '');
    writeFileSync(join(directory, 'agent.stdout'), result.stdout ?? '');
    throw new Error(`${step}_agent_failed: ${result.error?.message ?? result.signal ?? result.status}; inspect ${stderr}`);
  }
  if (!runDirectory) rmSync(directory, { recursive: true });
  return { stdout: result.stdout, profile: command.profile };
}
