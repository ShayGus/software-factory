#!/usr/bin/env node
// Contract double only. No provider or network is used.
import { appendFileSync, readFileSync } from 'node:fs';
const options = JSON.parse(process.env.SF_FAKE_LEARNING_OPTIONS ?? '{}');
const input = readFileSync(0, 'utf8');
const snapshot = JSON.parse(input.slice(input.indexOf('\n{"observations":') + 1));
if (options.record) appendFileSync(options.record, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), snapshot,
  inherited: Object.keys(process.env).filter((name) => /^(FM_|ORCA_|CLAUDECODE$|CLAUDE_SESSION_ID$|CODEX_THREAD_ID$)/u.test(name)) }) + '\n');
if (options.capture) {
  const { ProjectStore, captureLearning } = await import('../dist/src/index.js');
  const store = new ProjectStore(options.db);
  try { captureLearning(store, options.capture); } finally { store.close(); }
}
if (options.exit) process.exit(options.exit);
if (options.malformed) { process.stdout.write('not JSON'); process.exit(0); }
const decisions = snapshot.groups.map((group) => {
  const first = group.observations[0];
  const identity = first.learning;
  const related = snapshot.guidance.filter((g) => g.learning && g.learning.topic === identity.topic &&
    JSON.stringify(g.learning.scope) === JSON.stringify(identity.scope));
  const outcome = options.outcome ?? (related.length ? 'update' : 'add');
  return { groupId: group.groupId, outcome, text: ['add', 'update', 'supersede'].includes(outcome) ? (options.text ?? first.proposedGeneralization ?? first.finding) : null,
    rationale: 'Evidence: ' + group.observations.map((o) => o.evidence.map((e) => e.description).join('; ')).join('; '),
    observationRefs: group.observations.map(({ id, revision }) => ({ id, revision })),
    guidanceRefs: ['update', 'supersede'].includes(outcome) ? related.map(({ id, revision }) => ({ id, revision })) : [] };
});
if (options.duplicate && decisions[0]) decisions.push(decisions[0]);
if (options.omitObservation && decisions[0]) decisions[0].observationRefs.pop();
process.stdout.write(JSON.stringify({ decisions }));
