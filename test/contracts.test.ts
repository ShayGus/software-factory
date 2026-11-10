import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import {
  AssignmentSchema, CommandEnvelopeSchema, CommandNameSchema, CorrectionSchema,
  CriterionSchema, ExecutionObservationSchema, FeatureStateSchema, FirstMateInboxNoteSchema,
  FirstMateTaskMutationSchema, OperationSchema, RecordSchema, RecordsSchema,
  assertExpectedRevision, assertIdempotencyReuse, assertRevisionTransition, commandDigest,
  executionStateToken, validateAssignmentForDispatch, validateRecords, validateReviewForCompletion,
  type FactoryRecord, type ValidationResult,
} from '../src/index.js';

const fixtures = new URL('../../fixtures/', import.meta.url);
function json(name: string): unknown { return JSON.parse(readFileSync(new URL(name, fixtures), 'utf8')); }
const baseline = RecordsSchema.parse(json('workflow.json'));
const byId = (id: string): FactoryRecord => {
  const record = baseline.find((candidate) => candidate.id === id);
  assert.ok(record, `Missing baseline ${id}`);
  return structuredClone(record);
};
const ScenarioSchema = z.strictObject({
  description: z.string(),
  edits: z.array(z.strictObject({
    record: z.strictObject({ id: z.string(), revision: z.number() }),
    path: z.array(z.union([z.string(), z.number()])).min(1), value: z.json(),
  })),
  addRecords: z.array(z.json()),
  expected: z.strictObject({ valid: z.boolean(), codes: z.array(z.string()) }),
  gate: z.enum(['records', 'dispatch', 'completion']),
  target: z.strictObject({ id: z.string(), revision: z.number() }).optional(),
});

for (const name of readdirSync(new URL('scenarios/', fixtures)).filter((file) => file.endsWith('.json')).sort()) {
  const scenario = ScenarioSchema.parse(json(`scenarios/${name}`));
  test(`fixture ${name}: ${scenario.description}`, () => {
    const records: unknown[] = structuredClone(baseline);
    for (const edit of scenario.edits) {
      const record = records.find((value) => {
        const object = value as Record<string, unknown>;
        return object.id === edit.record.id && object.revision === edit.record.revision;
      });
      assert.ok(record, 'Fixture edit must name an existing record');
      let object = record as Record<string | number, unknown>;
      for (const segment of edit.path.slice(0, -1)) {
        assert.ok(object[segment] !== null && typeof object[segment] === 'object', 'Invalid fixture path');
        object = object[segment] as Record<string | number, unknown>;
      }
      object[edit.path.at(-1)!] = edit.value;
    }
    records.push(...scenario.addRecords);
    // Every expanded JSON fixture goes through both the record schemas and graph rules.
    const structural = validateRecords(records);
    let result: ValidationResult<unknown> = structural;
    if (scenario.gate !== 'records') {
      assert.ok(scenario.target);
      result = scenario.gate === 'dispatch' ? validateAssignmentForDispatch(records, scenario.target) :
        validateReviewForCompletion(records, scenario.target);
    }
    const issues = result.ok ? [] : result.issues;
    assert.equal(result.ok, scenario.expected.valid, JSON.stringify(issues, null, 2));
    for (const code of scenario.expected.codes) assert.ok(issues.some((issue) => issue.code === code),
      `Expected ${code}, got ${JSON.stringify(issues)}`);
    // A failed fidelity/review gate is allowed to remain truthful historical data.
    if (name === 'erpnext-narrowed-assignment.json' || name === 'erpnext-product-rejection.json') {
      assert.equal(structural.ok, true, JSON.stringify(structural));
    }
  });
}

const CommandFixtureSchema = z.array(z.strictObject({ valid: z.boolean(), input: z.json() }));
const commandFixtures = CommandFixtureSchema.parse(json('commands.json'));
for (const [index, fixture] of commandFixtures.entries()) {
  test(`command envelope fixture ${index + 1}`, () => {
    const result = CommandEnvelopeSchema.safeParse(fixture.input);
    assert.equal(result.success, fixture.valid, result.success ? '' : result.error.message);
  });
}
test('fixtures cover all nine operation families', () => {
  const commands = commandFixtures.filter((fixture) => fixture.valid)
    .map((fixture) => CommandEnvelopeSchema.parse(fixture.input).command);
  assert.deepEqual([...new Set(commands)].sort(), [...CommandNameSchema.options].sort());
});

const ExternalFixtureSchema = z.strictObject({
  source: z.string(), schema: z.enum(['inbox', 'task_mutation', 'execution']),
  valid: z.boolean(), input: z.json(), expectedToken: z.string().optional(),
});
for (const name of readdirSync(new URL('firstmate/', fixtures)).filter((file) => file.endsWith('.json')).sort()) {
  const fixture = ExternalFixtureSchema.parse(json(`firstmate/${name}`));
  test(`FirstMate sample ${name}`, () => {
    const schema = { inbox: FirstMateInboxNoteSchema, task_mutation: FirstMateTaskMutationSchema,
      execution: ExecutionObservationSchema }[fixture.schema];
    const result = schema.safeParse(fixture.input);
    assert.equal(result.success, fixture.valid, result.success ? '' : result.error.message);
    if (fixture.expectedToken) assert.equal(executionStateToken(fixture.input), fixture.expectedToken);
  });
}

test('all sixteen record types are exercised, with immutable boundary metadata', () => {
  assert.equal(new Set(baseline.map((record) => record.kind)).size, 16);
  for (const record of baseline) {
    assert.equal(RecordSchema.safeParse({ ...record, revision: 0 }).success, false);
    assert.equal(RecordSchema.safeParse({ ...record, revision: 1.5 }).success, false);
    assert.equal(RecordSchema.safeParse({ ...record, schemaVersion: 2 }).success, false);
    assert.equal(RecordSchema.safeParse({ ...record, updatedAt: '2020-01-01T00:00:00Z' }).success, false);
    const { projectId: _projectId, ...withoutProject } = record;
    assert.equal(RecordSchema.safeParse(withoutProject).success, false);
  }
});
test('requested criteria default to required without mutating captured source text', () => {
  const original = byId('criterion-general');
  assert.equal(original.kind, 'criterion');
  if (original.kind !== 'criterion') return;
  const { requirement: _requirement, ...input } = original;
  assert.equal(CriterionSchema.parse(input).requirement, 'required');
  const text = '  Keep exact original text.\n';
  const request = byId('request-1');
  assert.equal(RecordSchema.parse({ ...request, originalText: text }).kind, 'request');
  assert.equal((RecordSchema.parse({ ...request, originalText: text }) as { originalText: string }).originalText, text);
});
test('acknowledgement does not invent incorporation', () => {
  const observation = byId('observation-1');
  assert.equal(observation.kind, 'observation');
  if (observation.kind !== 'observation' || !observation.correction) return;
  const correction = CorrectionSchema.parse(observation.correction);
  assert.ok(correction.facts.some((fact) => fact.fact === 'acknowledged'));
  assert.equal(correction.facts.some((fact) => fact.fact === 'incorporated'), false);
});
test('unknown execution and cancelled dispositions cannot become feature-state tokens', () => {
  assert.equal(FeatureStateSchema.safeParse('unknown').success, false);
  assert.equal(FeatureStateSchema.safeParse('cancelled').success, false);
  assert.equal(FeatureStateSchema.safeParse('done').success, false);
});
test('expected revisions use zero for creation and reject stale writes', () => {
  assert.doesNotThrow(() => assertExpectedRevision(0, null));
  assert.doesNotThrow(() => assertExpectedRevision(4, 4));
  assert.throws(() => assertExpectedRevision(3, 4), /revision_conflict/);
  assert.throws(() => assertExpectedRevision(0, 1), /revision_conflict/);
  assert.throws(() => assertExpectedRevision(1, null), /revision_conflict/);
  assert.throws(() => assertExpectedRevision(0, 0), /revision_conflict/);
});
test('record revisions increment one step and retain identity, creation time and source history', () => {
  const previous = byId('request-1');
  const next = { ...previous, revision: 2, disposition: 'clarification' };
  assert.doesNotThrow(() => assertRevisionTransition(previous, next));
  assert.throws(() => assertRevisionTransition(previous, { ...next, revision: 3 }), /invalid_revision_transition/);
  assert.throws(() => assertRevisionTransition(previous, { ...next, id: 'other-request' }), /invalid_revision_transition/);
  assert.throws(() => assertRevisionTransition(previous, { ...next, originalText: 'ERPNext only' }), /source_mutation/);
});
test('idempotency replay excludes transport IDs/time and canonicalizes object keys', () => {
  const input = commandFixtures[0]!.input;
  const command = CommandEnvelopeSchema.parse(input);
  assert.equal(command.command, 'capture_request');
  if (command.command !== 'capture_request') return;
  const operation = OperationSchema.parse({ ...byId('operation-1'), command: command.command,
    idempotencyKey: command.idempotencyKey, payloadDigest: commandDigest(command) });
  const replay = { ...command, id: 'new-transport-id', issuedAt: '2026-11-10T11:00:00Z',
    payload: Object.fromEntries(Object.entries(command.payload).reverse()) };
  assert.equal(commandDigest(command), commandDigest(replay));
  assert.doesNotThrow(() => assertIdempotencyReuse(operation, CommandEnvelopeSchema.parse(replay)));
  assert.throws(() => assertIdempotencyReuse(operation, { ...command,
    payload: { ...command.payload, originalText: 'ERPNext only' } }), /idempotency_conflict/);
  assert.throws(() => assertIdempotencyReuse(operation, { ...command, expectedRevision: 2 }), /idempotency_conflict/);
  assert.throws(() => assertIdempotencyReuse(operation, { ...command, projectId: 'another-project' }), /idempotency_conflict/);
});
test('truncated assignment context preserves its extract and reachable original source', () => {
  const assignment = AssignmentSchema.parse(byId('assignment-1'));
  assert.equal(AssignmentSchema.safeParse({ ...assignment,
    selectedContext: [{ source: { uri: 'fixture://original' }, truncated: true }] }).success, false);
});
