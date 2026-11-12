import { CommandEnvelopeSchema } from './commands.js';
import { recordDecisionSuggestion } from './intake.js';
import { designPlanFeature } from './planning.js';
import { manageExecutionTask, type TaskAdapterOptions } from './tasks.js';
import { ProjectStore, StoreError } from './store.js';
import { commandDigest } from './rules.js';
import { captureLearning } from './learning.js';

/** Bounded, model-free application boundary used by both local CLI and HTTP. */
export function applyCommand(store: ProjectStore, input: unknown, tasks?: TaskAdapterOptions) {
  const command = CommandEnvelopeSchema.parse(input);
  if (command.command === 'record_decision_suggestion') return recordDecisionSuggestion(store, command);
  if (command.command === 'design_plan_feature') return designPlanFeature(store, command);
  if (command.command === 'map_manage_execution_task') {
    const receipt = store.receipt(command.projectId, command.idempotencyKey);
    if (receipt) {
      if (commandDigest(receipt.command) !== commandDigest(command)) throw new StoreError('validation', 'idempotency_conflict');
      // Reconstruct the first response from BUILD-08's immutable intent and
      // outcome receipts. Replays remain stable even after a later task edit or
      // explicit reconciliation; they never silently retry an unknown outcome.
      const history = store.history(command.projectId);
      const intent = receipt.result.records.map((target) => store.get(command.projectId, target.id, target.revision));
      const operation = intent.find((record) => record?.kind === 'operation');
      const firstOutcome = history.find((record) => record.kind === 'operation' && record.id === operation?.id && record.state !== 'pending');
      if (firstOutcome?.kind === 'operation') {
        const outcomeReceipt = store.exportProject(command.projectId).receipts.find((entry) => entry.result.records.some((target) =>
          target.id === firstOutcome.id && target.revision === firstOutcome.revision));
        const mappingRef = outcomeReceipt?.result.records.find((target) => target.id === command.targetId) ??
          receipt.result.records.find((target) => target.id === command.targetId);
        const mapping = mappingRef && store.get(command.projectId, mappingRef.id, mappingRef.revision);
        if (mapping?.kind !== 'task_mapping') throw new StoreError('validation', 'task_intent_not_saved');
        return { mapping, operation: firstOutcome };
      }
    }
    if (!tasks) throw new StoreError('validation', 'task_adapter_not_configured');
    return manageExecutionTask(store, command, tasks);
  }
  // Preserve BUILD-05's observation capture endpoint. Consolidation and all
  // agent-running/lifecycle commands deliberately remain outside this boundary.
  if (command.command === 'capture_consolidate_learning' && command.payload.action === 'capture') {
    const observation = command.payload.observation;
    if (observation.learning) {
      if (command.targetId !== observation.id || command.id !== observation.id || command.expectedRevision !== 0 ||
        observation.revision !== 1 || observation.createdAt !== command.issuedAt || observation.updatedAt !== command.issuedAt ||
        observation.projectId !== command.projectId || observation.legacySections?.length || command.payload.feature ||
        !['standing_instruction', 'inferred', 'operational'].includes(observation.learning.inputKind)) {
        throw new StoreError('validation', 'invalid_ui_learning_capture');
      }
      const identity = observation.learning;
      const expectedObservation = { kind: 'observation', schemaVersion: 1, id: observation.id, projectId: command.projectId,
        revision: 1, createdAt: command.issuedAt, updatedAt: command.issuedAt, finding: observation.finding,
        evidence: observation.evidence, proposedGeneralization: observation.proposedGeneralization, learning: observation.learning, legacySections: [],
        affectedScope: [{ uri: identity.scope.kind === 'project' ? `factory:project/${encodeURIComponent(command.projectId)}` : `factory:feature/${encodeURIComponent(identity.scope.featureId)}` }],
        consolidationState: identity.inputKind === 'standing_instruction' ? 'consolidated' : 'pending' };
      const normalized = { ...command, payload: { ...command.payload,
        observation: { ...observation, legacySections: observation.legacySections ?? [] }, supersedes: command.payload.supersedes ?? [] } };
      if (commandDigest(normalized) !== commandDigest({ ...command, payload: { action: 'capture', observation: expectedObservation, supersedes: command.payload.supersedes ?? [] } })) {
        throw new StoreError('validation', 'learning_capture_must_preserve_canonical_scope_and_state');
      }
      return captureLearning(store, { projectId: command.projectId, id: observation.id, idempotencyKey: command.idempotencyKey,
        issuedAt: command.issuedAt, identity: { scope: observation.learning.scope, topic: observation.learning.topic },
        finding: observation.finding, evidence: observation.evidence, inputKind: observation.learning.inputKind,
        captureReason: observation.learning.captureReason, proposedGeneralization: observation.proposedGeneralization,
        supersedes: command.payload.supersedes ?? [] });
    }
    if (observation.id !== command.targetId || command.payload.feature || command.payload.supersedes?.length) {
      throw new StoreError('validation', 'use_learning_capture_operation');
    }
    return store.mutate(command, () => [observation]);
  }
  throw new StoreError('validation', 'operation_not_exposed');
}
