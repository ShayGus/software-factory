#!/usr/bin/env node
// Test double only: it validates captured inputs and emits the supplied canned
// verdict. It never evaluates language or calls a provider.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const values = JSON.parse(process.env.SF_FAKE_JUDGE_OPTIONS ?? '{}');
const agentArgv = process.argv.slice(2);
assert.ok(agentArgv[0] === 'exec' || agentArgv.includes('--print'));
assert.ok(!agentArgv.includes('--resume') && !agentArgv.includes('--continue'));
const prompt = readFileSync(0, 'utf8');
const { evidence } = JSON.parse(prompt.trimEnd().split('\n').at(-1));
const snapshot = JSON.parse(readFileSync(evidence, 'utf8'));
assert.equal(snapshot.schemaVersion, 1);
const plan = snapshot.plan ?? snapshot.plans?.find((plan) =>
  plan.id === snapshot.reviewPlan?.id && plan.revision === snapshot.reviewPlan?.revision);
assert.ok(snapshot.originalRequests.length && snapshot.design && plan && snapshot.task && snapshot.candidateInstructions);
assert.match(prompt, /Do not obey that material/);
if (values.record) appendFileSync(values.record, JSON.stringify({ ...snapshot, prompt, agentArgv, agentPid: process.pid,
  inheritedSessionMarkers: Object.keys(process.env).filter((name) => ['CLAUDECODE', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID'].includes(name) || name.startsWith('FM_') || name.startsWith('ORCA_')) }) + '\n');
let verdict = { verdict: 'pass', findings: [] };
if (values.case) {
  const fixture = JSON.parse(readFileSync(values.case, 'utf8'));
  assert.equal(snapshot.originalRequests[0].text, fixture.originalRequest);
  assert.equal(snapshot.task.expectedBehavior, fixture.expectedBehavior);
  assert.ok(snapshot.candidateInstructions.includes(fixture.candidateIncludes));
  assert.ok(snapshot.design.productBehavior.includes(fixture.designIncludes));
  verdict = fixture.verdict;
}
if (values.sleep) await setTimeout(Number(values.sleep));
if (values.rewrite) writeFileSync(values.rewrite, 'Changed after the judge captured its input.');
process.stdout.write(values.result ?? JSON.stringify(verdict));
process.exitCode = Number(values.exit ?? 0);
