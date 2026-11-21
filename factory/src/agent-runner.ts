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

/** A failed turn receives its own diagnostic before the next attempt. */
export function retryAgentTurn<T>(maxRevisionRounds: number, turn: (round: number, feedback?: string) => T): T {
  let feedback: string | undefined;
  for (let round = 0; ; round++) {
    try { return turn(round, feedback); }
    catch (error) {
      if (round === maxRevisionRounds) throw error;
      feedback = error instanceof Error ? error.message : String(error);
    }
  }
}

export function runJudgmentAgent<T>(config: unknown, projectId: string, step: 'instruction_check' | 'product_review',
  directions: string, input: AgentInput, maxRevisionRounds: number, parse: (output: string) => T) {
  const session = maxRevisionRounds ? { cwd: input.runDirectory ?? tmpdir() } : undefined;
  return retryAgentTurn(maxRevisionRounds, (_round, feedback) => {
    const result = runStepAgent(config, projectId, step, directions, {
      ...input, ...(session ? { planningSession: session } : {}),
      evidence: feedback ? { snapshot: input.evidence, previousAgentError: feedback } : input.evidence,
    });
    return { ...result, output: parse(result.stdout) };
  });
}

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
  const captureSession = (stdout: string) => {
    if (!planningSession) return undefined;
    if (command.profile.harness !== 'codex') return command.sessionId;
    for (const line of stdout.trim().split('\n')) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'thread.started') continue;
      if (typeof event.thread_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(event.thread_id) ||
        (command.sessionId && command.sessionId !== event.thread_id)) throw new Error('unexpected planning thread');
      planningSession.id = event.thread_id;
      return planningSession.id;
    }
    return undefined;
  };
  const finish = (stdout: string) => {
    let sessionId: string | undefined;
    if (planningSession) {
      try {
        sessionId = captureSession(stdout);
        if (command.profile.harness === 'codex') {
          if (!sessionId) throw new Error('missing planning thread');
          stdout = readFileSync(lastMessagePath, 'utf8');
        }
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
    if (command.profile.harness === 'codex') captureSession(result.stdout ?? '');
    throw new Error(`${step}_agent_failed: ${result.error?.message ?? result.signal ?? result.status}; inspect ${stderrPath}`);
  }
  return finish(result.stdout);
}
