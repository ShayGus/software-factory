import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  captureRequest, captureChatPrompt, initializeProject, mapRequest, requestCoverage,
  unclassifiedRequests, deliverRequest, captureChannelCoverage, chatHookCommand, chatHookSettings,
  ProjectStore, ProjectSchema, validateRecords, type Project,
} from '../src/index.js';

const at = '2026-11-10T12:00:00.000Z';
const project: Project = ProjectSchema.parse({ kind: 'project', id: 'project', projectId: 'project',
  schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
  goal: 'Preserve every request', intendedUser: 'Product owner', priorities: [], exclusions: [],
  vocabulary: {}, repositories: [], designRefs: [], firstMateHomeRef: 'fixture:scratch-only', timezone: 'UTC' });
const originalText = '  Export every system.\r\nKeep history, too. 😀\n';
function scratch(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'sf-intake-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function setup(t: TestContext) {
  const dir = scratch(t);
  const path = join(dir, 'project.sqlite');
  const store = new ProjectStore(path);
  t.after(() => store.close());
  initializeProject(store, project);
  return { store, dir, path };
}
function capture(store: ProjectStore, text = originalText, clientRequestId = 'client-1') {
  return captureRequest(store, { projectId: project.id, clientRequestId, originalText: text,
    source: { uri: 'fixture:original' }, channel: 'cli', capturedAt: at, attachments: [] });
}
function mapping(requestId: string, end = '  Export every system.'.length) {
  return { projectId: project.id, requestId, expectedRevision: 1, idempotencyKey: 'map-first', issuedAt: at,
    start: 0, end, rationale: 'Split export behavior from history behavior',
    target: { kind: 'new_feature', feature: { id: 'export', outcome: 'Export every connected system',
      criteria: [{ id: 'export-all', expectedBehavior: 'Export every connected system', verificationMethod: 'Exercise two different systems' }] } } };
}

// The executable is a contract double for the observed 01a/01b interface. It is
// created INSIDE a temporary FirstMate home; no real FirstMate home is used.
function scratchFirstMate(dir: string) {
  const home = join(dir, 'firstmate');
  mkdirSync(join(home, 'bin'), { recursive: true });
  const executable = join(home, 'bin', 'fm-inbox.sh');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.FM_HOME;
const args = process.argv.slice(2);
const text = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(home, 'calls'), JSON.stringify({ home, args, text, fmOverrides: Object.keys(process.env).filter(key => key.startsWith('FM_') && key !== 'FM_HOME') }) + '\\n');
if (args[0] !== 'note' || args[1] !== '--request-id' || args[3] !== '--json' || args.length !== 5 || args[4] !== '-') process.exit(20);
const savedPath = path.join(home, 'saved.json');
const existed = fs.existsSync(savedPath);
const saved = existed ? JSON.parse(fs.readFileSync(savedPath, 'utf8')) : { id: 'fixture-note-1', request_id: args[2], text };
if (saved.request_id !== args[2] || saved.text !== text) process.exit(21);
fs.writeFileSync(savedPath, JSON.stringify(saved));
const modePath = path.join(home, 'mode');
const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8') : '';
if (mode === 'exit-after-save') { console.error('wake failed after save'); process.exit(7); }
if (mode === 'malformed') { console.log('not JSON'); process.exit(0); }
console.log(JSON.stringify({ schema: 'fm-inbox-note.v1', outcome: existed ? 'replay' : 'created',
  id: saved.id, request_id: mode === 'wrong-request' ? 'another-request' : saved.request_id,
  saved: true, announced: mode !== 'not-announced', acknowledged: false, path: path.join(home, saved.id + '.note') }));
if (mode === 'not-announced') process.exit(3);
`, { mode: 0o755 });
  return home;
}

test('capture retains exact bytes, queues delivery atomically, replays and rejects changed payload', (t) => {
  const { store } = setup(t);
  const first = capture(store);
  assert.equal(first.request.originalText, originalText);
  assert.ok(first.operation?.kind === 'operation');
  assert.equal(first.operation.state, 'pending');
  const retry = captureRequest(store, { projectId: project.id, clientRequestId: 'client-1', originalText,
    source: { uri: 'fixture:original' }, channel: 'cli', attachments: [] });
  assert.deepEqual(retry, first);
  assert.throws(() => capture(store, 'Export ERPNext only'), /idempotency_conflict/);
  assert.equal(store.operations(project.id).length, 1);
});

test('1066-5: initialization replay compares the complete canonical project', (t) => {
  const { store } = setup(t);
  const reordered = Object.fromEntries(Object.entries(project).reverse());
  assert.deepEqual(initializeProject(store, reordered), initializeProject(store, project));
  for (const change of [{ timezone: 'Asia/Jerusalem' }, { priorities: ['Urgent'] },
    { firstMateHomeRef: 'fixture:another-home' }, { vocabulary: { task: 'Work item' } }]) {
    assert.throws(() => initializeProject(store, { ...project, ...change }), /idempotency_conflict/);
  }
  const exported = store.exportProject(project.id);
  const receipt = exported.receipts[0]!;
  assert.ok(receipt.command.command === 'record_decision_suggestion');
  const legacy = new ProjectStore(':memory:');
  t.after(() => legacy.close());
  legacy.importProject({ ...exported, receipts: [{ ...receipt,
    command: { ...receipt.command, payload: { decision: receipt.command.payload.decision } } }] });
  assert.deepEqual(initializeProject(legacy, project), receipt.result);
  assert.throws(() => initializeProject(legacy, { ...project, timezone: 'Asia/Jerusalem' }), /idempotency_conflict/);
});

test('1066-6: separator whitespace and a trailing newline can be classified independently', (t) => {
  const { store } = setup(t);
  const original = 'Export.\n \tKeep history.\n';
  const { request } = capture(store, original);
  const separator = { ...mapping(request.id, 'Export.\n \t'.length), start: 'Export.'.length,
    target: { kind: 'disposition', disposition: 'non_work_conversation' } };
  const first = mapRequest(store, separator);
  assert.equal(first.mappings[0]?.text, '\n \t');
  const second = mapRequest(store, { ...separator, start: original.length - 1, end: original.length,
    expectedRevision: 2, idempotencyKey: 'map-trailing-newline' });
  assert.equal(second.mappings[1]?.text, '\n');
  assert.deepEqual(second.unmapped.map((range) => range.text), ['Export.', 'Keep history.']);
});

test('1066-8: capture and mapping replays retain their original revisions', (t) => {
  const { store, dir } = setup(t);
  const first = capture(store);
  const input = mapping(first.request.id);
  const mapped = mapRequest(store, input);
  const corrected = mapRequest(store, { ...input, expectedRevision: 2, idempotencyKey: 'correct-replay-case',
    replaces: [mapped.mappings[0]!.decision], target: { kind: 'disposition', disposition: 'deferral' } });
  const delivered = deliverRequest(store, project.id, first.request.id, { fmHome: scratchFirstMate(dir) });
  assert.equal(delivered.state, 'succeeded');
  assert.deepEqual(capture(store), first);
  assert.deepEqual(mapRequest(store, input), mapped);
  assert.deepEqual(requestCoverage(store, project.id, first.request.id), corrected);
});

test('1066-9: the unclassified view reads project history once', (t) => {
  const { store } = setup(t);
  const unmapped = capture(store, originalText, 'unmapped').request;
  const partial = capture(store, originalText, 'partial').request;
  const covered = capture(store, originalText, 'covered').request;
  const input = { ...mapping(partial.id), target: { kind: 'disposition', disposition: 'deferral' } };
  mapRequest(store, input);
  mapRequest(store, { ...input, requestId: covered.id, end: originalText.length, idempotencyKey: 'cover-all' });
  const read = t.mock.method(store, 'history');
  const result = unclassifiedRequests(store, project.id);
  assert.deepEqual(result.map((request) => request.id).sort(), [unmapped.id, partial.id].sort());
  assert.equal(result.find((request) => request.id === partial.id)?.coverage.mappings[0]?.disposition, 'deferral');
  assert.equal(read.mock.callCount(), 1);
});

test('capture application rolls back request and delivery when the database fails', (t) => {
  const { store, path } = setup(t);
  const before = store.history(project.id);
  const faults = new DatabaseSync(path);
  faults.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON record_history WHEN NEW.kind = 'operation' BEGIN SELECT RAISE(ABORT, 'outbox_fault'); END");
  assert.throws(() => capture(store), /outbox_fault/);
  assert.deepEqual(store.history(project.id), before);
  faults.close();
});

test('mapping leaves omitted history behavior visible; correction preserves the original and prior mapping', (t) => {
  const { store, path } = setup(t);
  const { request } = capture(store);
  const input = mapping(request.id);
  const mapped = mapRequest(store, input);
  assert.equal(mapped.originalText, originalText);
  assert.equal(mapped.mappings[0]?.feature?.id, 'export');
  assert.equal(mapped.mappings[0]?.criteria[0]?.id, 'export-all');
  assert.equal(mapped.unmapped[0]?.text, '\r\nKeep history, too. 😀\n');
  assert.equal(mapped.structuralCoverageComplete, false);
  assert.equal(mapped.semanticReview, 'not_performed');
  assert.equal(unclassifiedRequests(store, project.id)[0]?.id, request.id);
  assert.deepEqual(mapRequest(store, input), mapped);
  const priorMapping = mapped.mappings[0]!.decision;
  const corrected = mapRequest(store, { ...input, expectedRevision: 2, idempotencyKey: 'correct-mapping',
    issuedAt: '2026-11-10T12:01:00.000Z', replaces: [priorMapping],
    originalInstruction: 'Defer export until the format is clarified; keep the history request.',
    rationale: 'Record the correction separately from the original request',
    target: { kind: 'disposition', disposition: 'deferral' },
  });
  assert.equal(corrected.originalText, originalText);
  assert.equal(corrected.mappings[0]?.disposition, 'deferral');
  assert.equal(corrected.unmapped[0]?.text, mapped.unmapped[0]?.text);
  assert.equal(store.get(project.id, priorMapping.id, priorMapping.revision)?.kind, 'decision_change');
  assert.equal(store.get(project.id, request.id, 1)?.kind, 'request');
  assert.ok(validateRecords(store.history(project.id)).ok);
  const reopened = new ProjectStore(path);
  try { assert.deepEqual(requestCoverage(reopened, project.id, request.id), corrected); }
  finally { reopened.close(); }
});

test('fully mapped work leaves unclassified view and invalid ranges or stale corrections do not write', (t) => {
  const { store } = setup(t);
  const { request } = capture(store);
  const mapped = mapRequest(store, mapping(request.id, originalText.length));
  assert.equal(mapped.structuralCoverageComplete, true);
  assert.deepEqual(unclassifiedRequests(store, project.id), []);
  const before = store.history(project.id);
  assert.throws(() => mapRequest(store, { ...mapping(request.id), idempotencyKey: 'stale' }), /revision_conflict/);
  assert.throws(() => mapRequest(store, { ...mapping(request.id), idempotencyKey: 'bad-range', expectedRevision: 2,
    end: originalText.length + 1, target: { kind: 'disposition', disposition: 'clarification' } }), /invalid_request_range/);
  assert.deepEqual(store.history(project.id), before);
});

for (const disposition of ['clarification', 'deferral', 'duplication', 'non_work_conversation']) {
  test(`explicit ${disposition} covers a source range without inventing a feature`, (t) => {
    const { store } = setup(t);
    const { request } = capture(store);
    const result = mapRequest(store, { ...mapping(request.id, originalText.length),
      target: { kind: 'disposition', disposition } });
    assert.equal(result.mappings[0]?.disposition, disposition);
    assert.equal(result.mappings[0]?.feature, null);
    assert.deepEqual(result.unmapped, []);
    assert.deepEqual(unclassifiedRequests(store, project.id), []);
    assert.equal(store.records(project.id).some((record) => record.kind === 'feature_revision'), false);
  });
}

test('existing feature and criterion mapping validates their source, kind and ownership', (t) => {
  const { store } = setup(t);
  const { request } = capture(store);
  const first = mapRequest(store, mapping(request.id));
  const before = store.history(project.id);
  assert.throws(() => mapRequest(store, { ...mapping(request.id), expectedRevision: 2, idempotencyKey: 'wrong-kind',
    target: { kind: 'feature', feature: { id: request.id, revision: 1 }, criteria: [] } }), /Expected feature_revision/);
  assert.deepEqual(store.history(project.id), before);
  const complete = mapRequest(store, { ...mapping(request.id, originalText.length), expectedRevision: 2,
    idempotencyKey: 'existing', start: first.mappings[0]!.end,
    target: { kind: 'feature', feature: { id: 'export', revision: 1 }, criteria: [{ id: 'export-all', revision: 1 }] } });
  assert.equal(complete.structuralCoverageComplete, true);
});

test('a correction that shrinks a mapping restores omitted text, and payload changes cannot reuse its key', (t) => {
  const { store } = setup(t);
  const { request } = capture(store);
  const first = mapRequest(store, mapping(request.id, originalText.length));
  const correction = { ...mapping(request.id), expectedRevision: 2, idempotencyKey: 'shrink',
    replaces: [first.mappings[0]!.decision], originalInstruction: 'Only the first sentence belongs to export.',
    target: { kind: 'feature', feature: { id: 'export', revision: 1 }, criteria: [{ id: 'export-all', revision: 1 }] } };
  const result = mapRequest(store, correction);
  assert.equal(result.unmapped[0]?.text, '\r\nKeep history, too. 😀\n');
  assert.equal(unclassifiedRequests(store, project.id).length, 1);
  assert.throws(() => mapRequest(store, { ...correction, rationale: 'Changed meaning with the same key' }), /idempotency_conflict/);
  assert.throws(() => mapRequest(store, { ...correction, idempotencyKey: 'stale-replacement', expectedRevision: 3 }), /not_current/);
});

test('mixed feature/disposition coverage is complete without an unclassified remainder', (t) => {
  const { store } = setup(t);
  const { request } = capture(store);
  const first = mapRequest(store, mapping(request.id));
  const result = mapRequest(store, { ...mapping(request.id, originalText.length), start: first.mappings[0]!.end,
    expectedRevision: 2, idempotencyKey: 'defer-history', target: { kind: 'disposition', disposition: 'deferral' } });
  assert.equal(result.structuralCoverageComplete, true);
  assert.deepEqual(unclassifiedRequests(store, project.id), []);
});

test('delivery uses explicit scratch FM_HOME, literal argv, and stores the confirmed note ID', (t) => {
  const { store, dir } = setup(t);
  const home = scratchFirstMate(dir);
  const { request } = capture(store, 'Exact `literal` $(text) "quotes"\n--no-shell\n');
  const previousOverride = process.env.FM_STATE_OVERRIDE;
  process.env.FM_STATE_OVERRIDE = join(dir, 'unwanted-state');
  t.after(() => {
    if (previousOverride === undefined) delete process.env.FM_STATE_OVERRIDE;
    else process.env.FM_STATE_OVERRIDE = previousOverride;
  });
  assert.throws(() => deliverRequest(store, project.id, request.id, { fmHome: 'relative' }), /absolute_FM_HOME/);
  const delivered = deliverRequest(store, project.id, request.id, { fmHome: home });
  assert.equal(delivered.state, 'succeeded');
  assert.equal(delivered.externalReferences[0]?.uri, 'firstmate:inbox/fixture-note-1');
  const calls = readFileSync(join(home, 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls[0].home, home);
  assert.equal(calls[0].text, request.originalText);
  assert.deepEqual(calls[0].fmOverrides, []);
  assert.deepEqual(calls[0].args, ['note', '--request-id', request.id, '--json', '-']);
  assert.deepEqual(deliverRequest(store, project.id, request.id, { fmHome: home }), delivered);
  assert.equal(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n').length, 1);
});

test('stdin delivery preserves flag-like text, a lone dash, and prompts larger than an argv element', (t) => {
  const { store, dir } = setup(t);
  for (const [index, text] of ['--json', '-', '--help', 'large prompt '.repeat(25000)].entries()) {
    const home = scratchFirstMate(join(dir, `case-${index}`));
    const { request } = capture(store, text, `client-${index}`);
    assert.equal(deliverRequest(store, project.id, request.id, { fmHome: home }).state, 'succeeded');
    assert.equal(JSON.parse(readFileSync(join(home, 'saved.json'), 'utf8')).text, text);
  }
});

test('save followed by failed wake reconciles through replay to the same note, without recapture', (t) => {
  const { store, dir } = setup(t);
  const home = scratchFirstMate(dir);
  const { request } = capture(store);
  writeFileSync(join(home, 'mode'), 'exit-after-save');
  assert.equal(deliverRequest(store, project.id, request.id, { fmHome: home }).state, 'unknown');
  writeFileSync(join(home, 'mode'), '');
  const delivered = deliverRequest(store, project.id, request.id, { fmHome: home });
  assert.equal(delivered.state, 'succeeded');
  assert.equal(JSON.parse(delivered.reconciliation!.note).outcome, 'replay');
  assert.equal(JSON.parse(delivered.reconciliation!.note).id, 'fixture-note-1');
  assert.equal(store.records(project.id).filter((record) => record.kind === 'request').length, 1);
  assert.deepEqual(store.history(project.id).filter((record) => record.kind === 'operation').map((op) => op.state),
    ['pending', 'unknown', 'succeeded']);
});

for (const mode of ['malformed', 'wrong-request']) test(`untrusted ${mode} delivery response never claims success`, (t) => {
  const { store, dir } = setup(t);
  const home = scratchFirstMate(dir);
  const { request } = capture(store);
  writeFileSync(join(home, 'mode'), mode);
  const delivered = deliverRequest(store, project.id, request.id, { fmHome: home });
  assert.equal(delivered.state, 'unknown');
  assert.deepEqual(delivered.externalReferences, []);
});

test('saved but unannounced receipt preserves the recovery fact and does not recapture', (t) => {
  const { store, dir } = setup(t);
  const home = scratchFirstMate(dir);
  const { request } = capture(store);
  writeFileSync(join(home, 'mode'), 'not-announced');
  const delivered = deliverRequest(store, project.id, request.id, { fmHome: home });
  assert.equal(delivered.state, 'succeeded');
  assert.equal(JSON.parse(delivered.reconciliation!.note).announced, false);
  assert.equal(requestCoverage(store, project.id, request.id).originalText, originalText);
});

test('chat captures exact hook prompt, distinguishes repeated turns, and uses stable prompt IDs for replay', (t) => {
  const { store } = setup(t);
  const event = { hook_event_name: 'UserPromptSubmit', session_id: 'session', transcript_path: '/scratch/chat.jsonl', prompt: originalText };
  const first = captureChatPrompt(store, project.id, { ...event, prompt_id: 'turn-1' });
  assert.equal(first.request.channel, 'chat');
  assert.equal(first.request.originalText, originalText);
  assert.deepEqual(captureChatPrompt(store, project.id, { ...event, prompt_id: 'turn-1' }), first);
  assert.notEqual(captureChatPrompt(store, project.id, { ...event, prompt_id: 'turn-2' }).request.id, first.request.id);
  assert.notEqual(captureChatPrompt(store, project.id, event).request.id, captureChatPrompt(store, project.id, event).request.id);
  assert.throws(() => captureChatPrompt(store, project.id, { ...event, hook_event_name: 'Stop' }));
});

test('channel coverage defaults to manual chat fallback; configured hook is scoped to this project and database', (t) => {
  const dir = scratch(t);
  const command = chatHookCommand(process.execPath, '/opt/factory/cli.js', join(dir, "quote's db.sqlite"), 'project');
  const noSettings = captureChannelCoverage(command);
  assert.deepEqual(noSettings.channels.map((row) => [row.channel, row.capture]),
    [['cli', 'manual'], ['chat', 'manual'], ['firstmate_inbox', 'manual']]);
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify(chatHookSettings(command)));
  assert.equal(captureChannelCoverage(command, [path]).channels[1]?.capture, 'automatic');
  assert.equal(captureChannelCoverage(command + ' different-project', [path]).channels[1]?.capture, 'manual');
  writeFileSync(path, JSON.stringify({ ...chatHookSettings(command), disableAllHooks: true }));
  assert.equal(captureChannelCoverage(command, [path]).channels[1]?.capture, 'manual');
  writeFileSync(path, '{bad JSON');
  assert.equal(captureChannelCoverage(command, [path]).channels[1]?.capture, 'manual');
  assert.equal(captureChannelCoverage(command, [join(dir, 'not-installed')]).channels[1]?.capture, 'manual');
  for (const extra of [{ async: true }, { if: 'some condition' }]) {
    const settings = chatHookSettings(command);
    Object.assign(settings.hooks.UserPromptSubmit[0]!.hooks[0]!, extra);
    writeFileSync(path, JSON.stringify(settings));
    assert.equal(captureChannelCoverage(command, [path]).channels[1]?.capture, 'manual');
  }
});

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('CLI entry point runs through an npm-style bin symlink', (t) => {
  const link = join(scratch(t), 'software-factory');
  symlinkSync(cliPath, link);
  assert.match(execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' }), /Software Factory request intake/);
});
test('CLI completes capture, mapping, coverage, delivery and a silent JSON hook in scratch homes', (t) => {
  const dir = scratch(t);
  const db = join(dir, 'cli.sqlite');
  const projectFile = join(dir, 'project.json');
  const textFile = join(dir, 'request.txt');
  writeFileSync(projectFile, JSON.stringify(project));
  writeFileSync(textFile, originalText);
  const cli = (args: string[], input?: string) => execFileSync(process.execPath, [cliPath, ...args, '--db', db],
    { encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  cli(['init', '--input', projectFile]);
  const first = JSON.parse(cli(['capture', '--project', project.id, '--client-request-id', 'cli-1',
    '--channel', 'cli', '--source', 'fixture:cli', '--text-file', textFile]));
  const mapFile = join(dir, 'mapping.json');
  writeFileSync(mapFile, JSON.stringify({ ...mapping(first.request.id), issuedAt: new Date().toISOString() }));
  const mapped = JSON.parse(cli(['map', '--input', mapFile]));
  assert.equal(mapped.originalText, originalText);
  const listed = JSON.parse(cli(['unclassified', '--project', project.id]));
  assert.equal(listed[0].coverage.unmapped[0].text, '\r\nKeep history, too. 😀\n');
  assert.equal(JSON.parse(cli(['coverage', '--project', project.id, '--request', first.request.id])).originalText, originalText);
  const home = scratchFirstMate(dir);
  assert.equal(JSON.parse(cli(['deliver', '--project', project.id, '--request', first.request.id, '--fm-home', home])).state, 'succeeded');
  assert.equal(cli(['chat-hook', '--project', project.id], JSON.stringify({ hook_event_name: 'UserPromptSubmit',
    session_id: 'cli-chat', transcript_path: '/scratch/session.jsonl', prompt: originalText })), '');
  assert.equal(JSON.parse(cli(['channels', '--project', project.id])).channels[1].capture, 'manual');
  const settingsFile = join(dir, 'hooks.json');
  writeFileSync(settingsFile, cli(['hook-settings', '--project', project.id]));
  assert.equal(JSON.parse(cli(['channels', '--project', project.id, '--settings', settingsFile])).channels[1].capture, 'automatic');
  assert.equal(JSON.parse(cli(['outbox', '--project', project.id])).length, 2);
  const bad = spawnSync(process.execPath, [cliPath, 'capture', '--db', db], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, 'validation');
});
