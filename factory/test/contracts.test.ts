import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import {
  ArtifactSchema, AssignmentSchema, CommandEnvelopeSchema, CommandNameSchema,
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

test('records enforce immutable boundary metadata', () => {
  for (const record of baseline) {
    assert.equal(RecordSchema.safeParse({ ...record, revision: 0 }).success, false);
    assert.equal(RecordSchema.safeParse({ ...record, revision: 1.5 }).success, false);
    assert.equal(RecordSchema.safeParse({ ...record, schemaVersion: 2 }).success, false);
    assert.equal(RecordSchema.safeParse({ ...record, updatedAt: '2020-01-01T00:00:00Z' }).success, false);
    const { projectId: _projectId, ...withoutProject } = record;
    assert.equal(RecordSchema.safeParse(withoutProject).success, false);
  }
});

test('1066-1: status-only completion can cite unchanged passing evidence', () => {
  const feature = byId('feature-1');
  assert.ok(feature.kind === 'feature_revision');
  const records = baseline.map((record) => record.id === feature.id ? { ...feature, state: 'in_review' } : record);
  const completionEvidence = { review: { id: 'review-1', revision: 1 }, reason: 'The reviewed scope and delivered revision are unchanged' };
  const complete = { ...feature, revision: 2, previousRevision: 1, state: 'complete',
    methodStage: 'product_review', changeReason: 'Record completion', completionEvidence };
  const valid = validateRecords([...records, complete]);
  assert.equal(valid.ok, true, JSON.stringify(valid));
  const repeated = validateRecords([...records, complete, { ...complete, revision: 3, previousRevision: 2 }]);
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  for (const candidate of [{ ...complete, completionEvidence: undefined },
    { ...complete, outcome: 'Changed outcome' }, { ...complete, completionEvidence: { ...completionEvidence, reason: ' ' } }]) {
    assert.equal(validateRecords([...records, candidate]).ok, false);
  }
  const failed = records.map((record) => record.kind === 'product_review' ? { ...record, outcome: 'failed' } : record);
  assert.equal(validateRecords([...failed, complete]).ok, false);
});

test('1066-2: the current feature governs dispatch of a historical assignment', () => {
  const feature = byId('feature-1');
  assert.ok(feature.kind === 'feature_revision');
  const successor = { ...feature, revision: 2, previousRevision: 1, state: 'in_progress', changeReason: 'Record status' };
  const assignment = { id: 'assignment-1', revision: 1 };
  const decision = { ...byId('decision-suggestion'), disposition: 'selected' };
  const historyWithDecision = baseline.map((record) => record.id === decision.id ? decision : record);
  assert.equal(validateAssignmentForDispatch([...baseline, successor], assignment).ok, true);
  assert.equal(validateAssignmentForDispatch([...baseline, { ...successor, priority: feature.priority + 1 }], assignment).ok, true);
  for (const [change, code] of [
    [{ disposition: { state: 'cancelled', reason: 'Stop work', decision: { id: decision.id, revision: 1 } } }, 'inactive_feature'],
    [{ outcome: 'Superseding product outcome' }, 'superseded_feature'],
  ] as const) {
    const records = [...historyWithDecision, { ...successor, ...change }];
    const history = validateRecords(records);
    assert.equal(history.ok, true, JSON.stringify(history));
    const result = validateAssignmentForDispatch(records, assignment);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === code));
  }
});

test('1066-3: passing review comparisons cite the exact design, plan and task revisions', () => {
  const design = byId('design-1');
  const plan = byId('plan-1');
  const task = byId('task-1');
  const review = byId('review-1');
  assert.ok(design.kind === 'design_revision' && plan.kind === 'implementation_plan_revision' &&
    task.kind === 'detailed_plan_task' && review.kind === 'product_review');
  const nextDesign = { id: design.id, revision: 2 };
  const nextPlan = { id: plan.id, revision: 2 };
  const nextTask = { id: task.id, revision: 2 };
  const history = [...baseline.filter((record) => record.id !== review.id), { ...design, ...nextDesign },
    { ...plan, ...nextPlan, design: nextDesign, deliverySequence: [nextTask], readiness: { ...plan.readiness,
      comparison: { ...plan.readiness.comparison, sourceRefs: [...plan.readiness.comparison.sourceRefs, { uri: 'fixture:design-v2', record: nextDesign }] } } },
    { ...task, ...nextTask, plan: nextPlan, design: nextDesign }];
  assert.equal(validateReviewForCompletion([...history, review], review).ok, true);
  for (const field of ['sourceComparison', 'instructionFidelity', 'planConformance'] as const) {
    for (const target of [nextDesign, nextPlan, nextTask]) {
      const comparison = review[field];
      const sources = comparison.sourceRefs.map((source) => source.record?.id === target.id ? { ...source, record: target } : source);
      const result = validateReviewForCompletion([...history, { ...review, [field]: { ...comparison, sourceRefs: sources } }], review);
      assert.equal(result.ok, false, `${field} accepted the wrong ${target.id} revision`);
      if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === 'omitted_source' && issue.recordId === review.id));
    }
  }
});

test('1066-4: dispatch requires the current managed mapping to be active and match', () => {
  const mapping = baseline.find((record) => record.kind === 'task_mapping');
  assert.ok(mapping);
  const assignment = { id: 'assignment-1', revision: 1 };
  const decision = { ...byId('decision-suggestion'), disposition: 'selected' };
  const history = baseline.map((record) => record.id === decision.id ? decision : record);
  for (const state of ['cancelled', 'deferred'] as const) {
    const disposition = { state, reason: 'Stop this execution task', decision: { id: decision.id, revision: 1 } };
    const records: unknown[] = [...history, { ...mapping, revision: 2, disposition }];
    assert.equal(validateRecords(records).ok, true);
    const result = validateAssignmentForDispatch(records, assignment);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === 'inactive_mapping'));
  }
  const remapped = [...baseline, { ...mapping, revision: 2, firstMateTaskId: 'replacement-task' }];
  assert.equal(validateRecords(remapped).ok, true);
  assert.equal(validateAssignmentForDispatch(remapped, assignment).ok, false);
});

function maintenanceWorkflow() {
  const design = RecordSchema.parse({ ...byId('design-1'), feature: null });
  const plan = RecordSchema.parse({ ...byId('plan-1'), feature: null });
  const task = RecordSchema.parse({ ...byId('task-1'), feature: null, criteria: [], maintenanceObjective: 'Remove the obsolete cache' });
  const mapping = RecordSchema.parse({ ...byId('mapping-1'), feature: null, criteria: [] });
  const assignment = RecordSchema.parse({ ...byId('assignment-1'), feature: null, criteria: [] });
  const request = RecordSchema.parse({ ...byId('request-1'), interpretationRefs: [] });
  assert.ok(design.kind === 'design_revision' && plan.kind === 'implementation_plan_revision' &&
    task.kind === 'detailed_plan_task' && assignment.kind === 'assignment');
  const records = [byId('project-1'), request, design, plan, task, mapping, assignment];
  return { records, design, plan, task, assignment, request };
}

test('1066-7: standalone maintenance can be planned, mapped and dispatched without a feature', () => {
  const { records, design, plan, task, assignment } = maintenanceWorkflow();
  const dispatched = validateAssignmentForDispatch(records, assignment);
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  assert.equal(validateRecords(records.map((record) => record.id === task.id ?
    { ...task, maintenanceObjective: undefined } : record)).ok, false);
  assert.equal(validateRecords([...records.map((record) => record.id === plan.id ?
    { ...plan, feature: { id: 'feature-1', revision: 1 } } : record),
  ...baseline.filter((record) => record.kind === 'feature_revision' || record.kind === 'criterion')]).ok, false);
  for (const fixture of commandFixtures.filter((item) => item.valid)) {
    const command = CommandEnvelopeSchema.parse(fixture.input);
    if (command.command === 'map_manage_execution_task' || command.command === 'prepare_assignment') {
      assert.equal(CommandEnvelopeSchema.safeParse({ ...command, payload: { ...command.payload, feature: null,
        ...(command.command === 'map_manage_execution_task' ? { criteria: [], detailedPlanTask: { id: task.id, revision: 1 } } : {}) } }).success, true);
    }
    if (command.command === 'design_plan_feature' && 'feature' in command.payload) {
      assert.equal(CommandEnvelopeSchema.safeParse({ ...command, payload: { ...command.payload, feature: null, design, plan, tasks: [task] } }).success, true);
    }
  }
});

test('1090-1: maintenance preserves original requests through design, plan and instruction comparisons', () => {
  const { records, design, plan, assignment, request } = maintenanceWorkflow();
  assert.equal(validateAssignmentForDispatch(records, assignment).ok, true);
  const omitRequest = (sources: typeof design.sourceRefs) => sources.filter((source) => source.record?.id !== request.id);
  for (const changed of [
    { ...assignment, instructionFidelity: { ...assignment.instructionFidelity,
      sourceRefs: omitRequest(assignment.instructionFidelity.sourceRefs) } },
    { ...design, sourceRefs: [...omitRequest(design.sourceRefs), { uri: 'repo://maintenance' }] },
    { ...design, sourceComparison: { ...design.sourceComparison,
      sourceRefs: [...omitRequest(design.sourceComparison.sourceRefs), { uri: 'repo://maintenance' }] } },
    { ...plan, readiness: { ...plan.readiness, comparison: { ...plan.readiness.comparison,
      sourceRefs: omitRequest(plan.readiness.comparison.sourceRefs) } } },
  ]) {
    const result = validateAssignmentForDispatch(records.map((record) => record.id === changed.id ? changed : record), assignment);
    assert.equal(result.ok, false, `Accepted omitted original request on ${changed.kind}`);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === 'omitted_source' && issue.recordId === changed.id));
  }
});

test('1090-3: maintenance results and review retain the objective and artifact evidence', () => {
  const { records, assignment, task, request } = maintenanceWorkflow();
  const template = byId('result-general');
  assert.ok(template.kind === 'criterion_result');
  const result = { ...template, criterion: null, accomplishedBehavior: task.maintenanceObjective! };
  const reviewTemplate = byId('review-1');
  assert.ok(reviewTemplate.kind === 'product_review');
  const review = { ...reviewTemplate, feature: null, results: [{ id: result.id, revision: result.revision }] };
  const otherRequest = { ...request, id: 'other-request', clientRequestId: 'other-client' };
  const history = [...records, otherRequest, result, review];
  const checked = validateReviewForCompletion(history, review);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const command = commandFixtures.map((fixture) => fixture.input).find((input) =>
    (input as { command?: string }).command === 'record_review_result') as Record<string, unknown>;
  const payload = command.payload as Record<string, unknown>;
  assert.equal(CommandEnvelopeSchema.safeParse({ ...command, payload: { ...payload,
    feature: null, results: [result], review } }).success, true);
  for (const changed of [
    { ...result, artifact: null }, { ...result, evidence: [] }, { ...result, result: 'untested' },
    { ...review, results: [] }, { ...review, baselineEvidence: [] }, { ...review, improvementEvidence: [] },
    { ...review, reviewedArtifacts: [{ uri: 'fixture:another-artifact', revision: '2' }] },
    { ...review, originalRequests: [{ id: 'other-request', revision: 1 }] },
    { ...review, instructionFidelity: { ...review.instructionFidelity,
      sourceRefs: review.instructionFidelity.sourceRefs.filter((source) => source.record?.id !== request.id) } },
    { ...review, instructionFidelity: { ...review.instructionFidelity, result: 'untested' } },
  ]) {
    const invalid = history.map((record) => record.id === changed.id ? changed : record);
    assert.equal(validateReviewForCompletion(invalid, review).ok, false, `Accepted incomplete maintenance evidence on ${changed.id}`);
  }
  const failed = { ...result, result: 'failed', artifact: null, evidence: [] };
  const failedReview = { ...review, outcome: 'failed' };
  assert.equal(validateRecords([...records, failed, failedReview]).ok, true);
  const product = baseline.find((record) => record.id === assignment.id)!;
  const invalidProduct = validateRecords([...baseline.filter((record) => record.id !== result.id),
    { ...result, assignment: { id: product.id, revision: product.revision } }]);
  assert.equal(invalidProduct.ok, false);
  if (!invalidProduct.ok) assert.ok(invalidProduct.issues.some((issue) => issue.code === 'unassigned_criterion'));
  assert.equal(records.some((record) => record.kind === 'feature_revision'), false);
  assert.equal(request.id, review.originalRequests[0]!.id);
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


test('artifact identity survives the JSON schema supplied to planning agents', () => {
  const supplied = z.fromJSONSchema(z.toJSONSchema(ArtifactSchema));
  assert.equal(supplied.safeParse({ uri: 'factory:future-output' }).success, false);
  for (const artifact of [{ uri: 'fixture:existing', revision: 'commit-1' }, { uri: 'fixture:existing', digest: 'sha256:known' }]) {
    assert.equal(supplied.safeParse(artifact).success, true);
    assert.equal(ArtifactSchema.safeParse(artifact).success, true);
  }
});
