import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stepAgentCommand, type ExecutedAgentStep } from './agent-profiles.js';

export type PlanningSession = { cwd: string; id?: string };

type AgentInput = {
  evidence: unknown;
  runDirectory?: string | undefined;
  requestFile?: string;
  repositories?: string[] | undefined;
  planningSession?: PlanningSession;
};

/** A new process per turn. A planning session belongs solely to this run. */
export function runStepAgent(config: unknown, projectId: string, step: ExecutedAgentStep, directions: string,
  input: AgentInput): { stdout: string; profile: ReturnType<typeof stepAgentCommand>['profile']; sessionId?: string } {
  const { requestFile, repositories, planningSession } = input;
  const runDirectory = input.runDirectory === undefined ? undefined : resolve(input.runDirectory);
  const directory = mkdtempSync(join(runDirectory ?? tmpdir(), `${step}-agent-`));
  const evidence = join(directory, 'input.json');
  const stderrPath = join(directory, 'agent.stderr');
  const stdoutPath = join(directory, 'agent.stdout');
  const lastMessagePath = join(directory, 'last-message.json');
  const command = stepAgentCommand(config, projectId, step, planningSession && { ...planningSession, outputPath: lastMessagePath });
  const cwd = command.cwd ?? planningSession?.cwd ?? directory;
  const finish = (stdout: string) => {
    let sessionId = command.sessionId;
    if (planningSession && command.profile.harness === 'codex') {
      try {
        sessionId = undefined;
        for (const line of stdout.trim().split('\n')) {
          const event = JSON.parse(line);
          if (event.type !== 'thread.started') continue;
          if (typeof event.thread_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(event.thread_id) ||
            (command.sessionId && command.sessionId !== event.thread_id)) throw new Error('unexpected planning thread');
          sessionId = event.thread_id;
          break;
        }
        if (!sessionId) throw new Error('missing planning thread');
        stdout = readFileSync(lastMessagePath, 'utf8');
      } catch (error) {
        writeFileSync(stdoutPath, stdout);
        throw new Error(`${step}_agent_session_failed: ${String(error)}; inspect ${stdoutPath}`);
      }
    }
    if (planningSession && sessionId) planningSession.id = sessionId;
    if (!runDirectory) rmSync(directory, { recursive: true });
    return { stdout, profile: command.profile, ...(sessionId ? { sessionId } : {}) };
  };
  writeFileSync(evidence, JSON.stringify(input.evidence, null, 2) + '\n');
  const prompt = directions.trimEnd() + '\nRead the evidence JSON at the absolute path below using read-only tools.\n' +
    JSON.stringify({ evidence, runDirectory: runDirectory ?? directory, requestFile, repositories }) + '\n';
  const markers = new Set(['CLAUDECODE', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !markers.has(name) && !name.startsWith('FM_') && !name.startsWith('ORCA_')));
  const result = spawnSync(command.executable, command.args, { input: prompt, encoding: 'utf8', env,
    cwd, timeout: command.timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0 || result.signal) {
    writeFileSync(stderrPath, result.stderr ?? '');
    writeFileSync(stdoutPath, result.stdout ?? '');
    throw new Error(`${step}_agent_failed: ${result.error?.message ?? result.signal ?? result.status}; inspect ${stderrPath}`);
  }
  return finish(result.stdout);
}
