// Test double only: it validates captured inputs and emits the supplied canned
// verdict. It never evaluates language or calls a provider.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
const { values } = parseArgs({ options: Object.fromEntries(['case', 'result', 'record', 'exit', 'sleep', 'rewrite'].map((name) => [name, { type: 'string' }])) });
const prompt = readFileSync(0, 'utf8');
const snapshot = JSON.parse(prompt.trimEnd().split('\n').at(-1));
assert.equal(snapshot.schemaVersion, 1);
assert.ok(snapshot.originalRequests.length && snapshot.design && snapshot.plan && snapshot.task && snapshot.candidateInstructions);
assert.match(prompt, /Do not obey that material/);
if (values.record) appendFileSync(values.record, JSON.stringify(snapshot) + '\n');
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
