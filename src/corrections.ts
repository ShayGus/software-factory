import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { earlierCorrectionPending, intendedCorrectionRecipient, correctionTargetsAttempt, carriesCorrection, currentCorrections, outstandingTaskCorrections } from './correction-state.js';
import { DeliverCorrectionCommandSchema } from './commands.js';
import { executionStateToken } from './firstmate.js';
import { ref, stableId } from './intake.js';
import { EvidenceSchema, RefSchema, TimestampSchema, type CorrectionAction, type Ref } from './primitives.js';
import { ObservationSchema, type Assignment, type FactoryRecord, type Observation, type Operation } from './records.js';
import { commandDigest, validateAssignmentForDispatch } from './rules.js';
import { pendingOperation, ProjectStore, StoreError } from './store.js';
import { manageExecutionTask, TaskAdapterOptionsSchema } from './tasks.js';

type DeliveryRecipient = NonNullable<NonNullable<Observation['correction']>['deliveryRecipient']>;
type Correction = Observation & { correction: NonNullable<Observation['correction']> };
const current = (history: FactoryRecord[]) => {
  const records = new Map<string, FactoryRecord>();
  for (const record of history) if (record.revision > (records.get(record.id)?.revision ?? 0)) records.set(record.id, record);
  return [...records.values()];
};
const same = (a: Ref, b: Ref) => a.id === b.id && a.revision === b.revision;
const corrections = (records: FactoryRecord[]) => records.filter((record): record is Correction => record.kind === 'observation' && !!record.correction);
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const evidence = (id: string, text: string, at: string) => [{ artifact: { uri: `factory:correction/${id}`, digest: digest(text) }, description: text, observedAt: at }];
const fact = (record: Correction, name: string) => record.correction.facts.some((item) => item.fact === name);

/** The caller supplies a fresh, observed binding from its runtime read model.
 * No task ID, title, process exit, or empty snapshot implies an attempt binding. */
export const CorrectionAdapterOptionsSchema = z.strictObject({
  fmHome: z.string().min(1), sendExecutable: z.string().min(1), controlExecutable: z.string().min(1),
  stateExecutable: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(), maxObservationAgeMs: z.number().int().positive().default(30_000),
  recipients: z.array(z.strictObject({ assignment: RefSchema, attemptId: z.string().min(1), firstMateTaskId: z.string().min(1),
    state: z.enum(['active', 'stopped', 'unknown']), observedAt: TimestampSchema })),
  taskAdapter: TaskAdapterOptionsSchema.optional(),
});
export type CorrectionAdapterOptions = z.input<typeof CorrectionAdapterOptionsSchema>;

export function correctionOperation(action: CorrectionAction, urgentStop = false): string {
  if (action === 'status') return 'read_status';
  if (urgentStop && action !== 'cancellation') return 'interrupt';
  switch (action) {
    case 'clarification': case 'amended_scope': return 'steer';
    case 'resume': return 'relaunch';
    case 'rewind': return 'unsupported_rewind';
    case 'cancellation': return 'cancel_task';
    case 'new_work': return 'create_task';
  }
}

/** Resolve current attempts across IDs conservatively. Revisions order only one ID. */
export function currentAttempt(records: FactoryRecord[], taskId: string): Assignment | undefined {
  const assignments = current(records).filter((record): record is Assignment => record.kind === 'assignment' && record.firstMateTaskId === taskId);
  const time = Math.max(...assignments.map((assignment) => Date.parse(assignment.updatedAt)));
  const latest = assignments.filter((assignment) => Date.parse(assignment.updatedAt) === time);
  return latest.length === 1 ? latest[0] : undefined;
}

/** Store source, impact and intended operation atomically, before any external call.
 * Sequence is scoped to assignment ID (including amended revisions of that attempt).
 * Compatibility is explicit; prose is never guessed to be safely mergeable. */
export function queueCorrection(store: ProjectStore, input: unknown): { correction: Observation; operation: Operation } {
  const command = DeliverCorrectionCommandSchema.parse(input);
  const operationId = stableId('correction-operation', command.projectId, command.idempotencyKey);
  return store.withTaskLock(command.projectId, () => {
    const result = store.mutate(command, (history) => {
      const records = current(history); const payload = command.payload;
      if (command.expectedRevision !== 0) throw new StoreError('validation', 'corrections_are_append_only');
      const assignment = records.find((record) => record.kind === 'assignment' && same(record, payload.assignment));
      if (assignment?.kind !== 'assignment' || currentAttempt(records, assignment.firstMateTaskId)?.id !== assignment.id) {
        throw new StoreError('conflict', 'correction_requires_current_unambiguous_assignment');
      }
      const affected = records.find((record) => same(record, payload.affectedRevision));
      if (!affected || !['request', 'feature_revision'].includes(affected.kind) ||
        (affected.kind === 'feature_revision' ? assignment.feature?.id !== affected.id :
          !assignment.sourceRefs.some((source) => source.record?.id === affected.id))) {
        throw new StoreError('validation', 'correction_requires_current_linked_request_or_feature');
      }
      const action = payload.action;
      if (payload.carriedFrom) {
        const source = history.find((item) => item.kind === 'observation' && same(item, payload.carriedFrom!));
        if (source?.kind !== 'observation' || !source.correction || source.correction.supersededBy ||
          source.correction.originalText !== payload.originalCorrection || action !== 'clarification' ||
          !['clarification', 'amended_scope'].includes(source.correction.action) || source.correction.urgentStop ||
          intendedCorrectionRecipient(history, source as Correction)?.firstMateTaskId !== assignment.firstMateTaskId ||
          (source.id === command.targetId) || !assignment.correctionContext?.corrections.some((item) => item.id === source.id)) {
          throw new StoreError('validation', 'carried_correction_requires_same_task_and_preserved_source');
        }
      }
      if (payload.changedOutcome !== undefined && (action !== 'amended_scope' || affected.kind !== 'feature_revision')) {
        throw new StoreError('validation', 'changed_outcome_requires_feature_scope_amendment');
      }
      if (action === 'amended_scope' && !payload.changedOutcome) throw new StoreError('validation', 'scope_amendment_requires_changed_outcome');
      if (payload.urgentStop && ['resume', 'new_work', 'rewind', 'status'].includes(action)) throw new StoreError('validation', 'urgent_stop_conflicts_with_action');
      if (action === 'new_work' || action === 'cancellation') {
        const task = payload.taskCommand;
        if (!task || task.projectId !== command.projectId || task.payload.action !== (action === 'new_work' ? 'create' : 'cancel') ||
          (action === 'cancellation' && task.payload.task.firstMateTaskId !== assignment.firstMateTaskId)) {
          throw new StoreError('validation', 'correction_requires_matching_BUILD08_task_command');
        }
      } else if (payload.taskCommand) throw new StoreError('validation', 'unexpected_task_command');
      const previous = corrections(records).filter((record) => record.correction.assignment.id === assignment.id);
      if (payload.sequence !== Math.max(0, ...previous.map((record) => record.correction.sequence)) + 1) {
        throw new StoreError('conflict', 'correction_sequence_must_be_next');
      }
      if (payload.supersedes.length) throw new StoreError('validation', 'supersession_is_derived_from_compatible_pending_intents');
      const writes: FactoryRecord[] = [];
      const sourceRefs = payload.sourceRefs ?? [{ uri: `factory:correction-command/${command.id}`, excerpt: payload.originalCorrection }];
      const impacted = records.filter((record): record is Assignment => record.kind === 'assignment' &&
        (affected.kind === 'feature_revision' ? record.feature?.id === affected.id : record.sourceRefs.some((source) => source.record?.id === affected.id)) &&
        currentAttempt(records, record.firstMateTaskId)?.id === record.id);
      const changed = action === 'amended_scope';
      let revisedFeature = affected.kind === 'feature_revision' ? ref(affected) : assignment.feature;
      if (changed && affected.kind === 'feature_revision') {
        const decision = { kind: 'decision_change' as const, id: stableId('correction-decision', command.targetId),
          projectId: command.projectId, schemaVersion: 1 as const, revision: 1, createdAt: command.issuedAt, updatedAt: command.issuedAt,
          questionOrChange: 'Amend the requested outcome', originalInstruction: payload.originalCorrection,
          affectedRecords: [ref(affected), { id: affected.id, revision: affected.revision + 1 }],
          rationale: payload.originalCorrection, disposition: 'selected' as const, sourceRefs, scopeChanges: [] };
        writes.push(decision);
        const { completionEvidence: _completed, ...base } = affected;
        const next = { ...base, revision: affected.revision + 1, updatedAt: command.issuedAt,
          previousRevision: affected.revision, outcome: payload.changedOutcome!, changeReason: payload.originalCorrection,
          decisions: [...affected.decisions, ref(decision)],
          state: 'in_progress' as const, methodStage: 'planning' as const };
        writes.push(next); revisedFeature = ref(next);
      } else if (affected.kind === 'request') {
        writes.push({ ...affected, revision: affected.revision + 1, updatedAt: command.issuedAt,
          interpretationRefs: [...affected.interpretationRefs, { id: command.targetId, revision: 1 }] });
      }
      const amendmentRefs = new Map<string, Ref>();
      if (changed) for (const target of impacted) {
        const amended = { ...target, revision: target.revision + 1, updatedAt: command.issuedAt,
          instructionText: `${target.instructionText}\n\nCorrection ${command.targetId}:\n${payload.originalCorrection}`,
          correctionContext: { feature: revisedFeature, requiresReplan: true,
            corrections: [...(target.correctionContext?.corrections ?? []), { id: command.targetId, revision: 1 }] } };
        writes.push(amended); amendmentRefs.set(target.id, ref(amended));
      }
      const dependencies = changed ? records.filter((record) => record.kind === 'task_mapping' &&
        (record.feature?.id === affected.id || record.dependencies.some((id) => impacted.some((target) => target.firstMateTaskId === id)) ||
          record.management?.requirements.some((edge) => impacted.some((target) => target.detailedPlanTask.id === edge.prerequisiteTaskId)))) : [];
      const completedEvidence = changed ? records.filter((record) =>
        (record.kind === 'criterion_result' && impacted.some((target) => target.id === record.assignment.id)) ||
        (record.kind === 'product_review' && record.feature?.id === affected.id)) : [];
      const barrier = Math.max(0, ...previous.filter((record) => !record.correction.supersededBy &&
        (record.correction.action !== action || record.correction.compatibilityKey !== payload.compatibilityKey ||
          record.correction.urgentStop || fact(record, 'delivered'))).map((record) => record.correction.sequence));
      const compatible = previous.filter((record) => record.correction.sequence > barrier && !record.correction.supersededBy &&
        action === 'amended_scope' && record.correction.action === action && payload.compatibilityKey &&
        record.correction.compatibilityKey === payload.compatibilityKey && !payload.urgentStop && !record.correction.urgentStop &&
        !fact(record, 'delivered') && records.some((op) => op.kind === 'operation' && op.id === record.correction.operationId && op.state === 'pending'));
      // A message is retained verbatim; consolidation preserves all instructions and sources.
      const supersedes = compatible.map(ref);
      const observation = ObservationSchema.parse({ kind: 'observation', id: command.targetId, projectId: command.projectId,
        schemaVersion: 1, revision: 1, createdAt: command.issuedAt, updatedAt: command.issuedAt,
        finding: payload.originalCorrection, affectedScope: [{ uri: `factory:record/${affected.id}`, record: ref(affected) }, ...sourceRefs],
        evidence: [], proposedGeneralization: null, consolidationState: 'pending', correction: {
          action, originalText: payload.originalCorrection, assignment: amendmentRefs.get(assignment.id) ?? ref(assignment),
          affectedRevision: revisedFeature && changed ? revisedFeature : ref(affected), sequence: payload.sequence,
          supersedes, sourceRefs, urgentStop: payload.urgentStop ?? false, compatibilityKey: payload.compatibilityKey,
          operationId, carriedFrom: payload.carriedFrom,
          intendedRecipient: { assignment: amendmentRefs.get(assignment.id) ?? ref(assignment), attemptId: assignment.attemptId, firstMateTaskId: assignment.firstMateTaskId },
          impact: { assignments: impacted.map((target) => amendmentRefs.get(target.id) ?? ref(target)),
            dependencies: dependencies.map(ref), completedEvidence: completedEvidence.map(ref), requiresReplan: changed },
          facts: [{ fact: 'recorded', at: command.issuedAt, evidence: evidence(command.targetId, payload.originalCorrection, command.issuedAt) }],
        } });
      for (const prior of compatible) writes.push({ ...prior, revision: prior.revision + 1, updatedAt: command.issuedAt,
        correction: { ...prior.correction, supersededBy: ref(observation) } });
      return [...writes, observation, pendingOperation(command, operationId)];
    });
    const saved = result.records.find((record) => record.id === command.targetId)!;
    return { correction: store.get(command.projectId, saved.id, saved.revision) as Observation,
      operation: store.get(command.projectId, operationId) as Operation };
  });
}

function observation(store: ProjectStore, projectId: string, id: string): Correction {
  const record = store.get(projectId, id);
  if (record?.kind !== 'observation' || !record.correction) throw new StoreError('not_found', 'correction_not_found');
  return record as Correction;
}

/** Append facts through a CAS mutation. Acknowledgement requires a delivered
 * message; incorporation requires separate artifact evidence and current context. */
export function recordCorrectionFact(store: ProjectStore, input: unknown): Observation {
  const data = z.strictObject({ projectId: z.string().min(1), correction: RefSchema, assignment: RefSchema,
    fact: z.enum(['acknowledged', 'incorporated']), at: TimestampSchema, idempotencyKey: z.string().min(1),
    evidence: z.array(EvidenceSchema).min(1) }).parse(input);
  const record = observation(store, data.projectId, data.correction.id);
  const decision = decisionRecord(data.projectId, data.at, `Correction ${data.fact}`, data.evidence, [data.correction]);
  const command = { schemaVersion: 1, id: data.idempotencyKey, projectId: data.projectId, issuedAt: data.at,
    idempotencyKey: data.idempotencyKey, command: 'record_decision_suggestion', targetId: record.id,
    expectedRevision: data.correction.revision, payload: { decision: { ...decision, id: stableId('correction-fact', data.idempotencyKey),
      sourceRefs: [{ uri: `factory:assignment/${data.assignment.id}`, record: data.assignment }] } } };
  const result = store.mutate(command, (history) => {
    if (record.correction.supersededBy || !fact(record, 'delivered')) {
      throw new StoreError('validation', 'fact_requires_delivered_exact_recipient');
    }
    const delivered = record.correction.deliveryRecipient;
    const deliveredRef = delivered?.assignment ?? record.correction.assignment; // Legacy observations remain readable.
    if (data.fact === 'acknowledged' && !same(deliveredRef, data.assignment)) {
      throw new StoreError('validation', 'fact_requires_delivered_exact_recipient');
    }
    if (fact(record, data.fact)) throw new StoreError('conflict', 'correction_fact_already_recorded');
    if (data.fact === 'incorporated') {
      const original = history.find((entry) => entry.kind === 'assignment' && same(entry, deliveredRef));
      const assignment = history.find((entry) => entry.kind === 'assignment' && same(entry, data.assignment));
      if (original?.kind !== 'assignment' || assignment?.kind !== 'assignment' || original.id !== assignment.id ||
        assignment.attemptId !== (delivered?.attemptId ?? original.attemptId) ||
        assignment.firstMateTaskId !== (delivered?.firstMateTaskId ?? original.firstMateTaskId) ||
        !same(currentAttempt(history, assignment.firstMateTaskId) ?? { id: '', revision: 0 }, assignment)) {
        throw new StoreError('conflict', 'incorporation_requires_current_assignment_of_delivered_attempt');
      }
      if (!same(deliveredRef, assignment)) {
        const retained = assignment.correctionContext?.corrections.some((item) => item.id === record.id);
        const continuousAttempt = assignment.revision > deliveredRef.revision && history.filter((entry) =>
          entry.kind === 'assignment' && entry.id === original.id && entry.revision >= original.revision && entry.revision <= assignment.revision)
          .every((entry) => entry.kind === 'assignment' && entry.attemptId === original.attemptId && entry.firstMateTaskId === original.firstMateTaskId);
        const checked = validateAssignmentForDispatch(history, data.assignment);
        // Generated briefs keep their semantic judgment in external check evidence,
        // while the stored structural comparison stays untested (BUILD-07).
        const issues = checked.ok ? [] : checked.issues.filter((issue) => !(assignment.brief &&
          assignment.instructionFidelity.result === 'untested' && issue.recordId === assignment.id && issue.code === 'instruction_fidelity'));
        if (!retained || !continuousAttempt || assignment.correctionContext?.requiresReplan || issues.length) {
          throw new StoreError('validation', 'incorporation_requires_checked_successor_retaining_correction');
        }
      }
    }
    return [command.payload.decision, { ...record, revision: record.revision + 1, updatedAt: data.at,
      correction: { ...record.correction, ...(data.fact === 'incorporated' ? { incorporationAssignment: data.assignment } : {}),
        facts: [...record.correction.facts, { fact: data.fact, at: data.at, evidence: data.evidence }] } }];
  });
  const saved = result.records.find((entry) => entry.id === record.id)!;
  return store.get(data.projectId, saved.id, saved.revision) as Observation;
}
function decisionRecord(projectId: string, at: string, text: string, proof: z.infer<typeof EvidenceSchema>[], affectedRecords: Ref[]) {
  return { kind: 'decision_change' as const, id: randomUUID(), projectId, schemaVersion: 1 as const, revision: 1,
    createdAt: at, updatedAt: at, questionOrChange: text, affectedRecords, rationale: JSON.stringify(proof),
    disposition: 'selected' as const, sourceRefs: [{ uri: 'factory:correction-observation' }], scopeChanges: [] };
}

/** One ordered delivery. Unknown outcomes are not automatically replayed because
 * fm-send/fm-control do not expose an idempotency key. Crash recovery is BUILD-15. */
export function deliverCorrection(store: ProjectStore, projectId: string, correctionId: string, input: CorrectionAdapterOptions): Operation {
  const options = CorrectionAdapterOptionsSchema.parse(input);
  for (const path of [options.fmHome, options.sendExecutable, options.controlExecutable, ...(options.stateExecutable ? [options.stateExecutable] : [])]) {
    if (!isAbsolute(path)) throw new StoreError('validation', 'absolute_correction_adapter_paths_required');
  }
  // Task management has its own project lock. This outer lock coordinates the
  // steering queue; task calls below execute outside it using their existing lock.
  const initial = observation(store, projectId, correctionId);
  if (['cancellation', 'new_work'].includes(initial.correction.action)) {
    return deliverTaskCorrection(store, projectId, initial, options);
  }
  return store.withTaskLock(projectId, () => deliverSteering(store, projectId, correctionId, options));
}

function deliveryIntent(store: ProjectStore, projectId: string, record: Correction) {
  const operation = store.get(projectId, record.correction.operationId ?? '');
  const receipt = store.exportProject(projectId).receipts.find((item) => item.command.command === 'deliver_correction' &&
    item.command.targetId === record.id && item.command.idempotencyKey === (operation?.kind === 'operation' ? operation.idempotencyKey : ''));
  if (operation?.kind !== 'operation' || receipt?.command.command !== 'deliver_correction' || commandDigest(receipt.command) !== operation.payloadDigest) {
    throw new StoreError('validation', 'correction_intent_receipt_required');
  }
  return { operation, command: receipt.command };
}
function unresolved(store: ProjectStore, projectId: string, record: Correction, operation: Operation, state: Operation['state'],
  note: string, delivered = false, recipient?: DeliveryRecipient): Operation {
  const at = new Date().toISOString(); const proof = evidence(operation.id, note, at);
  const decision = decisionRecord(projectId, at, 'Correction delivery observation', proof, [ref(record), ref(operation)]);
  let next: Operation;
  store.mutate({ schemaVersion: 1, id: decision.id, projectId, issuedAt: at, idempotencyKey: decision.id,
    command: 'record_decision_suggestion', targetId: operation.id, expectedRevision: operation.revision, payload: { decision } }, (history) => {
    const latest = corrections(current(history)).find((item) => item.id === record.id)!;
    const captured = recipient ?? latest.correction.deliveryRecipient;
    let finalState = state; let finalNote = note; let accepted = delivered;
    if (captured) {
      const attempt = currentAttempt(history, captured.firstMateTaskId);
      if (!attempt || attempt.id !== captured.assignment.id || attempt.attemptId !== captured.attemptId) {
        finalState = 'unknown'; accepted = false;
        finalNote = `Unresolved recipient: attempt replaced or ambiguous during delivery. ${note}`;
      }
    }
    const finalProof = finalNote === note ? proof : evidence(operation.id, finalNote, at);
    next = { ...operation, revision: operation.revision + 1, updatedAt: at, state: finalState,
      reconciliation: { observedAt: at, observedState: finalState, note: finalNote, evidence: finalProof } };
    return [decision, next, ...(accepted || (captured && !latest.correction.deliveryRecipient) ? [{ ...latest,
      revision: latest.revision + 1, updatedAt: at, correction: { ...latest.correction,
        ...(captured ? { deliveryRecipient: captured } : {}),
        facts: [...latest.correction.facts, ...(accepted ? [{ fact: 'delivered' as const, at, evidence: finalProof }] : [])] } }] : [])];
  });
  return next!;
}
function recipientProblem(store: ProjectStore, projectId: string, record: Correction, options: z.output<typeof CorrectionAdapterOptionsSchema>) {
  const assignment = store.get(projectId, record.correction.assignment.id);
  if (assignment?.kind !== 'assignment') return 'Unresolved recipient: assignment missing';
  const attempt = currentAttempt(store.records(projectId), assignment.firstMateTaskId);
  const original = store.get(projectId, record.correction.assignment.id, record.correction.assignment.revision);
  if (!attempt || attempt.id !== assignment.id || original?.kind !== 'assignment' || (original.attemptId !== assignment.attemptId || original.firstMateTaskId !== assignment.firstMateTaskId)) return 'Unresolved recipient: attempt superseded or ambiguous';
  const observations = options.recipients.filter((entry) => {
    const age = Date.now() - Date.parse(entry.observedAt);
    return entry.firstMateTaskId === assignment.firstMateTaskId && age >= -1000 && age <= options.maxObservationAgeMs;
  });
  if (observations.some((entry) => !same(entry.assignment, assignment) || entry.attemptId !== assignment.attemptId ||
    entry.state === 'unknown' || entry.state !== observations[0]!.state)) {
    return 'Unresolved recipient: conflicting fresh runtime-task bindings';
  }
  if (observations.length !== 1) return 'Unresolved recipient: exact fresh observed attempt binding required';
  const binding = observations[0]!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(binding.firstMateTaskId)) return 'Unresolved recipient: unsafe runtime task ID';
  return { assignment, binding };
}
function deliverSteering(store: ProjectStore, projectId: string, correctionId: string, options: z.output<typeof CorrectionAdapterOptionsSchema>): Operation {
  const record = observation(store, projectId, correctionId);
  const { operation } = deliveryIntent(store, projectId, record);
  if (operation.state !== 'pending') return operation;
  if (record.correction.supersededBy) return unresolved(store, projectId, record, operation, 'succeeded', 'Superseded before delivery; sources retained in replacement');
  if (record.correction.action === 'rewind') return unresolved(store, projectId, record, operation, 'failed', 'Missing capability: installed fm-control supports interrupt|exit|relaunch, not rewind');
  const problem = recipientProblem(store, projectId, record, options);
  if (typeof problem === 'string') return unresolved(store, projectId, record, operation, 'pending', problem);
  const { assignment, binding } = problem;
  if (!record.correction.urgentStop && record.correction.action !== 'status' && earlierCorrectionPending(store.records(projectId), record)) {
    return unresolved(store, projectId, record, operation, 'pending', 'Waiting for earlier correction delivery');
  }
  const action = correctionOperation(record.correction.action, record.correction.urgentStop);
  if ((action === 'relaunch' && binding.state !== 'stopped') || (action !== 'relaunch' && action !== 'read_status' && action !== 'steer' && binding.state !== 'active')) {
    return unresolved(store, projectId, record, operation, 'pending', 'Unresolved recipient: lifecycle state does not match requested action');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FM_')));
  env.FM_HOME = resolve(options.fmHome);
  // Preserve every superseded source, recursively, in sequence order.
  const sources = new Map<string, Correction>();
  const collect = (item: Correction) => { for (const previous of item.correction.supersedes) collect(observation(store, projectId, previous.id)); sources.set(item.id, item); };
  collect(record);
  const text = JSON.stringify({ assignment: ref(assignment), attemptId: assignment.attemptId,
    corrections: [...sources.values()].sort((a, b) => a.correction.sequence - b.correction.sequence).map((item) => ({
      id: item.id, sequence: item.correction.sequence, action: item.correction.action, originalText: item.correction.originalText,
      active: !item.correction.supersededBy, supersedes: item.correction.supersedes, supersededBy: item.correction.supersededBy ?? null,
      carriedFrom: item.correction.carriedFrom ?? null,
      sources: item.correction.sourceRefs ?? item.affectedScope, affectedRevision: item.correction.affectedRevision })) });
  if (action === 'read_status' && !options.stateExecutable) return unresolved(store, projectId, record, operation, 'pending', 'Configured fm-crew-state wrapper required for status');
  // Durable in-flight marker prevents retry after an ambiguous call or interruption.
  const recipient = { assignment: ref(assignment), attemptId: assignment.attemptId, firstMateTaskId: assignment.firstMateTaskId };
  const started = unresolved(store, projectId, record, operation, 'unknown', 'External delivery started; outcome unconfirmed', false, recipient);
  if (started.reconciliation?.note !== 'External delivery started; outcome unconfirmed') return started;
  try {
    const args = action === 'steer' ? [assignment.firstMateTaskId, text] : action === 'read_status' ? [assignment.firstMateTaskId] : [assignment.firstMateTaskId, action];
    const executable = action === 'steer' ? options.sendExecutable : action === 'read_status' ? options.stateExecutable! : options.controlExecutable;
    const stdout = execFileSync(executable, args,
      { cwd: options.fmHome, env, encoding: 'utf8', timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (action === 'read_status') {
      const state = executionStateToken({ firstMateTaskId: assignment.firstMateTaskId, raw: stdout.trimEnd(),
        observedAt: new Date().toISOString(), sampleRef: `factory:operation/${operation.id}` });
      if (state === 'unknown') return unresolved(store, projectId, record, started, 'unknown', 'Runtime status is unknown');
    }
    // Wrapper exit zero confirms acceptance only; acknowledgement remains independent.
    return unresolved(store, projectId, record, started, 'succeeded', JSON.stringify({ action, recipient: binding, stdout, payloadDigest: digest(text) }), true, recipient);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return unresolved(store, projectId, record, started, failure.code === 'ENOENT' || failure.code === 'EACCES' ? 'failed' : 'unknown', String(error), false, recipient);
  }
}
function deliverTaskCorrection(store: ProjectStore, projectId: string, record: Correction, options: z.output<typeof CorrectionAdapterOptionsSchema>): Operation {
  const { operation, command } = deliveryIntent(store, projectId, record);
  if (operation.state === 'succeeded' || operation.state === 'failed') return operation;
  if (!record.correction.urgentStop && earlierCorrectionPending(store.records(projectId), record)) {
    return unresolved(store, projectId, record, operation, 'pending', 'Waiting for earlier correction delivery');
  }
  const task = command.payload.taskCommand;
  if (!task || !options.taskAdapter) return unresolved(store, projectId, record, operation, 'pending', 'BUILD-08 task adapter required');
  let recipient: DeliveryRecipient | undefined;
  if (record.correction.action === 'cancellation') {
    const problem = recipientProblem(store, projectId, record, options);
    if (typeof problem === 'string') return unresolved(store, projectId, record, operation, 'pending', problem);
    recipient = record.correction.deliveryRecipient ?? { assignment: ref(problem.assignment),
      attemptId: problem.assignment.attemptId, firstMateTaskId: problem.assignment.firstMateTaskId };
    const started = unresolved(store, projectId, record, operation, 'unknown', 'Task cancellation started; recipient captured', false, recipient);
    if (started.reconciliation?.note !== 'Task cancellation started; recipient captured') return started;
  }
  if (resolve(options.taskAdapter.fmHome) !== resolve(options.fmHome)) throw new StoreError('validation', 'task_adapter_home_must_match_correction_home');
  const result = manageExecutionTask(store, task, options.taskAdapter);
  return unresolved(store, projectId, observation(store, projectId, record.id), store.get(projectId, operation.id) as Operation,
    result.operation.state, `BUILD-08 operation ${result.operation.id}: ${result.operation.state}`, result.operation.state === 'succeeded', recipient);
}


/** A replacement receives a new source-linked intent. Never move its predecessor's
 * delivered/acknowledged facts or turn an unresolved lifecycle action into a launch. */
export function queueReplacementCorrections(store: ProjectStore, assignment: Assignment): Ref[] {
  const deliveries: Ref[] = [];
  for (const source of outstandingTaskCorrections(store.history(assignment.projectId), assignment.firstMateTaskId)) {
    const history = store.history(assignment.projectId);
    if (correctionTargetsAttempt(history, source, assignment) || source.correction.urgentStop ||
      !['clarification', 'amended_scope'].includes(source.correction.action)) continue;
    const existing = currentCorrections(history).find((item) => correctionTargetsAttempt(history, item, assignment) &&
      carriesCorrection(history, item, source.id));
    if (existing) { deliveries.push(ref(existing)); continue; }
    const affected = assignment.feature ? store.get(assignment.projectId, assignment.feature.id) :
      store.get(assignment.projectId, source.correction.affectedRevision.id);
    if (!affected) throw new StoreError('not_found', 'replacement_correction_source_missing');
    const id = stableId('carried-correction', source.id, assignment.id, assignment.attemptId);
    const at = new Date().toISOString();
    const result = queueCorrection(store, { schemaVersion: 1, id, projectId: assignment.projectId, issuedAt: at,
      idempotencyKey: id, command: 'deliver_correction', targetId: id, expectedRevision: 0, payload: {
        affectedRevision: ref(affected), assignment: ref(assignment), action: 'clarification',
        originalCorrection: source.correction.originalText, carriedFrom: ref(source), supersedes: [],
        sequence: Math.max(0, ...currentCorrections(history).filter((item) => item.correction.assignment.id === assignment.id)
          .map((item) => item.correction.sequence)) + 1,
        sourceRefs: [...(source.correction.sourceRefs ?? source.affectedScope), {
          uri: `factory:correction/${source.id}`, record: ref(source), excerpt: source.correction.originalText }],
      } });
    deliveries.push(ref(result.correction));
  }
  return deliveries;
}
