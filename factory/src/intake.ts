import { createHash, randomUUID } from 'node:crypto';
import { reusableAnswer } from './decision-context.js';
import { z } from 'zod';
import { CaptureRequestCommandSchema, RecordDecisionSuggestionCommandSchema } from './commands.js';
import { IdSchema, RefSchema, TextSchema, TimestampSchema, type Ref } from './primitives.js';
import {
  DecisionChangeSchema, ProjectSchema, RequestSchema, type FactoryRecord, type Request,
  type DecisionChange, type FeatureRevision, type Criterion,
} from './records.js';
import { pendingOperation, ProjectStore, StoreError } from './store.js';

export const stableId = (namespace: string, ...parts: string[]) =>
  `${namespace}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
export const ref = ({ id, revision }: Ref): Ref => ({ id, revision });
const same = (a: Ref, b: Ref) => a.id === b.id && a.revision === b.revision;
const now = () => new Date().toISOString();
export function requestRecord(store: ProjectStore, projectId: string, id: string, revision?: number): Request {
  const value = store.get(projectId, id, revision);
  if (value?.kind !== 'request') throw new StoreError('not_found', 'request_not_found');
  return value;
}

export function initializeProject(store: ProjectStore, input: unknown) {
  const project = ProjectSchema.parse(input);
  const decision = DecisionChangeSchema.parse({
    kind: 'decision_change', id: stableId('initialize', project.id), projectId: project.id,
    schemaVersion: 1, revision: 1, createdAt: project.createdAt, updatedAt: project.updatedAt,
    questionOrChange: 'Initialize project', affectedRecords: [ref(project)], rationale: project.goal,
    disposition: 'selected', sourceRefs: [{ uri: 'factory:project-initialization' }], scopeChanges: [],
  });
  return store.mutate({ schemaVersion: 1, id: randomUUID(), projectId: project.id,
    issuedAt: project.createdAt, idempotencyKey: stableId('initialize-key', project.id),
    command: 'record_decision_suggestion', targetId: project.id, expectedRevision: 0,
    payload: { decision, project },
  }, () => [project, decision]);
}

export const CaptureInputSchema = CaptureRequestCommandSchema.shape.payload.extend({
  projectId: IdSchema, capturedAt: TimestampSchema.optional(),
});
export function captureRequest(store: ProjectStore, input: unknown) {
  const data = CaptureInputSchema.parse(input);
  return store.withTaskLock(data.projectId, () => captureRequestIntent(store, data));
}
function captureRequestIntent(store: ProjectStore, input: unknown) {
  const data = CaptureInputSchema.parse(input);
  store.assertExternalOperationsAllowed(data.projectId);
  const id = stableId('request', data.projectId, data.clientRequestId);
  const existing = store.get(data.projectId, id);
  const capturedAt = data.capturedAt ?? (existing?.kind === 'request' ? existing.capturedAt : now());
  const { projectId, ...payload } = data;
  const command = CaptureRequestCommandSchema.parse({
    schemaVersion: 1, id: randomUUID(), projectId, issuedAt: capturedAt,
    idempotencyKey: stableId('capture', projectId, data.clientRequestId), command: 'capture_request',
    targetId: id, expectedRevision: 0, payload: { ...payload, capturedAt },
  });
  const operationId = stableId('delivery', id);
  const result = store.mutate(command, () => [RequestSchema.parse({
    kind: 'request', id, projectId, schemaVersion: 1, revision: 1,
    createdAt: capturedAt, updatedAt: capturedAt, ...command.payload,
    interpretationRefs: [], disposition: 'unclassified', dispositionRefs: [],
  }), pendingOperation(command, operationId)]);
  const request = result.records.find((record) => record.id === id)!;
  const operation = result.records.find((record) => record.id === operationId)!;
  return { request: requestRecord(store, projectId, request.id, request.revision),
    operation: store.get(projectId, operation.id, operation.revision) };
}

const NewFeatureSchema = z.strictObject({
  id: IdSchema, outcome: TextSchema,
  criteria: z.array(z.strictObject({ id: IdSchema, expectedBehavior: TextSchema, verificationMethod: TextSchema })),
});
export const MapRequestInputSchema = z.strictObject({
  projectId: IdSchema, requestId: IdSchema, expectedRevision: z.number().int().positive(),
  idempotencyKey: IdSchema, issuedAt: TimestampSchema,
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  rationale: TextSchema, originalInstruction: TextSchema.optional(), replaces: z.array(RefSchema).default([]),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('feature'), feature: RefSchema, criteria: z.array(RefSchema) }),
    z.strictObject({ kind: z.literal('new_feature'), feature: NewFeatureSchema }),
    z.strictObject({ kind: z.literal('disposition'), disposition: z.enum([
      'clarification', 'deferral', 'duplication', 'non_work_conversation',
    ]) }),
  ]),
});

export function mapRequest(store: ProjectStore, input: unknown) {
  const data = MapRequestInputSchema.parse(input);
  const request = requestRecord(store, data.projectId, data.requestId);
  // Every mapping points to the original capture, even after corrections.
  const sourceRequest = { id: request.id, revision: 1 };
  const source = { uri: `factory:request/${encodeURIComponent(request.id)}#chars=${data.start},${data.end}`,
    record: sourceRequest, excerpt: request.originalText.slice(data.start, data.end) };
  const id = stableId('mapping', data.projectId, data.idempotencyKey);
  const base = { projectId: data.projectId, schemaVersion: 1 as const, revision: 1,
    createdAt: data.issuedAt, updatedAt: data.issuedAt };
  const intakeRecords: (FeatureRevision | Criterion)[] = [];
  let feature: Ref | null = null;
  let criteria: Ref[] = [];
  if (data.target.kind === 'new_feature') {
    const draft = data.target.feature;
    feature = { id: draft.id, revision: 1 };
    criteria = draft.criteria.map((criterion) => ({ id: criterion.id, revision: 1 }));
    intakeRecords.push({ ...base, kind: 'feature_revision', id: draft.id, outcome: draft.outcome,
      sourceRequests: [sourceRequest], criteria, exclusions: [], priority: 0, decisions: [{ id, revision: 1 }],
      changeReason: data.rationale, state: 'requested', methodStage: 'understanding', disposition: { state: 'active' } });
    intakeRecords.push(...draft.criteria.map((criterion): Criterion => ({ ...base, ...criterion,
      kind: 'criterion', featureId: draft.id, requirement: 'required', sourceRefs: [source],
      disposition: { state: 'active' } })));
  } else if (data.target.kind === 'feature') {
    feature = data.target.feature;
    criteria = data.target.criteria;
  }
  const decision = DecisionChangeSchema.parse({ ...base, kind: 'decision_change', id,
    questionOrChange: 'Classify request content', affectedRecords: [sourceRequest, ...(feature ? [feature] : []), ...criteria],
    rationale: data.rationale, disposition: 'selected', sourceRefs: [source], scopeChanges: [],
    ...(data.originalInstruction === undefined ? {} : { originalInstruction: data.originalInstruction }),
    requestMapping: { request: sourceRequest, start: data.start, end: data.end,
      disposition: data.target.kind === 'disposition' ? data.target.disposition : 'work',
      feature, criteria, replaces: data.replaces },
  });
  const command = RecordDecisionSuggestionCommandSchema.parse({
    schemaVersion: 1, id: randomUUID(), projectId: data.projectId, issuedAt: data.issuedAt,
    idempotencyKey: data.idempotencyKey, command: 'record_decision_suggestion',
    targetId: request.id, expectedRevision: data.expectedRevision, payload: { decision, intakeRecords },
  });
  const result = store.mutate(command, (history) => {
    if (data.start >= data.end || data.end > request.originalText.length) throw new StoreError('validation', 'invalid_request_range');
    for (const replaced of data.replaces) if (!request.dispositionRefs.some((linked) => same(linked, replaced))) {
      throw new StoreError('conflict', 'replacement_mapping_is_not_current');
    }
    const links = request.dispositionRefs.filter((linked) => !data.replaces.some((replaced) => same(linked, replaced)));
    links.push(ref(decision));
    const next = { ...request, revision: request.revision + 1, updatedAt: data.issuedAt, dispositionRefs: links };
    const records = [...history, ...intakeRecords, decision, next];
    const report = coverageFromRecords(next, mappingDecisions(records));
    const dispositions = new Set(report.mappings.map((mapping) => mapping.disposition));
    next.disposition = report.unmapped.length ? 'unclassified' : dispositions.has('work') ? 'work' :
      dispositions.size === 1 ? report.mappings[0]!.disposition : 'unclassified';
    next.interpretationRefs = report.mappings.flatMap((mapping) => mapping.feature ? [mapping.feature] : [])
      .filter((value, index, all) => all.findIndex((other) => same(value, other)) === index);
    return [...intakeRecords, decision, next];
  });
  const saved = result.records.find((record) => record.id === request.id)!;
  return coverageFromRecords(requestRecord(store, data.projectId, saved.id, saved.revision),
    mappingDecisions(store.history(data.projectId)));
}

const revisionKey = (ref: Ref) => JSON.stringify([ref.id, ref.revision]);
function mappingDecisions(records: FactoryRecord[]) {
  const decisions = new Map<string, DecisionChange>();
  for (const record of records) {
    if (record.kind === 'decision_change' && record.requestMapping) decisions.set(revisionKey(record), record);
  }
  return decisions;
}

function coverageFromRecords(request: Request, decisions: Map<string, DecisionChange>) {
  const mappings = request.dispositionRefs.flatMap((linked) => {
    const decision = decisions.get(revisionKey(linked));
    const mapping = decision?.requestMapping;
    if (!mapping || decision.disposition !== 'selected' || mapping.request.id !== request.id) return [];
    return [{ ...mapping, decision: ref(decision), text: request.originalText.slice(mapping.start, mapping.end) }];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const unmapped: { start: number; end: number; text: string }[] = [];
  let cursor = 0;
  for (const mapping of mappings) {
    if (mapping.start > cursor) unmapped.push({ start: cursor, end: mapping.start, text: request.originalText.slice(cursor, mapping.start) });
    cursor = Math.max(cursor, mapping.end);
  }
  if (cursor < request.originalText.length) unmapped.push({ start: cursor, end: request.originalText.length, text: request.originalText.slice(cursor) });
  return { request: ref(request), originalText: request.originalText, mappings, unmapped,
    structuralCoverageComplete: unmapped.length === 0, semanticReview: 'not_performed' as const };
}
export function requestCoverage(store: ProjectStore, projectId: string, requestId: string) {
  return coverageFromRecords(requestRecord(store, projectId, requestId), mappingDecisions(store.history(projectId)));
}
export function unclassifiedRequests(store: ProjectStore, projectId: string) {
  const history = store.history(projectId);
  const decisions = mappingDecisions(history);
  const latest = new Map<string, Request>();
  for (const record of history) if (record.kind === 'request') latest.set(record.id, record);
  return [...latest.values()].flatMap((request) => {
    const coverage = coverageFromRecords(request, decisions);
    return coverage.unmapped.length > 0 ? [{ ...request, coverage }] : [];
  });
}

/** Record product changes through the existing command family and transaction.
 * Kept independent of HTTP so agent/CLI edits have identical scope validation. */
export function recordDecisionSuggestion(store: ProjectStore, input: unknown) {
  const command = RecordDecisionSuggestionCommandSchema.parse(input);
  const { decision, intakeRecords = [], project } = command.payload;
  if (project) throw new StoreError('validation', 'use_project_initialization');
  if (command.targetId !== decision.id && !intakeRecords.some((record) => record.id === command.targetId)) {
    throw new StoreError('validation', 'command_must_target_written_record');
  }
  for (const record of intakeRecords) {
    if (!decision.affectedRecords.some((entry) => same(entry, record)) &&
      !intakeRecords.some((feature) => feature.kind === 'feature_revision' &&
        feature.criteria.some((entry) => same(entry, record)) && decision.affectedRecords.some((entry) => same(entry, feature)))) {
      throw new StoreError('validation', 'decision_must_name_written_revision');
    }
  }
  return store.mutate(command, () => {
    if (decision.answer) {
      const previous = store.get(command.projectId, decision.id);
      if (previous?.kind !== 'decision_change' || previous.choice?.kind !== 'product' || previous.choice.state !== 'open' ||
        decision.choice?.kind !== 'product' || decision.choice.state !== 'resolved' || decision.disposition !== 'selected' ||
        decision.questionOrChange !== previous.questionOrChange || JSON.stringify(decision.affectedRecords) !== JSON.stringify(previous.affectedRecords)) {
        throw new StoreError('validation', 'answer_requires_open_product_question');
      }
      if (decision.answer.reusedFrom) {
        const source = store.get(command.projectId, decision.answer.reusedFrom.id);
        if (source?.kind !== 'decision_change' || source.revision !== decision.answer.reusedFrom.revision ||
          !reusableAnswer(previous, source) || decision.answer.text !== source.answer?.text) {
          throw new StoreError('conflict', 'reusable_answer_changed');
        }
      }
    }
    return [decision, ...intakeRecords];
  });
}
