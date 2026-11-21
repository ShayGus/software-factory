import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectAgentConfigSchema, WorkflowAgentProfileSchema, WorkflowAgentStepSchema, instructionAgentCommand,
  resolveStepAgentProfile, stepAgentCommand, judgeWorkerInstructions, RecordsSchema, type Assignment } from '../src/index.js';
import { fakeJudge, fakeJudgeOptions } from './judge-helper.js';
import { runStepAgent } from '../src/agent-runner.js';
const records = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;

test('workflow profiles reuse the FirstMate profile fields without translation', () => {
  const profile = { harness: 'codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
  assert.deepEqual(WorkflowAgentProfileSchema.parse(profile), profile);
  assert.equal(ProjectAgentConfigSchema.parse(fakeJudge).steps.product_review.harness, 'codex');
});

for (const step of WorkflowAgentStepSchema.options) test(`resolves a distinct ${step} profile from the project setting`, () => {
  const config = structuredClone(fakeJudge);
  config.steps[step] = { harness: 'claude', provider: 'claude', model: `model-for-${step}`, effort: 'xhigh' };
  const resolved = resolveStepAgentProfile(config, 'project-1', step);
  assert.deepEqual(resolved.profile, config.steps[step]);
});

for (const harness of ['codex', 'claude'] as const) test(`${harness} gets its instruction-check model and effort in a fresh one-shot command`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-profile-command-'));
  try {
    const record = join(directory, 'agent.jsonl');
    const config = fakeJudgeOptions({ record });
    config.steps.instruction_check = { harness, provider: harness, model: `review-model-${harness}`, effort: 'high' };
    config.steps.product_review = { harness: 'codex', provider: 'codex', model: 'different-later-review', effort: 'low' };
    config.timeoutMs = 9000;
    const command = instructionAgentCommand(config, 'project-1');
    assert.equal(command.args[command.args.indexOf('--model') + 1], `review-model-${harness}`);
    assert.equal(command.timeoutMs, 9000);
    if (harness === 'codex') {
      assert.equal(command.args[0], 'exec'); assert.ok(command.args.includes('--ephemeral'));
      assert.ok(command.args.includes('--ignore-user-config'));
      assert.equal(command.args[command.args.indexOf('--sandbox') + 1], 'read-only');
      assert.ok(command.args.includes('model_reasoning_effort="high"'));
    } else {
      assert.ok(command.args.includes('--print')); assert.ok(command.args.includes('--no-session-persistence'));
      assert.ok(command.args.includes('--safe-mode') && command.args.includes('--strict-mcp-config'));
      assert.equal(command.args[command.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
      assert.equal(command.args[command.args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep');
      assert.equal(command.args[command.args.indexOf('--permission-mode') + 1], 'dontAsk');
      assert.equal(command.args[command.args.indexOf('--effort') + 1], 'high');
    }
    assert.ok(!command.args.includes('--resume') && !command.args.includes('--continue'));
    const result = judgeWorkerInstructions(records, assignment, assignment.instructionText, config);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.deepEqual(result.profile, config.steps.instruction_check);
    const calls = readFileSync(record, 'utf8').trimEnd().split('\n'); assert.equal(calls.length, 1);
    const input = JSON.parse(calls[0]!); assert.notEqual(input.agentPid, process.pid);
    assert.deepEqual(input.agentArgv, command.args);
    assert.deepEqual(input.inheritedSessionMarkers, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const kind of ['missing-profile', 'missing-future-profile', 'unsupported-harness', 'unsupported-provider', 'unsupported-effort', 'wrong-project'] as const) {
  test(`${kind} refuses judgment without starting a fallback agent`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'sf-profile-refuse-'));
    try {
      const record = join(directory, 'calls.jsonl'); const config = fakeJudgeOptions({ record });
      if (kind === 'missing-profile') delete (config.steps as Partial<typeof config.steps>).instruction_check;
      if (kind === 'missing-future-profile') delete (config.steps as Partial<typeof config.steps>).product_review;
      if (kind === 'unsupported-harness') config.steps.instruction_check.harness = 'opencode';
      if (kind === 'unsupported-provider') config.steps.instruction_check.provider = 'openrouter';
      if (kind === 'unsupported-effort') config.steps.instruction_check.effort = 'ultra';
      if (kind === 'wrong-project') config.projectId = 'another-project';
      const result = judgeWorkerInstructions(records, assignment, assignment.instructionText, config);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, kind === 'missing-profile' ? /instruction_check/ : kind === 'missing-future-profile' ? /product_review/ : /unsupported_|project_mismatch/);
      assert.equal(existsSync(record), false, 'No fallback or current-session agent was invoked');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('raw executable/args configuration is rejected after the profile migration', () => {
  const result = judgeWorkerInstructions(records, assignment, assignment.instructionText, { executable: process.execPath, args: ['--version'] });
  assert.equal(result.ok, false);
});

for (const [harness, model, effort, accepted] of [
  ['codex', 'gpt-5.6-luna', 'max', true], ['codex', 'gpt-6.1-sol', 'max', false],
  ['claude', 'claude-opus-5-5', 'max', true], ['claude', 'claude-opus-5-5', 'ultra', false],
] as const) test(`FirstMate effort compatibility: ${harness}/${model}/${effort}`, () => {
  const config = structuredClone(fakeJudge); config.steps.instruction_check = { harness, provider: harness, model, effort };
  if (accepted) assert.ok(instructionAgentCommand(config, 'project-1').args.includes(harness === 'codex' ? 'model_reasoning_effort="max"' : 'max'));
  else assert.throws(() => instructionAgentCommand(config, 'project-1'), /unsupported_instruction_check_effort/);
});

test('a configured step cannot silently fall back when its harness executable is missing', () => {
  const config = structuredClone(fakeJudge); delete config.executables.codex;
  assert.throws(() => instructionAgentCommand(config, 'project-1'), /agent_executable_not_configured: codex/);
});


for (const harness of ['codex', 'claude'] as const) test(`${harness} planning has configurable idle and safety deadlines independent of instruction checks`, () => {
  const config = structuredClone(fakeJudge);
  for (const step of ['understand', 'design', 'plan', 'detail', 'plan_check'] as const) {
    config.steps[step] = { harness, provider: harness };
    assert.equal(stepAgentCommand(config, 'project-1', step).timeoutMs, 21_600_000);
    assert.equal(stepAgentCommand(config, 'project-1', step).idleTimeoutMs, 1_800_000);
  }
  config.planningTimeoutMs = 7_200_000;
  config.planningIdleTimeoutMs = 2_400_000;
  config.timeoutMs = 42_000;
  for (const step of ['understand', 'design', 'plan', 'detail', 'plan_check'] as const) {
    assert.equal(stepAgentCommand(config, 'project-1', step).timeoutMs, 7_200_000);
    assert.equal(stepAgentCommand(config, 'project-1', step).idleTimeoutMs, 2_400_000);
  }
  assert.equal(instructionAgentCommand(config, 'project-1').timeoutMs, 42_000);
  config.planningTimeoutMs = 900_001;
  assert.equal(stepAgentCommand(config, 'project-1', 'plan').timeoutMs, 900_001, 'No fifteen-minute ceiling');
});

test('a stuck planning process is terminated at its configured total wall-clock deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-planning-deadline-'));
  try {
    const executable = join(directory, 'stuck.mjs');
    writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => {}, 30_000);\n`, { mode: 0o755 });
    const config = { ...structuredClone(fakeJudge), planningTimeoutMs: 50, executables: { codex: executable } };
    const started = performance.now();
    assert.throws(() => runStepAgent(config, 'project-1', 'plan', 'Plan the feature', { evidence: null }), /planning_safety_timeout/);
    assert.ok(performance.now() - started < 5000, 'The process must not survive its bounded planning call');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


for (const stream of ['stdout', 'stderr']) test(`planning ${stream} progress keeps a stage alive beyond its idle window`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-planning-progress-'));
  try {
    const executable = join(directory, 'progress.mjs');
    writeFileSync(executable, `#!${process.execPath}\nlet count=0; const timer=setInterval(()=>{process.${stream}.write('progress\\n'); if(++count===12){clearInterval(timer); process.stdout.write('done');}},125);\n`, { mode: 0o755 });
    const config = { ...structuredClone(fakeJudge), planningTimeoutMs: 10_000, planningIdleTimeoutMs: 1000,
      executables: { codex: executable } };
    const result = runStepAgent(config, 'project-1', 'plan', 'Plan the feature', { evidence: null });
    assert.ok(result.stdout.endsWith('done'));
    assert.ok(result.activity!.elapsedMs > config.planningIdleTimeoutMs);
    assert.ok(result.activity![stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('silent planning is stopped for inactivity with its measured progress preserved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-planning-idle-'));
  try {
    const executable = join(directory, 'idle.mjs');
    writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => {}, 30_000);\n`, { mode: 0o755 });
    const config = { ...structuredClone(fakeJudge), planningTimeoutMs: 5000, planningIdleTimeoutMs: 200,
      executables: { codex: executable } };
    const progressPath = join(directory, 'progress.json');
    assert.throws(() => runStepAgent(config, 'project-1', 'plan', 'Plan the feature', { evidence: null, progressPath }), /planning_idle_timeout/);
    const progress = JSON.parse(readFileSync(progressPath, 'utf8'));
    assert.equal(progress.termination, 'planning_idle_timeout');
    assert.ok(progress.elapsedMs >= config.planningIdleTimeoutMs);
    assert.equal(progress.cpuProbeAvailable, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('silent CPU activity also keeps planning alive', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-planning-cpu-'));
  try {
    const executable = join(directory, 'cpu.mjs');
    writeFileSync(executable, `#!${process.execPath}\nconst end=Date.now()+3500; while(Date.now()<end){} process.stdout.write('done');\n`, { mode: 0o755 });
    const config = { ...structuredClone(fakeJudge), planningTimeoutMs: 15_000, planningIdleTimeoutMs: 1000,
      executables: { codex: executable } };
    const result = runStepAgent(config, 'project-1', 'plan', 'Plan the feature', { evidence: null });
    assert.equal(result.stdout, 'done');
    assert.ok(result.activity!.cpuActivityEvents > 0);
    assert.ok(result.activity!.elapsedMs > config.planningIdleTimeoutMs);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
