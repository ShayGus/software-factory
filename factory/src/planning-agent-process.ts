// Internal synchronous-call bridge: pump agent output and observe only this
// process group's activity. The parent owns configuration and temporary files.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export type PlanningActivity = {
  elapsedMs: number; idleForMs: number; stdoutBytes: number; stderrBytes: number;
  cpuSamples: number; cpuActivityEvents: number; cpuProbeAvailable: boolean;
  agentPid?: number; agentIdentity?: string;
};
type Control = { executable: string; args: string[]; timeoutMs: number; idleTimeoutMs: number;
  reportPath: string; progressPath?: string };
type Report = PlanningActivity & { startedAt: string; phase: string; status?: number | null;
  signal?: string | null; termination?: string; error?: string };

const control = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Control;
const owner = process.ppid;
const startedAt = new Date().toISOString(); const started = performance.now();
let lastActivity = started; let stdoutBytes = 0; let stderrBytes = 0;
let cpuSamples = 0; let cpuActivityEvents = 0; let cpuProbeAvailable = false;
let previousCpu: string | undefined; let finished = false; let termination: string | undefined;
let probe: ReturnType<typeof spawn> | undefined;
const agent = spawn(control.executable, control.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
function killAgentGroup() {
  if (process.platform !== 'win32' && agent.pid) {
    try { process.kill(-agent.pid, 'SIGKILL'); } catch { /* The owned group already exited. */ }
  } else agent.kill('SIGKILL');
}
process.on('uncaughtException', (error) => {
  try { process.stderr.write(String(error)); }
  finally { killAgentGroup(); process.exit(1); }
});
const agentIdentity = agent.pid && process.platform !== 'win32' ? spawnSync('ps', ['-o', 'pgid=,lstart=', '-p', String(agent.pid)], {
  encoding: 'utf8', timeout: 1000,
}).stdout?.trim().replace(/\s+/gu, ' ') : undefined;
const snapshot = (phase: string, extra: Partial<Report> = {}): Report => ({ startedAt, phase,
  elapsedMs: Math.round(performance.now() - started), idleForMs: Math.round(performance.now() - lastActivity),
  stdoutBytes, stderrBytes, cpuSamples, cpuActivityEvents, cpuProbeAvailable,
  ...(agent.pid ? { agentPid: agent.pid } : {}), ...(agentIdentity ? { agentIdentity } : {}), ...extra });
const publish = (value: Report) => {
  if (!control.progressPath) return;
  const temporary = `${control.progressPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, control.progressPath);
};
const report = (value: Report) => {
  publish(value); writeFileSync(control.reportPath, JSON.stringify(value), { mode: 0o600 });
};
const stop = (reason: string) => {
  if (finished || termination) return;
  termination = reason;
  try { report(snapshot(reason, { termination: reason })); }
  finally { killAgentGroup(); }
};
const activity = () => { lastActivity = performance.now(); };
agent.stdout.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; activity(); process.stdout.write(chunk); });
agent.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; activity(); process.stderr.write(chunk); });
agent.stdin.on('error', () => { /* Early agent exit can close its input pipe. */ });
process.stdin.pipe(agent.stdin);

function sampleCpu() {
  if (probe || finished || !agent.pid || process.platform === 'win32') return;
  const current = spawn('ps', ['-o', 'pid=,time=', '-g', String(agent.pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  probe = current; let text = '';
  const deadline = setTimeout(() => current.kill('SIGKILL'), 1000);
  current.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  current.on('error', () => { cpuProbeAvailable = false; });
  current.on('close', (code) => {
    clearTimeout(deadline); probe = undefined;
    if (finished) return;
    if (code !== 0) { cpuProbeAvailable = false; return; }
    const counters = text.trim().split('\n').flatMap((line) => {
      const [pid, ...time] = line.trim().split(/\s+/u);
      if (!pid || Number(pid) === process.pid || Number(pid) === current.pid) return [];
      if (process.platform === 'linux') {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (fields[2] !== String(agent.pid) && fields[3] !== String(agent.pid)) return [];
          return [`${pid}:${fields.slice(11, 15).join(':')}`];
        } catch { return []; } // A process can exit between ps and its counter read.
      }
      return [`${pid}:${time.join(' ')}`];
    }).sort();
    if (!counters.length) return;
    cpuProbeAvailable = true; cpuSamples++;
    const counter = counters.join(',');
    if (previousCpu === undefined) activity();
    else if (counter !== previousCpu) { cpuActivityEvents++; activity(); }
    previousCpu = counter;
    if (performance.now() - lastActivity >= control.idleTimeoutMs) stop('planning_idle_timeout');
  });
}

const safety = setTimeout(() => stop('planning_safety_timeout'), control.timeoutMs);
const tick = setInterval(() => {
  try { process.kill(owner, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { stop('planning_owner_exited'); return; }
  }
  sampleCpu(); publish(snapshot('running'));
  // Only a fresh CPU sample may prove inactivity. Missing or delayed activity
  // observations defer idle termination to the generous safety budget.
}, Math.min(1000, Math.max(25, Math.floor(control.idleTimeoutMs / 4))));
sampleCpu(); report(snapshot('running'));
agent.on('error', (error) => {
  finished = true; clearTimeout(safety); clearInterval(tick); probe?.kill('SIGKILL');
  report(snapshot('spawn_error', { error: error.message, status: 1 })); process.exitCode = 1;
});
agent.on('close', (status, signal) => {
  if (finished) return;
  finished = true; clearTimeout(safety); clearInterval(tick); probe?.kill('SIGKILL');
  report(snapshot(termination ?? 'exited', { status, signal, ...(termination ? { termination } : {}) }));
  process.exitCode = status === 0 && !termination ? 0 : 1;
});
