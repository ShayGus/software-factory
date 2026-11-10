import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  CommandEnvelopeSchema, OperationSchema, ProjectStore, RecordsSchema, StoreError,
  pendingOperation, type FactoryRecord, type MutationCommand, type ProjectExport,
} from '../src/index.js';

const fixture = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const project = fixture.find((record) => record.kind === 'project')!;
const originalRequest = fixture.find((record) => record.kind === 'request')!;
const commandFixtures = JSON.parse(readFileSync(new URL('../../fixtures/commands.json', import.meta.url), 'utf8')) as
  { valid: boolean; input: unknown }[];
const capture = CommandEnvelopeSchema.parse(commandFixtures[0]!.input);
assert.ok(capture.command === 'capture_request');
const command = (key: string, targetId = 'request-1', expectedRevision = 0): MutationCommand => ({
  ...capture, targetId, expectedRevision, idempotencyKey: key,
});
function request(text = '  Preserve every connected system.\nERPNext is an example.\n'): FactoryRecord {
  assert.ok(originalRequest.kind === 'request');
  return { ...originalRequest, originalText: text, disposition: 'unclassified', interpretationRefs: [], dispositionRefs: [] };
}
function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-build-03-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'project.sqlite');
}
function store(t: TestContext, path = ':memory:'): ProjectStore {
  const db = new ProjectStore(path);
  t.after(() => db.close());
  return db;
}
function error(code: string, message: string) {
  return (value: unknown): boolean => {
    assert.ok(value instanceof StoreError);
    assert.equal(value.detail.code, code);
    assert.match(value.detail.message, new RegExp(message));
    return true;
  };
}
function seed(db: ProjectStore): void {
  db.importProject({ schemaVersion: 1, projectId: project.id, history: fixture, receipts: [] });
}

test('close/reopen retains exact original text, every revision, pending intent and first replay result', (t) => {
  const path = scratch(t);
  let db = new ProjectStore(path);
  const firstCommand = command('capture');
  const first = db.mutate(firstCommand, () => [project, request(), pendingOperation(firstCommand, 'delivery')]);
  const next = { ...request(), revision: 2, disposition: 'clarification', updatedAt: '2026-11-10T12:00:00Z' };
  db.mutate(command('clarify', 'request-1', 1), () => [next]);
  db.close();
  db = store(t, path);
  assert.deepEqual(db.get(project.id, 'request-1'), next);
  assert.deepEqual(db.get(project.id, 'request-1', 1), request());
  assert.equal(db.history(project.id).filter((record) => record.kind === 'request').length, 2);
  assert.equal(db.operations(project.id)[0]?.state, 'pending');
  const replay = { ...firstCommand, id: 'new-transport', issuedAt: '2026-11-11T00:00:00Z' };
  assert.deepEqual(db.mutate(replay, () => assert.fail('Replay must not run the handler')), first);
  assert.equal(db.history(project.id).length, 4);
});

test('stale writes conflict across two database connections and do not reserve the rejected key', (t) => {
  const path = scratch(t);
  const first = store(t, path);
  const second = store(t, path);
  first.mutate(command('capture'), () => [project, request()]);
  const revision2 = { ...request(), revision: 2, disposition: 'clarification' };
  second.mutate(command('second-writer', 'request-1', 1), () => [revision2]);
  assert.throws(() => first.mutate(command('stale', 'request-1', 1), () => assert.fail('Stale handler ran')),
    error('conflict', 'revision_conflict'));
  const result = first.mutate(command('stale', 'request-1', 2), () => [{ ...revision2, revision: 3 }]);
  assert.deepEqual(result.records, [{ id: 'request-1', revision: 3 }]);
});

test('same key and canonical payload replays; changed text, expected revision, target or command conflicts', (t) => {
  const db = store(t);
  const input = command('stable-key');
  const first = db.mutate(input, () => [project, request(), pendingOperation(input, 'delivery')]);
  const retry = { ...input, payload: Object.fromEntries(Object.entries(input.payload).reverse()) };
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(db.mutate(retry, () => assert.fail()), first);
  for (const changed of [
    { ...input, payload: { ...capture.payload, originalText: 'ERPNext only' } },
    { ...input, expectedRevision: 1 }, { ...input, targetId: 'another' },
    { ...input, command: 'capture_consolidate_learning', payload: {
      action: 'consolidate', scheduledWindowId: 'window', observationRefs: [], guidanceRefs: [], timezone: 'UTC',
    } },
  ]) assert.throws(() => db.mutate(changed, () => assert.fail()), error('validation', 'idempotency_conflict'));
  assert.equal(db.history(project.id).length, 3);
  assert.equal(db.exportProject(project.id).receipts.length, 1);
});

test('database failure after inserting records rolls back request, pending operation and receipt together', (t) => {
  const path = scratch(t);
  const db = store(t, path);
  const faults = new DatabaseSync(path);
  faults.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;`);
  const input = command('atomic');
  assert.throws(() => db.mutate(input, () => [project, request(), pendingOperation(input, 'delivery')]), /injected_failure/);
  assert.deepEqual(db.history(project.id), []);
  assert.deepEqual(db.operations(project.id), []);
  faults.exec('DROP TRIGGER fail_receipt');
  faults.close();
  db.mutate(input, () => [project, request(), pendingOperation(input, 'delivery')]);
  assert.equal(db.history(project.id).length, 3);
  assert.equal(db.exportProject(project.id).receipts.length, 1);
});

test('schemas and closed-context rules reject invalid writes without partial storage', (t) => {
  const db = store(t);
  assert.throws(() => db.mutate(command('bad'), () => [project, { ...request(), extra: 'unknown' }]),
    error('validation', 'Unrecognized key'));
  assert.throws(() => db.mutate(command('bad'), () => [request()]), error('validation', 'missing_project'));
  assert.throws(() => db.mutate(command('bad'), () => [project, { ...request(), interpretationRefs: [{ id: 'absent', revision: 1 }] }]),
    error('validation', 'missing_reference'));
  assert.deepEqual(db.history(project.id), []);
  assert.throws(() => db.mutate({ ...command('bad'), expectedRevision: -1 }, () => []), error('validation', 'Too small'));
  assert.throws(() => db.mutate(command('bad'), async () => [project]), error('validation', 'array'));
});

test('original capture fields cannot change and revisions cannot skip or change creation time', (t) => {
  const db = store(t);
  db.mutate(command('first'), () => [project, request()]);
  assert.throws(() => db.mutate(command('overwrite', 'request-1', 1), () => [
    { ...request('Changed original'), revision: 2 },
  ]), error('validation', 'source_mutation'));
  assert.throws(() => db.mutate(command('skip', 'request-1', 1), () => [{ ...request(), revision: 3 }]),
    error('conflict', 'revision_conflict'));
  assert.throws(() => db.mutate(command('creation', 'request-1', 1), () => [
    { ...request(), revision: 2, createdAt: '2026-11-10T10:00:00Z' },
  ]), error('validation', 'invalid_revision_transition'));
  assert.equal(db.history(project.id).length, 2);
});

test('all sixteen BUILD-02 record kinds persist and state-only feature updates create exact revisions', (t) => {
  const db = store(t);
  seed(db);
  assert.equal(new Set(db.records(project.id).map((record) => record.kind)).size, 16);
  const feature = db.get(project.id, 'feature-1');
  assert.ok(feature?.kind === 'feature_revision');
  const next = { ...feature, revision: 2, previousRevision: 1, state: 'in_progress', changeReason: 'Implementation started' };
  db.mutate(command('progress', feature.id, 1), () => [next]);
  assert.deepEqual(db.get(project.id, feature.id, 1), feature);
  assert.deepEqual(db.get(project.id, feature.id), next);
  assert.throws(() => db.mutate(command('complete', feature.id, 2), () => [
    { ...next, revision: 3, previousRevision: 2, state: 'complete', changeReason: 'Old review passed' },
  ]), error('validation', 'incomplete_feature'));
});

test('BUILD-02 additional expected revisions are checked before a multi-record design write', (t) => {
  const db = store(t);
  seed(db);
  const designInput = commandFixtures.find((entry) => entry.valid &&
    CommandEnvelopeSchema.parse(entry.input).command === 'design_plan_feature')!.input;
  const input = CommandEnvelopeSchema.parse(designInput);
  assert.ok(input.command === 'design_plan_feature');
  const changed = { ...input, payload: { ...input.payload, expectedRevisions: [{ id: 'design-1', revision: 2 }] } };
  assert.throws(() => db.mutate(changed, () => assert.fail('Stale dependent revision was ignored')),
    error('conflict', 'revision_conflict'));
});

test('a non-target record in a multi-record mutation also rejects a stale revision', (t) => {
  const db = store(t);
  db.mutate(command('capture'), () => [project, request()]);
  assert.throws(() => db.mutate(command('stale-other', project.id, 1), () => [request()]),
    error('conflict', 'revision_conflict'));
});

test('operation outcomes retain pending/succeeded/failed/unknown history and immutable identity', (t) => {
  const db = store(t);
  const input = command('capture');
  const pending = pendingOperation(input, 'delivery');
  db.mutate(input, () => [project, request(), pending]);
  let operation = pending;
  for (const state of ['unknown', 'failed', 'succeeded'] as const) {
    const next = OperationSchema.parse({ ...operation, revision: operation.revision + 1, state,
      externalReferences: [{ uri: 'fixture://external/request-001' }], reconciliation: {
        observedAt: '2026-11-10T12:00:00Z', observedState: state, note: 'Recorded observation; no execution',
        evidence: [{ artifact: { uri: 'fixture://receipt', revision: state }, description: state, observedAt: '2026-11-10T12:00:00Z' }],
      } });
    db.mutate(command(`observe-${state}`, operation.id, operation.revision), () => [next]);
    operation = next;
  }
  assert.deepEqual(db.history(project.id).filter((record) => record.kind === 'operation').map((record) => record.state),
    ['pending', 'unknown', 'failed', 'succeeded']);
  assert.throws(() => db.mutate(command('tamper', operation.id, 4), () => [
    { ...operation, revision: 5, idempotencyKey: 'changed' },
  ]), error('validation', 'operation_identity_change'));
  assert.deepEqual(db.mutate(input, () => assert.fail()).records.at(-1), { id: 'delivery', revision: 1 });
});

test('new pending operations must match the command digest and cannot silently claim success', (t) => {
  const db = store(t);
  const input = command('capture');
  const op = pendingOperation(input, 'delivery');
  assert.throws(() => db.mutate(input, () => [project, request(), { ...op, state: 'succeeded' }]),
    error('validation', 'new_operation_must_be_pending'));
  assert.throws(() => db.mutate(input, () => [project, request(), { ...op, idempotencyKey: 'another-key' }]),
    error('validation', 'idempotency_conflict'));
  assert.equal(db.history(project.id).length, 0);
});

test('whole-project JSON export/import round trip preserves history, operations, receipts and replay behavior', (t) => {
  const source = store(t, scratch(t));
  seed(source);
  const input = command('capture-new', 'request-new');
  source.mutate(input, () => [
    { ...request(), id: 'request-new', clientRequestId: 'req-new' }, pendingOperation(input, 'delivery-new'),
  ]);
  const update = command('update-new', 'request-new', 1);
  source.mutate(update, () => [{ ...source.get(project.id, 'request-new')!, revision: 2, disposition: 'clarification' }]);
  const exported = source.exportProject(project.id);
  const targetPath = scratch(t);
  let target = new ProjectStore(targetPath);
  target.importProject(JSON.parse(JSON.stringify(exported)));
  target.close();
  target = store(t, targetPath);
  assert.deepEqual(target.exportProject(project.id), exported);
  const receipt = exported.receipts.find((item) => item.command.idempotencyKey === input.idempotencyKey)!;
  assert.deepEqual(target.mutate(input, () => assert.fail('Restored command ran twice')), receipt.result);
  assert.deepEqual(target.operations(project.id), source.operations(project.id));
  assert.throws(() => target.mutate({ ...input, expectedRevision: 2 }, () => []), error('validation', 'idempotency_conflict'));
  assert.throws(() => target.importProject(exported), error('validation', 'import_requires_empty_store'));
});

test('malformed imports reject incomplete history, mutated originals and missing receipt results atomically', (t) => {
  const source = store(t);
  const input = command('capture');
  source.mutate(input, () => [project, request(), pendingOperation(input, 'delivery')]);
  source.mutate(command('next', 'request-1', 1), () => [{ ...request(), revision: 2 }]);
  const valid = source.exportProject(project.id);
  for (const alter of [
    (data: ProjectExport) => { data.history = data.history.filter((record) => !(record.id === 'request-1' && record.revision === 1)); },
    (data: ProjectExport) => { const r = data.history.find((record) => record.kind === 'request' && record.revision === 2)!;
      assert.ok(r.kind === 'request'); r.originalText = 'overwrite'; },
    (data: ProjectExport) => { data.receipts[0]!.result.records.push({ id: 'missing', revision: 1 }); },
    (data: ProjectExport) => { data.history[0]!.projectId = 'another-project'; },
  ]) {
    const invalid = structuredClone(valid);
    alter(invalid);
    const target = store(t);
    assert.throws(() => target.importProject(invalid), (value: unknown) => value instanceof StoreError);
    assert.deepEqual(target.history(project.id), []);
    target.importProject(valid);
  }
});

test('client request IDs and operation keys are unique within a project, and IDs remain global', (t) => {
  const db = store(t);
  const input = command('first');
  db.mutate(input, () => [project, request(), pendingOperation(input, 'delivery')]);
  assert.throws(() => db.mutate(command('duplicate', 'other-request'), () => [{ ...request(), id: 'other-request' }]),
    error('validation', 'duplicate_client_or_operation_key'));
  const otherProject = { ...project, id: 'project-2', projectId: 'project-2' };
  const other = { ...command('first'), projectId: 'project-2' };
  assert.throws(() => db.mutate(other, () => [otherProject, { ...request(), projectId: 'project-2' }]),
    error('validation', 'identity_change'));
  db.mutate({ ...other, targetId: 'request-2' }, () => [
    otherProject, { ...request(), id: 'request-2', projectId: 'project-2' },
  ]);
  assert.equal(db.get('project-2', 'request-2')?.revision, 1);
});

test('imported legacy operation without a replay receipt reserves its key', (t) => {
  const db = store(t);
  seed(db);
  const op = db.operations(project.id)[0]!;
  assert.throws(() => db.mutate({ ...command(op.idempotencyKey), expectedRevision: 1 }, () => assert.fail()),
    error('validation', 'operation_key_has_no_replay_receipt'));
});

test('read envelopes cannot mutate and missing exports report not_found', (t) => {
  const db = store(t);
  const input = CommandEnvelopeSchema.parse(commandFixtures.find((entry) => entry.valid &&
    CommandEnvelopeSchema.parse(entry.input).command === 'read_project_state_export')!.input);
  assert.throws(() => db.mutate(input, () => []), error('validation', 'read_command_is_not_mutation'));
  assert.throws(() => db.exportProject(project.id), error('not_found', 'project_not_found'));
});
