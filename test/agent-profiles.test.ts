import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectAgentConfigSchema, WorkflowAgentProfileSchema, WorkflowAgentStepSchema, instructionAgentCommand,
  resolveStepAgentProfile, judgeWorkerInstructions, RecordsSchema, type Assignment } from '../src/index.js';
import { fakeJudge, fakeJudgeOptions } from './judge-helper.js';
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
      assert.equal(command.args[command.args.indexOf('--tools') + 1], '');
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
