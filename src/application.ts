import { CommandEnvelopeSchema } from './commands.js';
import { recordDecisionSuggestion } from './intake.js';
import { designPlanFeature } from './planning.js';
import { manageExecutionTask, type TaskAdapterOptions } from './tasks.js';
import { ProjectStore, StoreError } from './store.js';
import { commandDigest } from './rules.js';

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
    if (observation.id !== command.targetId || command.payload.feature || command.payload.supersedes?.length) {
      throw new StoreError('validation', 'use_learning_capture_operation');
    }
    return store.mutate(command, () => [observation]);
  }
  throw new StoreError('validation', 'operation_not_exposed');
}
