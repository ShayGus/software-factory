import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ProjectStore, RecordsSchema, captureLearning, captureStowObservation, consolidateLearning,
  learningContext, activeGuidance, projectLegacyContext, readLegacySection, runScheduledLearning,
  latestLearningWindow, prepareLearningSchedule, selectAssignmentContext, validateRecords,
  LearningVerdictSchema, renderWorkerBrief, type CaptureLearningInput, type ProjectAgentConfig, type GuidanceRevision,
} from '../src/index.js';
import { fakeJudge } from './judge-helper.js';
const fixtures = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const at = '2026-11-12T08:30:00.000Z';
const evidence = [{ artifact: { uri: 'fixture:transcript', digest: 'sha256:captured' }, description: 'Observed correction with source transcript', observedAt: at }];
const identity = { scope: { kind: 'project' as const }, topic: 'rule-writing' };
const schedule = { id: 'daily', projectId: 'project-1', timezone: 'Asia/Jerusalem', hours: [9, 21], startsAt: '2026-11-01T00:00:00.000Z' };
const fakeUrl = new URL('../../fixtures/fake-learning-agent.mjs', import.meta.url);
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-learning-'));
  const path = join(dir, 'store.sqlite');
  const store = new ProjectStore(path);
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history: fixtures, receipts: [] });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, path };
}
function observation(id: string, overrides: Partial<CaptureLearningInput> = {}): CaptureLearningInput {
  return { projectId: 'project-1', id, idempotencyKey: `capture:${id}`, issuedAt: at,
    identity, finding: 'Possible rule from this task', proposedGeneralization: 'Keep inferred lessons pending until consolidation.',
    evidence, inputKind: 'inferred', captureReason: 'stow', ...overrides };
}
function config(dir: string, options: Record<string, unknown> = {}): ProjectAgentConfig {
  const executable = join(dir, `agent-${Math.random()}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node\nprocess.env.SF_FAKE_LEARNING_OPTIONS=${JSON.stringify(JSON.stringify(options))};\nawait import(${JSON.stringify(fakeUrl.href)});\n`, { mode: 0o755 });
  const config = structuredClone(fakeJudge);
  config.steps.learning_consolidation = { harness: 'codex', provider: 'codex', model: 'learning-model', effort: 'medium' };
  config.executables = { codex: executable, claude: executable };
  return config;
}
function invocation(id = 'pass-1', overrides = {}) {
  return { projectId: 'project-1', id, idempotencyKey: id, issuedAt: at, scheduledWindowId: `window:${id}`,
    scheduledFor: '2026-11-12T07:00:00.000Z', scheduleDigest: 'schedule-v1', timezone: schedule.timezone, ...overrides };
}
const managed = (store: ProjectStore) => activeGuidance(store.history('project-1')).filter((g) => g.learning);

test('stow and compaction observations persist evidence immediately, without inferred guidance; replay is exact', (t) => {
  const { store, path } = setup(t);
  const { inputKind: _kind, captureReason: _reason, ...data } = observation('compaction');
  const first = captureStowObservation(store, { ...data, compaction: true });
  assert.deepEqual(captureStowObservation(store, { ...data, compaction: true }), first);
  assert.equal(managed(store).length, 0);
  const reopened = new ProjectStore(path);
  try {
    const saved = reopened.get('project-1', 'compaction');
    assert.ok(saved?.kind === 'observation');
    assert.equal(saved.learning?.captureReason, 'compaction');
    assert.equal(saved.consolidationState, 'pending'); assert.deepEqual(saved.evidence, evidence);
  } finally { reopened.close(); }
  assert.throws(() => captureStowObservation(store, { ...data, finding: 'changed', compaction: true }), /idempotency_conflict/);
  assert.throws(() => captureLearning(store, observation('empty', { evidence: [] })));
});

test('local correction updates feature and assignment at once; broader inference waits and fidelity must be rechecked', (t) => {
  const { store } = setup(t);
  const original = store.get('project-1', 'feature-1'); assert.ok(original?.kind === 'feature_revision');
  const previousAssignment = store.get('project-1', 'assignment-1'); assert.ok(previousAssignment?.kind === 'assignment');
  const finding = 'Keep ERPNext as an example; preserve every connected system.';
  const data = observation('local', { inputKind: 'local_correction', captureReason: 'correction', finding,
    identity: { scope: { kind: 'feature', featureId: original.id }, topic: identity.topic },
    feature: { ...original, revision: 2, previousRevision: 1, updatedAt: at, changeReason: finding, outcome: 'Feature X supports every connected system, including ERPNext as one example.' } });
  captureLearning(store, data);
  const feature = store.get('project-1', original.id); assert.ok(feature?.kind === 'feature_revision');
  assert.equal(feature.revision, 2); assert.notEqual(feature.outcome, original.outcome);
  const assignment = store.get('project-1', 'assignment-1'); assert.ok(assignment?.kind === 'assignment');
  assert.equal(assignment.revision, 2); assert.equal(assignment.feature?.revision, 1);
  assert.ok(assignment.instructionText.endsWith(finding)); assert.equal(assignment.instructionFidelity.result, 'blocked');
  assert.equal(assignment.selectedContext.at(-1)?.extract, finding);
  assert.deepEqual(store.get('project-1', 'assignment-1', 1), previousAssignment);
  assert.equal(learningContext(store.history('project-1'), original.id).corrections[0]?.finding, finding);
  assert.equal(managed(store).length, 0);
  assert.deepEqual(captureLearning(store, data).records.map((r) => r.id), ['local', 'feature-1', 'assignment-1']);
  const saved = store.exportProject('project-1');
  assert.throws(() => captureLearning(store, observation('bad-correction', { inputKind: 'local_correction' })), /local_correction_requires/);
  assert.deepEqual(store.exportProject('project-1'), saved);
});

test('standing instructions apply immediately, require exact supersession, and explicit feature instruction overrides project default', (t) => {
  const { store } = setup(t);
  captureLearning(store, observation('standing', { inputKind: 'standing_instruction', finding: 'Use plain text.' }));
  const original = managed(store)[0]!;
  assert.equal(original.learning?.authority, 'explicit'); assert.equal(original.text, 'Use plain text.');
  assert.throws(() => captureLearning(store, observation('replacement', { inputKind: 'standing_instruction', finding: 'Use structured text.' })), /exact_supersession/);
  captureLearning(store, observation('replacement', { inputKind: 'standing_instruction', finding: 'Use structured text.', supersedes: [{ id: original.id, revision: original.revision }] }));
  assert.equal(managed(store).length, 1); assert.equal(managed(store)[0]?.text, 'Use structured text.');
  captureLearning(store, observation('exception', { inputKind: 'standing_instruction', finding: 'For this feature use JSON.',
    identity: { scope: { kind: 'feature', featureId: 'feature-1' }, topic: identity.topic } }));
  const context = learningContext(store.history('project-1'), 'feature-1');
  assert.deepEqual(context.guidance.filter((g) => g.learning).map((g) => g.text), ['For this feature use JSON.']);
  assert.deepEqual(learningContext(store.history('project-1'), 'other-feature').guidance.filter((g) => g.learning).map((g) => g.text), ['Use structured text.']);
});

test('one separate agent pass consolidates duplicate evidence into one narrow rule and replays without another call', (t) => {
  const { store, dir } = setup(t);
  captureLearning(store, observation('one')); captureLearning(store, observation('two'));
  const record = join(dir, 'calls.jsonl'); const agent = config(dir, { record }); const input = invocation();
  const first = consolidateLearning(store, input, agent);
  assert.equal(managed(store).length, 1); assert.equal(managed(store)[0]?.supportingObservations.length, 2);
  assert.equal(store.get('project-1', 'one')?.revision, 2);
  assert.deepEqual(consolidateLearning(store, { ...input, issuedAt: '2026-11-12T09:00:00.000Z' }, agent), first);
  const calls = readFileSync(record, 'utf8').trim().split('\n'); assert.equal(calls.length, 1);
  const call = JSON.parse(calls[0]!); assert.notEqual(call.pid, process.pid); assert.deepEqual(call.inherited, []);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'learning-model'); assert.ok(call.args.includes('model_reasoning_effort="medium"'));
  assert.ok(call.args.includes('--ephemeral')); assert.ok(call.args.includes('--ignore-user-config'));
  assert.ok(call.args.some((arg: string) => arg.endsWith('/learning-consolidation.schema.json')));
  const schema = JSON.parse(readFileSync(new URL('../../fixtures/learning-consolidation.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.type, 'object');
  const run = store.get('project-1', 'pass-1'); assert.ok(run?.kind === 'learning_run');
  assert.ok(LearningVerdictSchema.safeParse(run.verdict).success); assert.equal(run.observations.length, 2);
  assert.throws(() => consolidateLearning(store, { ...input, scheduledWindowId: 'different' }, agent), /idempotency_conflict/);
});

test('update and supersede retain revisions and evidence while only the current text enters new assignment context', (t) => {
  const { store, dir } = setup(t);
  captureLearning(store, observation('initial')); consolidateLearning(store, invocation(), config(dir, { text: 'Original inferred text.' }));
  const original = managed(store)[0]!;
  captureLearning(store, observation('improvement')); consolidateLearning(store, invocation('pass-2'), config(dir, { text: 'Updated inferred text.' }));
  assert.equal(managed(store)[0]?.id, original.id); assert.equal(managed(store)[0]?.revision, 2);
  captureLearning(store, observation('replacement')); consolidateLearning(store, invocation('pass-3'), config(dir, { outcome: 'supersede', text: 'Replacement inferred text.' }));
  const current = managed(store)[0]!; assert.notEqual(current.id, original.id);
  assert.equal(managed(store).length, 1); assert.equal(current.supersededGuidance[0]?.revision, 2);
  const assignment = store.get('project-1', 'assignment-1'); assert.ok(assignment?.kind === 'assignment');
  const selected = selectAssignmentContext(store.history('project-1'), assignment, (source) => ({ uri: source.uri, text: 'Source context' }));
  const extracted = selected.selectedContext.map((entry) => entry.extract).join('\n');
  assert.ok(extracted.includes('Replacement inferred text.'));
  assert.ok(!extracted.includes('Original inferred text.') && !extracted.includes('Updated inferred text.'));
});

test('conflicting observations stay open; explicit instructions cannot be overridden by an inferred rule', (t) => {
  const { store, dir } = setup(t);
  captureLearning(store, observation('opposite-a', { finding: 'Always retry.' }));
  captureLearning(store, observation('opposite-b', { finding: 'Never retry.' }));
  consolidateLearning(store, invocation(), config(dir, { outcome: 'conflict' }));
  assert.equal(managed(store).length, 0); assert.equal(learningContext(store.history('project-1')).conflicts.length, 2);
  captureLearning(store, observation('standing', { inputKind: 'standing_instruction', finding: 'Ask before retrying.' }));
  const before = store.exportProject('project-1');
  assert.throws(() => consolidateLearning(store, invocation('invalid-pass'), config(dir)), /inference_cannot_replace_explicit/);
  assert.deepEqual(store.exportProject('project-1'), before);
  consolidateLearning(store, invocation('open-conflict'), config(dir, { outcome: 'conflict' }));
  assert.deepEqual(managed(store).map((g) => g.text), ['Ask before retrying.']);
});

test('temporary and isolated observations can produce no general rule', (t) => {
  const { store, dir } = setup(t);
  captureLearning(store, observation('incident', { inputKind: 'operational', finding: 'The current service is unavailable.' }));
  assert.equal(learningContext(store.history('project-1')).corrections.length, 1);
  consolidateLearning(store, invocation(), config(dir, { outcome: 'no_rule' }));
  const saved = store.get('project-1', 'incident'); assert.ok(saved?.kind === 'observation');
  assert.equal(saved.consolidationState, 'no_general_rule'); assert.equal(managed(store).length, 0);
  assert.equal(learningContext(store.history('project-1')).corrections.length, 0);
});

test('legacy adoption records source and section diff, suppresses superseded text, and preserves all source file bytes', (t) => {
  const { store, dir } = setup(t);
  const path = join(dir, 'memory.md'); const text = '# Memory\nPreamble\n\n## Rules\nUse old behavior.\n\n### Details\nOld detail.\n\n## Operations\nKeep this exact.\n';
  writeFileSync(path, text); const section = readLegacySection(path, '## Rules');
  assert.ok(section.before.includes('Old detail.')); assert.ok(!section.before.includes('Keep this exact.'));
  captureLearning(store, observation('legacy', { legacySections: [section], evidence: [...evidence, {
    artifact: { uri: path, digest: section.digest }, description: 'Relevant legacy memory section', observedAt: at }] }));
  consolidateLearning(store, invocation(), config(dir, { text: 'Use the consolidated behavior.' }));
  assert.equal(readFileSync(path, 'utf8'), text);
  const run = store.get('project-1', 'pass-1'); assert.ok(run?.kind === 'learning_run');
  assert.equal(run.sectionDiffs.length, 1); assert.ok(run.sectionDiffs[0]?.diff.includes('-Use old behavior.'));
  assert.ok(run.sectionDiffs[0]?.diff.includes('+Use the consolidated behavior.'));
  const projected = projectLegacyContext(store.history('project-1'), path, text);
  assert.ok(projected.includes('Keep this exact.')); assert.ok(!projected.includes('Use old behavior.'));
  assert.equal(managed(store)[0]?.legacyReplacements?.[0]?.uri, path);
  const records = store.history('project-1').map((record) => record.kind === 'design_revision' ? { ...record, sourceRefs: [...record.sourceRefs, { uri: path }] } : record);
  const assignment = store.get('project-1', 'assignment-1'); assert.ok(assignment?.kind === 'assignment');
  const selection = selectAssignmentContext(records, assignment, (source) => ({ uri: source.uri, text: source.uri === path ? text : 'Relevant source' }));
  const memory = selection.selectedContext.find((entry) => entry.source.uri === path);
  assert.ok(memory?.extract?.includes('Keep this exact.'));
  const context = JSON.stringify(selection.selectedContext);
  assert.ok(!context.includes('Use old behavior.') && !context.includes('Old detail.'));
  const scaffold = readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url), 'utf8');
  const brief = renderWorkerBrief(records, { ...assignment, selectedContext: selection.selectedContext }, scaffold);
  assert.ok(brief.includes('Use the consolidated behavior.'));
  assert.ok(!brief.includes('Use old behavior.') && !brief.includes('Old detail.'));
  assert.throws(() => projectLegacyContext(store.history('project-1'), path, text.replace('Use old behavior.', 'Changed outside adoption.')), /legacy_section_changed/);
});

for (const mode of ['duplicate', 'omitObservation', 'malformed', 'exit', 'missing-profile'] as const) test(`invalid agent response/config ${mode} leaves guidance and last good window unchanged`, (t) => {
  const { store, dir } = setup(t); captureLearning(store, observation('pending'));
  const options = mode === 'exit' ? { exit: 8 } : { [mode]: true };
  const agent = config(dir, options);
  if (mode === 'missing-profile') delete (agent.steps as Partial<typeof agent.steps>).learning_consolidation;
  const before = store.exportProject('project-1');
  assert.throws(() => consolidateLearning(store, invocation(), agent));
  assert.deepEqual(store.exportProject('project-1'), before);
});

test('snapshot races abort atomically, leaving observations available for a later pass', (t) => {
  const { store, dir, path } = setup(t); captureLearning(store, observation('pending'));
  const agent = config(dir, { db: path, capture: observation('concurrent') });
  assert.throws(() => consolidateLearning(store, invocation(), agent), /learning_snapshot_changed/);
  assert.equal(store.get('project-1', 'pass-1'), undefined); assert.equal(managed(store).length, 0);
  assert.ok(store.get('project-1', 'concurrent')); assert.equal(store.get('project-1', 'pending')?.revision, 1);
});

test('missed windows coalesce into one catch-up, persisted success survives reopen and export/restore', (t) => {
  const { store, dir, path } = setup(t); const record = join(dir, 'calls'); const agent = config(dir, { record });
  captureLearning(store, observation('pending'));
  assert.equal(runScheduledLearning(store, schedule, at, agent).state, 'succeeded');
  const reopened = new ProjectStore(path);
  try { assert.equal(runScheduledLearning(reopened, schedule, at, agent).state, 'already_succeeded'); } finally { reopened.close(); }
  const later = '2026-11-19T20:00:00.000Z';
  assert.equal(runScheduledLearning(store, schedule, later, agent).state, 'succeeded');
  assert.equal(store.records('project-1').filter((r) => r.kind === 'learning_run').length, 2);
  assert.equal(readFileSync(record, 'utf8').trim().split('\n').length, 2);
  const restored = new ProjectStore(':memory:');
  try {
    restored.importProject(store.exportProject('project-1'));
    assert.equal(runScheduledLearning(restored, schedule, later, agent).state, 'already_succeeded');
    assert.ok(validateRecords(restored.history('project-1')).ok);
  } finally { restored.close(); }
  const last = store.records('project-1').filter((r) => r.kind === 'learning_run').at(-1)!;
  assert.ok(last.kind === 'learning_run'); assert.equal(last.scheduledFor, '2026-11-19T19:00:00.000Z');
});

test('daily/twice daily schedule honors timezone, startsAt, DST and creates a disabled cron entry', () => {
  assert.equal(latestLearningWindow(schedule, '2026-10-31T22:00:00.000Z'), null);
  assert.equal(latestLearningWindow(schedule, at)?.scheduledFor, '2026-11-12T07:00:00.000Z');
  const daily = { ...schedule, hours: [21] };
  assert.equal(latestLearningWindow(daily, at)?.scheduledFor, '2026-11-11T19:00:00.000Z');
  const dst = { ...schedule, startsAt: '2026-10-01T00:00:00Z', timezone: 'America/New_York', hours: [1] };
  assert.equal(latestLearningWindow(dst, '2026-11-01T05:30:00Z')?.id, latestLearningWindow(dst, '2026-11-01T06:30:00Z')?.id);
  const prepared = prepareLearningSchedule(schedule, { node: '/usr/bin/node', cli: '/project/cli.js', db: '/project/db.sqlite', schedule: '/project/schedule.json', agentConfig: '/project/agent.json' });
  assert.equal(prepared.enabled, false); assert.match(prepared.entry, /^CRON_TZ=Asia\/Jerusalem\n0 9,21 \* \* \*/);
  assert.ok(prepared.command.includes('learning-tick'));
  assert.throws(() => prepareLearningSchedule({ ...schedule, hours: [9, 12, 21] }, { node: '/node', cli: '/cli', db: '/db', schedule: '/config', agentConfig: '/agent' }));
});

test('overlapping inferred guidance is rejected by shared record validation', (t) => {
  const { store } = setup(t); captureLearning(store, observation('standing', { inputKind: 'standing_instruction' }));
  const original = managed(store)[0]!;
  const contradictory: GuidanceRevision = { ...original, id: 'contradictory', text: 'Opposite rule', learning: { ...identity, authority: 'inferred' } };
  const checked = validateRecords([...store.history('project-1'), contradictory]);
  assert.equal(checked.ok, false); if (!checked.ok) assert.ok(checked.issues.some((issue) => issue.code === 'contradictory_active_guidance'));
});

test('CLI captures, consolidates via fake agent, exposes evidence/context, and prepares the schedule end to end', (t) => {
  const { dir, path } = setup(t); const agent = config(dir, { record: join(dir, 'cli-calls') });
  const writeJson = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const agentPath = writeJson('agent.json', agent); const schedulePath = writeJson('schedule.json', schedule);
  const inputPath = writeJson('capture.json', observation('cli-observation', { captureReason: 'compaction' }));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--db', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout);
  };
  assert.equal(run('learning-capture', '--input', inputPath).records[0]?.id, 'cli-observation');
  assert.equal(run('learning-tick', '--schedule', schedulePath, '--agent-config', agentPath, '--now', at).state, 'succeeded');
  const context = run('learning-context', '--project', 'project-1');
  assert.ok(context.guidance.some((g: GuidanceRevision) => g.learning && g.text === 'Keep inferred lessons pending until consolidation.'));
  assert.equal(run('learning-tick', '--schedule', schedulePath, '--agent-config', agentPath, '--now', at).state, 'already_succeeded');
  const prepared = run('learning-schedule', '--schedule', schedulePath, '--agent-config', agentPath);
  assert.equal(prepared.enabled, false); assert.ok(prepared.command.includes(path));
});

test('learning consolidation independently selects a Claude profile and obeys the configured bound', (t) => {
  const { store, dir } = setup(t); captureLearning(store, observation('claude-learning'));
  const record = join(dir, 'claude-calls'); const agent = config(dir, { record });
  agent.steps.learning_consolidation = { harness: 'claude', provider: 'claude', model: 'separate-learning-model', effort: 'low' };
  consolidateLearning(store, invocation(), agent);
  const call = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'separate-learning-model');
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'low');
  assert.ok(call.args.includes('--no-session-persistence'));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  captureLearning(store, observation('timed-out'));
  const bounded = config(dir); bounded.timeoutMs = 1;
  assert.throws(() => consolidateLearning(store, invocation('timeout'), bounded), /learning_consolidation_agent_failed/);
  assert.equal(store.get('project-1', 'timeout'), undefined);
  const saved = store.get('project-1', 'timed-out'); assert.ok(saved?.kind === 'observation');
  assert.equal(saved.consolidationState, 'pending');
});

test('explicit legacy adoption returns an immediate section diff and projects even a single-section source', (t) => {
  const { store, dir } = setup(t); const path = join(dir, 'standing.md');
  const memory = '## Standing\nUse the retired format.\n'; writeFileSync(path, memory);
  const section = readLegacySection(path, '## Standing');
  const result = captureLearning(store, observation('standing-adoption', { inputKind: 'standing_instruction',
    finding: 'Use the current format.', legacySections: [section] }));
  assert.equal(result.sectionDiffs.length, 1);
  assert.ok(result.sectionDiffs[0]?.diff.includes('-Use the retired format.'));
  assert.ok(result.sectionDiffs[0]?.diff.includes('+Use the current format.'));
  const projected = projectLegacyContext(store.history('project-1'), path, memory);
  assert.ok(projected.trim().length > 0); assert.ok(!projected.includes('Use the retired format.'));
  assert.equal(readFileSync(path, 'utf8'), memory);
});
