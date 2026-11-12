import { readFleetSnapshot, runtimeTask, observedAgentStopped, recordOperationObservation } from './runtime.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { MapManageExecutionTaskCommandSchema } from './commands.js';
import { FirstMateTaskMutationSchema, parseFirstMateTaskDetail, type FirstMateTask } from './firstmate.js';
import { ref, stableId } from './intake.js';
import { assignmentCriteria } from './instruction-context.js';
import { DecisionChangeSchema, DetailedPlanTaskSchema, TaskMappingSchema, type FactoryRecord, type Operation, type TaskMapping } from './records.js';
import { commandDigest } from './rules.js';
import { pendingOperation, ProjectStore, StoreError } from './store.js';
import { cancelledTaskPrerequisites, currentTaskMappings, taskDependencyIds, taskReadinessReasons } from './task-readiness.js';

type TaskCommand = ReturnType<typeof MapManageExecutionTaskCommandSchema.parse>;
export const TaskAdapterOptionsSchema = z.strictObject({
  fmHome: z.string().min(1),
  /** Configured path to FirstMate's existing fm-tasks-axi.sh wrapper. */
  tasksExecutable: z.string().min(1),
  /** Existing permanently held task, required without atomic add-and-hold
   * and when retaining an unrelated hold alongside toolkit conditions. */
  guardTaskId: z.string().min(1).optional(),
  /** Existing fm-control.sh wrapper. Needed only for cancellation of active work. */
  controlExecutable: z.string().min(1).optional(),
  snapshotExecutable: z.string().min(1).optional(),
  maxObservationAgeMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type TaskAdapterOptions = z.infer<typeof TaskAdapterOptionsSchema>;

const current = (history: FactoryRecord[]) => [...new Map(history.map((record) => [record.id, record])).values()];
const taskIds = (task: FirstMateTask) => task.deps.filter((edge) => edge.type === 'blocked-by').map((edge) => edge.id);
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id);
function validateCommand(command: TaskCommand) {
  const payload = command.payload;
  if (![payload.task.firstMateTaskId, ...payload.dependencies].every(validId)) {
    throw new StoreError('validation', 'invalid_tasks_axi_id');
  }
  if (payload.priority !== undefined && (payload.priority < 0 || payload.priority > 4)) {
    throw new StoreError('validation', 'tasks_axi_priority_must_be_0_to_4');
  }
  for (const text of [payload.task.kind === 'new' ? payload.task.title : undefined, payload.update?.title]) {
    if (text !== undefined && /[\r\n]/u.test(text)) throw new StoreError('validation', 'task_title_must_be_single_line');
  }
}

/** Transactional intent only. Mapping and operation are committed together before
 * any external task can be exposed. Replaying a key returns its original intent. */
export function queueManagedTask(store: ProjectStore, input: unknown): { mapping: TaskMapping; operation: Operation } {
  const command = MapManageExecutionTaskCommandSchema.parse(input);
  validateCommand(command);
  return store.withTaskLock(command.projectId, () => queueTaskIntent(store, command));
}

function queueTaskIntent(store: ProjectStore, command: TaskCommand, inheritedAttempt?: Operation['externalAttempt']): { mapping: TaskMapping; operation: Operation } {
  store.assertExternalOperationsAllowed(command.projectId);
  const operationId = stableId('task-operation', command.projectId, command.idempotencyKey);
  const receipts = store.exportProject(command.projectId).receipts;
  const result = store.mutate(command, (history) => {
    const records = current(history);
    const previous = records.find((record) => record.id === command.targetId);
    if (previous && previous.kind !== 'task_mapping') throw new StoreError('validation', 'target_is_not_task_mapping');
    if (previous?.kind === 'task_mapping' && previous.firstMateTaskId !== command.payload.task.firstMateTaskId) {
      throw new StoreError('validation', 'mapping_task_identity_is_immutable');
    }
    if (previous?.kind === 'task_mapping' && previous.management) {
      const operation = records.find((record) => record.id === previous.management!.operationId);
      if (operation?.kind !== 'operation' || (!operation.suspended && (operation.state !== 'succeeded' &&
        !(operation.state === 'failed' && operation.taskRejection?.beforeMutation)))) {
        throw new StoreError('conflict', 'reconcile_previous_task_mutation_first');
      }
    }
    const payload = command.payload;
    if (previous?.kind === 'task_mapping' && previous.disposition.state === 'cancelled' && payload.action !== 'cancel') {
      throw new StoreError('validation', 'cancelled_task_requires_explicit_replanning');
    }
    const task = payload.detailedPlanTask && history.find((record) => record.id === payload.detailedPlanTask!.id &&
      record.revision === payload.detailedPlanTask!.revision && record.kind === 'detailed_plan_task');
    const plan = task?.kind === 'detailed_plan_task' ? records.find((record) => record.id === task.plan.id) : undefined;
    if (payload.action === 'create') {
      if (task?.kind !== 'detailed_plan_task' || task.draft || plan?.kind !== 'implementation_plan_revision' ||
        !plan.readiness.ready || plan.readiness.comparison.result !== 'passed' ||
        !plan.deliverySequence.some((entry) => entry.id === task.id && entry.revision === task.revision)) {
        throw new StoreError('validation', 'managed_creation_requires_ready_detailed_plan');
      }
      DetailedPlanTaskSchema.parse({ ...task, draft: false });
      const criteria = assignmentCriteria(history, plan, task);
      if (JSON.stringify(payload.feature) !== JSON.stringify(plan.feature) || criteria.length !== payload.criteria.length ||
        criteria.some((criterion) => !payload.criteria.some((entry) => entry.id === criterion.id && entry.revision === criterion.revision))) {
        throw new StoreError('validation', 'managed_creation_must_preserve_plan_scope');
      }
    }
    const planned = plan && plan.kind === 'implementation_plan_revision' ? plan.dependencies.filter((edge) =>
      edge.consumerTaskId === task!.id) : [];
    // Old snapshots did not distinguish plan requirements from explicit extras.
    // Recover only the last explicit replacement from their original receipts.
    const priorExplicit = previous?.management?.explicitRequirements ?? history.filter((record) =>
      record.kind === 'task_mapping' && record.id === previous?.id && record.management).reverse().flatMap((record) => {
      if (record.kind !== 'task_mapping') return [];
      const operation = records.find((entry) => entry.id === record.management!.operationId);
      const receipt = operation?.kind === 'operation' && receipts.find((entry) => entry.command.idempotencyKey === operation.idempotencyKey);
      return receipt && receipt.command.command === 'map_manage_execution_task' && receipt.command.payload.requirements !== undefined ?
        [receipt.command.payload.requirements] : [];
    })[0] ?? [];
    const explicitRequirements = payload.requirements ?? priorExplicit;
    const requirements = [...new Map([...planned, ...explicitRequirements]
      .map((edge) => [JSON.stringify(edge), edge])).values()];
    if (requirements.some((edge) => edge.consumerTaskId !== payload.detailedPlanTask?.id)) {
      throw new StoreError('validation', 'requirement_must_name_consumer_detailed_task');
    }
    const decision = DecisionChangeSchema.parse({ kind: 'decision_change', id: stableId('task-decision', operationId),
      projectId: command.projectId, schemaVersion: 1, revision: 1, createdAt: command.issuedAt, updatedAt: command.issuedAt,
      questionOrChange: `Task ${payload.action}: ${payload.task.firstMateTaskId}`,
      affectedRecords: [{ id: command.targetId, revision: command.expectedRevision + 1 }],
      rationale: payload.reason, disposition: 'selected', sourceRefs: [{ uri: `factory:task-command/${command.id}` }], scopeChanges: [],
    });
    const mapping = TaskMappingSchema.parse({ kind: 'task_mapping', id: command.targetId, projectId: command.projectId,
      schemaVersion: 1, revision: command.expectedRevision + 1, createdAt: previous?.createdAt ?? command.issuedAt,
      updatedAt: command.issuedAt, firstMateTaskId: payload.task.firstMateTaskId, feature: payload.feature,
      criteria: payload.criteria, detailedPlanTask: payload.detailedPlanTask, dependencies: [...new Set(payload.dependencies)],
      legacy: payload.detailedPlanTask === null,
      ...(previous?.importedExecution ? { importedExecution: previous.importedExecution } : {}),
      disposition: payload.action === 'cancel' ? { state: 'cancelled', reason: payload.reason, decision: ref(decision) } :
        previous?.disposition ?? { state: 'active' },
      management: { operationId, requirements, explicitRequirements, readiness: payload.readiness ?? previous?.management?.readiness ?? [],
        paused: payload.action === 'pause' || (payload.action !== 'resume' && (previous?.management?.paused ?? false)),
        managedDependencies: previous?.management?.managedDependencies ?? previous?.dependencies ?? [],
        ...(previous?.management?.nativeDependencies && payload.action !== 'edit_dependencies' ?
          { nativeDependencies: previous.management.nativeDependencies } : {}),
        holdReason: `Software Factory ${stableId('hold', command.projectId, command.targetId)}` },
    });
    // An explicit edit supersedes observations of this task's outgoing edges,
    // including copies retained by downstream consumers after native cleanup.
    const invalidated = payload.action === 'edit_dependencies' ? currentTaskMappings(records).flatMap((consumer) => {
      if (consumer.id === mapping.id || !consumer.management?.nativeDependencies?.some((edge) => edge.taskId === mapping.firstMateTaskId)) return [];
      return [{ ...consumer, revision: consumer.revision + 1, updatedAt: command.issuedAt,
        management: { ...consumer.management,
          nativeDependencies: consumer.management.nativeDependencies.filter((edge) => edge.taskId !== mapping.firstMateTaskId) } }];
    }) : [];
    return [decision, mapping, ...invalidated, { ...pendingOperation(command, operationId), taskMutationAttempted: inheritedAttempt !== undefined,
      ...(inheritedAttempt ? { externalAttempt: inheritedAttempt } : {}) }];
  });
  const mappingRef = result.records.find((entry) => entry.id === command.targetId)!;
  const mapping = store.get(command.projectId, mappingRef.id, mappingRef.revision);
  const operation = store.get(command.projectId, operationId);
  if (mapping?.kind !== 'task_mapping' || operation?.kind !== 'operation') throw new StoreError('validation', 'task_intent_not_saved');
  return { mapping, operation };
}

class TaskProcessError extends Error {
  constructor(readonly code: string | undefined, readonly stdout: string, readonly stderr: string, message: string) { super(message); }
}
class DefinitiveTaskRejection extends Error {}
export class TaskWrapper {
  readonly events: unknown[] = [];
  readonly env: NodeJS.ProcessEnv;
  beforeWrite?: (args: string[], installedDependencies: string[]) => void;
  constructor(readonly options: TaskAdapterOptions) {
    for (const path of [options.fmHome, options.tasksExecutable, options.controlExecutable, options.snapshotExecutable].filter((path) => path !== undefined)) {
      if (!isAbsolute(path)) throw new StoreError('validation', 'absolute_task_adapter_paths_required');
    }
    if (options.guardTaskId !== undefined && !validId(options.guardTaskId)) throw new StoreError('validation', 'invalid_guard_id');
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FM_') && !key.startsWith('TASKS_AXI_')));
    this.env.FM_HOME = resolve(options.fmHome);
  }
  run(args: string[], executable = this.options.tasksExecutable): string {
    try {
      const stdout = execFileSync(executable, args, { cwd: this.options.fmHome, env: this.env,
        timeout: this.options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      this.events.push({ executable, args, stdout }); return stdout;
    } catch (error) {
      const failure = error as { code?: string; stdout?: unknown; stderr?: unknown; message: string };
      const stdout = String(failure.stdout ?? ''); const stderr = String(failure.stderr ?? '');
      this.events.push({ executable, args, stdout, stderr, error: failure.message });
      throw new TaskProcessError(failure.code, stdout, stderr, failure.message);
    }
  }
  read(id: string): FirstMateTask | undefined {
    let raw: string;
    try { raw = this.run(['show', id, '--full']); }
    catch (error) {
      // Only the installed wrapper's explicit NOT_FOUND result proves absence.
      // A timeout, bad layout or empty output is never an absent task.
      if (error instanceof TaskProcessError && /^code: NOT_FOUND$/mu.test(error.stdout + '\n' + error.stderr)) return undefined;
      throw error;
    }
    const task = parseFirstMateTaskDetail(raw);
    if (task.id !== id) throw new Error('task_read_identity_mismatch');
    return task;
  }
  write(args: string[], matches: (task: FirstMateTask) => boolean, installedDependencies: string[] = []): FirstMateTask {
    this.beforeWrite?.(args, installedDependencies);
    let raw: string;
    try { raw = this.run([...args, '--json']); }
    catch (error) {
      // A valid receipt remains useful even if the process exited nonzero.
      if (!(error instanceof TaskProcessError) || !error.stdout) throw error;
      raw = error.stdout;
    }
    const result = FirstMateTaskMutationSchema.parse(JSON.parse(raw));
    if (result.action !== args[0] || result.task.id !== args[1] || !matches(result.task)) {
      throw new Error('task_mutation_receipt_mismatch');
    }
    if (['block', 'unblock'].includes(result.action) && result.blocked_by !== args[3]) {
      throw new Error('task_dependency_receipt_mismatch');
    }
    return result.task;
  }
}

function inspectDependencies(wrapper: TaskWrapper, taskId: string, ids: string[],
  onError?: (id: string, error: unknown) => void) {
  const dependencies = new Map<string, FirstMateTask | undefined>();
  const inspect = (id: string, path: Set<string>) => {
    if (path.has(id) || id === taskId) {
      const error = new DefinitiveTaskRejection('task_dependency_cycle');
      if (!onError) throw error;
      onError(id, error); return;
    }
    if (dependencies.has(id)) return;
    let task: FirstMateTask | undefined;
    try { task = wrapper.read(id); }
    catch (error) { if (!onError) throw error; onError(id, error); }
    dependencies.set(id, task);
    const next = new Set([...path, id]);
    for (const dep of task ? taskIds(task) : []) inspect(dep, next);
  };
  for (const id of ids) inspect(id, new Set());
  return dependencies;
}

function withNativeDependencies(records: FactoryRecord[], mapping: TaskMapping, dependencies: Map<string, FirstMateTask | undefined>): TaskMapping {
  const native = new Map((mapping.management!.nativeDependencies ?? []).map((edge) => [edge.taskId, new Set(edge.dependencies)]));
  for (const [id, task] of dependencies) if (task) native.set(id, new Set([...(native.get(id) ?? []), ...taskIds(task)]));
  // Toolkit-owned direct edges follow canonical requirements, not retained
  // native history. Keep only foreign edges as evidence across native cleanup.
  for (const owner of currentTaskMappings(records)) if (owner.management) {
    const edges = native.get(owner.firstMateTaskId);
    for (const id of [...owner.management.managedDependencies, ...taskDependencyIds(records, owner)]) edges?.delete(id);
  }
  const nativeDependencies = [...native].map(([taskId, ids]) => ({ taskId, dependencies: [...ids] }));
  return JSON.stringify(nativeDependencies) === JSON.stringify(mapping.management!.nativeDependencies ?? []) ? mapping :
    { ...mapping, management: { ...mapping.management!, nativeDependencies } };
}

function recordOutcome(store: ProjectStore, operation: Operation, state: Operation['state'], note: string, mapping: TaskMapping,
  installedDependencies?: string[], rejection?: string, observedMappings: TaskMapping[] = []): Operation {
  const at = new Date().toISOString();
  const decision = DecisionChangeSchema.parse({ kind: 'decision_change', id: randomUUID(), projectId: operation.projectId,
    schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
    questionOrChange: 'Reconcile managed FirstMate task', affectedRecords: [ref(operation)], rationale: note,
    disposition: 'selected', sourceRefs: [{ uri: `factory:operation/${operation.id}` }], scopeChanges: [],
  });
  const { taskRejection: _oldRejection, ...base } = operation;
  const next: Operation = { ...base, revision: operation.revision + 1, updatedAt: at, state,
    ...(rejection ? { taskRejection: { beforeMutation: true, reason: rejection } as const } : {}),
    externalReferences: [{ uri: `firstmate:task/${encodeURIComponent(mapping.firstMateTaskId)}` }], reconciliation: { observedAt: at, observedState: state, note,
      evidence: [{ artifact: { uri: `factory:task-observation/${decision.id}`, revision: '1' }, description: note, observedAt: at }] } };
  store.mutate({ schemaVersion: 1, id: randomUUID(), projectId: operation.projectId, issuedAt: at, idempotencyKey: randomUUID(),
    command: 'record_decision_suggestion', targetId: operation.id, expectedRevision: operation.revision, payload: { decision } }, () => [decision, next,
    ...observedMappings.map((entry) => ({ ...entry, revision: entry.revision + 1, updatedAt: at })),
    ...(installedDependencies !== undefined && mapping.management ? [{ ...mapping, revision: mapping.revision + 1, updatedAt: at,
      management: { ...mapping.management, managedDependencies: installedDependencies } }] : [])]);
  return next;
}

/** Converge one durable intent through existing wrappers. No worker start,
 * dispatch, spawn, done transition or lifecycle cleanup is owned here. */
export function reconcileManagedTask(store: ProjectStore, projectId: string, operationId: string, options: TaskAdapterOptions): Operation {
  return store.withTaskLock(projectId, () => reconcileTaskIntent(store, projectId, operationId, options));
}

function reconcileTaskIntent(store: ProjectStore, projectId: string, operationId: string, options: TaskAdapterOptions): Operation {
  const wrapper = new TaskWrapper(TaskAdapterOptionsSchema.parse(options));
  const savedOperation = store.get(projectId, operationId);
  if (savedOperation?.kind !== 'operation' || savedOperation.command !== 'map_manage_execution_task') {
    throw new StoreError('not_found', 'task_operation_not_found');
  }
  // Missing metadata on an older unresolved attempt cannot prove that no write occurred.
  let operation: Operation = { ...savedOperation, taskMutationAttempted: savedOperation.taskMutationAttempted ??
    (savedOperation.externalAttempt !== undefined || (savedOperation.state !== 'pending' && !savedOperation.taskRejection?.beforeMutation)) };
  store.assertExternalOperationsAllowed(projectId, operation);
  if (operation.state === 'succeeded') return operation;
  const operationKey = operation.idempotencyKey;
  const receipt = store.exportProject(projectId).receipts.find((entry) => entry.command.idempotencyKey === operationKey);
  if (receipt?.command.command !== 'map_manage_execution_task' || commandDigest(receipt.command) !== operation.payloadDigest) {
    throw new StoreError('validation', 'task_operation_receipt_required');
  }
  const command = receipt.command;
  validateCommand(command);
  const payload = command.payload;
  const savedMapping = store.get(projectId, command.targetId);
  if (savedMapping?.kind !== 'task_mapping' || savedMapping.management?.operationId !== operation.id) {
    throw new StoreError('conflict', 'task_operation_superseded');
  }
  let mapping: TaskMapping = savedMapping;
  const beforeWrite = (args: string[], installedDependencies: string[] = []) => {
    const installed = args[1] === mapping.firstMateTaskId ? installedDependencies : [];
    const owned = [...new Set([...mapping.management!.managedDependencies, ...installed])];
    if (operation.taskMutationAttempted && owned.length === mapping.management!.managedDependencies.length) return;
    // Progress stays pending so the existing first-outcome replay rule returns the final receipt.
    operation = recordOutcome(store, { ...operation, taskMutationAttempted: true }, 'pending',
      JSON.stringify({ mutationAttempt: args }), mapping, owned);
    mapping = store.get(projectId, mapping.id) as TaskMapping;
  };
  wrapper.beforeWrite = beforeWrite;
  const holdReason = mapping.management!.holdReason;
  const ownHold = (task: FirstMateTask) => task.hold?.reason === holdReason && task.hold.until === null;
  const creationMarker = `Software Factory mapping: ${mapping.id}`;
  const retainProtection = (target: TaskMapping, guardId?: string): TaskMapping => {
    if (target.management && (!guardId || target.management.managedDependencies.includes(guardId))) return target;
    const owned = { ...target, management: target.management ?? { operationId: operation.id,
      requirements: [], managedDependencies: [], readiness: [], paused: false,
      holdReason: `Software Factory ${stableId('hold', projectId, target.id)}` } };
    operation = recordOutcome(store, operation, operation.state, `Protection intended for ${target.firstMateTaskId}`,
      owned, [...owned.management.managedDependencies, ...(guardId ? [guardId] : [])]);
    const saved = store.get(projectId, target.id) as TaskMapping;
    if (target.id === mapping.id) mapping = saved;
    return saved;
  };
  const requireGuard = () => {
    if (!options.guardTaskId) throw new DefinitiveTaskRejection('permanent_guard_task_required_without_atomic_hold');
    const guard = wrapper.read(options.guardTaskId);
    if (!guard || guard.state === 'done' || !guard.held || !guard.hold || guard.hold.until !== null) {
      throw new DefinitiveTaskRejection('guard_must_be_permanently_held_and_not_done');
    }
    return guard.id;
  };
  const protect = (target: TaskMapping, task: FirstMateTask) => {
    const owned = retainProtection(target);
    const reason = owned.management!.holdReason;
    const matches = (value: FirstMateTask) => value.hold?.reason === reason && value.hold.until === null;
    if (!task.hold) return wrapper.write(['hold', task.id, '--reason', reason, '--kind', 'external'], matches);
    if (!matches(task)) {
      const guardId = requireGuard();
      if (!taskIds(task).includes(guardId)) {
        retainProtection(owned, guardId);
        return wrapper.write(['block', task.id, '--by', guardId],
          (value) => taskIds(value).includes(guardId), [guardId]);
      }
    }
    return task;
  };
  const observationErrors: { taskId: string; error: string }[] = [];
  const observationError = (taskId: string, error: unknown) => observationErrors.push({ taskId,
    error: error instanceof Error ? error.message : String(error) });
  let observed: FirstMateTask | undefined;
  try {
    // Re-read by the original stable ID before EVERY retry, including pending
    // intents recovered after a crash before the outcome could be saved.
    observed = wrapper.read(mapping.firstMateTaskId);
    let records = store.records(projectId);
    if (mapping.disposition.state === 'cancelled') {
      // Install known protection and stop active work before optional observations elsewhere.
      if (observed) try { observed = protect(mapping, observed); }
      catch (error) { observationError(mapping.firstMateTaskId, error); }
      const protectAffected = () => {
        for (const consumer of currentTaskMappings(records)) {
          if ((!consumer.management && consumer.legacy) || consumer.id === mapping.id ||
            !cancelledTaskPrerequisites(records, consumer).includes(mapping.firstMateTaskId)) continue;
          try {
            const task = wrapper.read(consumer.firstMateTaskId);
            if (task) protect(consumer, task);
          } catch (error) { observationError(consumer.firstMateTaskId, error); }
        }
        records = store.records(projectId);
      };
      protectAffected();
      try {
        if (observed?.state === 'in_flight') {
          if (!options.controlExecutable) throw new Error('active_cancellation_requires_configured_fm_control');
          const snapshot = readFleetSnapshot({ fmHome: options.fmHome,
            ...(options.snapshotExecutable ? { snapshotExecutable: options.snapshotExecutable } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.maxObservationAgeMs ? { maxObservationAgeMs: options.maxObservationAgeMs } : {}) });
          const runtime = runtimeTask(snapshot, observed.id, false);
          if (operation.externalAttempt) {
            if (!observedAgentStopped(snapshot, operation.externalAttempt)) {
              throw new Error('cancellation_outcome_unknown_no_retry');
            }
          } else {
            if (!runtime?.spawn_gen) throw new Error('cancellation_requires_observed_worker_generation');
            operation = recordOperationObservation(store, operation, 'unknown', JSON.stringify({ action: 'exit', snapshot }), {
              externalAttempt: { action: 'exit', firstMateTaskId: observed.id,
                baselineGeneration: runtime.spawn_gen, startedAt: new Date().toISOString() } });
            beforeWrite(['exit', observed.id]);
            wrapper.run([observed.id, 'exit'], options.controlExecutable);
          }
        }
      } catch (error) { observationError(mapping.firstMateTaskId, error); }
      for (const consumer of currentTaskMappings(records)) {
        if (!consumer.management || consumer.id === mapping.id) continue;
        try {
          // A rejected create has no native consumer and cannot dispatch.
          const task = wrapper.read(consumer.firstMateTaskId);
          if (!task) continue;
          const dependencies = inspectDependencies(wrapper, consumer.firstMateTaskId,
            [...new Set([...taskDependencyIds(records, consumer), ...taskIds(task)])], observationError);
          dependencies.set(consumer.firstMateTaskId, task);
          const updated = withNativeDependencies(records, consumer, dependencies);
          if (updated !== consumer) {
            operation = recordOutcome(store, operation, operation.state, 'Observed consumer native dependency graph', mapping,
              undefined, undefined, [updated]);
            records = store.records(projectId);
          }
        } catch (error) { observationError(consumer.firstMateTaskId, error); }
      }
      protectAffected();
      if (observationErrors.length) return recordOutcome(store, operation, 'unknown',
        JSON.stringify({ task: observed, observationErrors, events: wrapper.events }), mapping, mapping.management!.managedDependencies);
    }
    const desiredIds = taskDependencyIds(records, mapping);
    if (options.guardTaskId && (desiredIds.includes(options.guardTaskId) || mapping.firstMateTaskId === options.guardTaskId)) {
      throw new DefinitiveTaskRejection('guard_task_cannot_be_managed_or_used_as_product_prerequisite');
    }
    const dependencies = inspectDependencies(wrapper, mapping.firstMateTaskId, desiredIds,
      mapping.disposition.state === 'cancelled' ? observationError : undefined);
    if (observationErrors.length) return recordOutcome(store, operation, 'unknown',
      JSON.stringify({ task: observed, observationErrors, events: wrapper.events }), mapping, mapping.management!.managedDependencies);
    const observedMapping = withNativeDependencies(records, mapping, dependencies);
    if (observedMapping !== mapping) {
      operation = recordOutcome(store, operation, operation.state, 'Observed native dependency graph', observedMapping,
        observedMapping.management!.managedDependencies);
      mapping = store.get(projectId, mapping.id) as TaskMapping;
      records = store.records(projectId);
    }
    const availableIds = desiredIds.filter((id) => dependencies.get(id));
    const reasons = [...taskReadinessReasons(records, mapping), ...desiredIds.filter((id) => !dependencies.get(id))
      .map((id) => `Missing prerequisite ${id}`)];

    if (!observed) {
      if (payload.action !== 'create' || payload.task.kind !== 'new') throw new DefinitiveTaskRejection('mapped_task_not_found');
      const newTask = payload.task;
      const atomic = /(?:^|\s)--hold-reason(?:\s|=|$)/u.test(wrapper.run(['add', '--help']));
      const args = ['add', mapping.firstMateTaskId, payload.task.title, '--kind', 'ship', '--repo', payload.task.repo,
        '--queue', '--body', creationMarker];
      if (payload.priority !== undefined) args.push('--priority', String(payload.priority));
      for (const id of availableIds) args.push('--blocked-by', id);
      if (atomic) args.push('--hold-reason', holdReason);
      else {
        const guardId = requireGuard();
        retainProtection(mapping, guardId);
        args.push('--blocked-by', guardId);
      }
      observed = wrapper.write(args, (task) => task.state === 'queued' && task.body === creationMarker &&
        task.title === newTask.title.trim() && task.repo === newTask.repo.trim() && task.kind === 'ship' &&
        (payload.priority === undefined || task.priority === payload.priority) &&
        availableIds.every((id) => taskIds(task).includes(id)) &&
        (atomic ? ownHold(task) : taskIds(task).includes(options.guardTaskId!)),
        [...availableIds, ...(!atomic ? [options.guardTaskId!] : [])]);
    } else if (payload.action === 'create' && payload.task.kind === 'new' &&
      (observed.body !== creationMarker || observed.title !== payload.task.title.trim() || observed.repo !== payload.task.repo.trim())) {
      throw new DefinitiveTaskRejection('stable_task_id_collision');
    }
    const ownedIds = mapping.management!.managedDependencies;
    const fields = payload.action === 'set_priority' ? { priority: payload.priority! } :
      payload.action === 'update' ? payload.update! : {};
    const patch = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => [key, key === 'title' && typeof value === 'string' ? value.trim() : value] as const)
      .filter(([key, value]) => observed![key as keyof FirstMateTask] !== value);
    const needsChange = reasons.length > 0 || patch.length > 0 ||
      availableIds.some((id) => !taskIds(observed!).includes(id)) ||
      ownedIds.some((id) => !desiredIds.includes(id) && taskIds(observed!).includes(id)) ||
      (mapping.disposition.state === 'cancelled' && observed.state === 'in_flight');
    // Keep a hold throughout multi-step changes. An unrelated hold already
    // prevents dispatch and is retained rather than overwritten or cleared.
    if (!observed.hold && needsChange) observed = wrapper.write(['hold', observed.id, '--reason', holdReason, '--kind', 'external'], ownHold);
    if (needsChange && observed.hold && !ownHold(observed) && observed.state !== 'done') {
      // Preserve another owner's hold, including an expiring one, while giving
      // our independent conditions a permanent native blocker of their own.
      const guardId = requireGuard();
      if (!taskIds(observed).includes(guardId)) {
        retainProtection(mapping, guardId);
        observed = wrapper.write(['block', observed.id, '--by', guardId], (task) => taskIds(task).includes(guardId), [guardId]);
      }
    }
    if (payload.action === 'set_priority' || payload.action === 'update') {
      if (patch.length) observed = wrapper.write(['update', observed.id, ...patch.flatMap(([key, value]) => [`--${key}`, String(value)])],
        (task) => patch.every(([key, value]) => task[key as keyof FirstMateTask] === value));
    }
    // Add before remove, with the hold still in place. Unknown outcomes stop
    // immediately; the next reconciliation reads the backlog before retrying.
    for (const id of availableIds) if (!taskIds(observed).includes(id)) {
      observed = wrapper.write(['block', observed.id, '--by', id], (task) => taskIds(task).includes(id), [id]);
    }
    for (const id of ownedIds) if (id !== options.guardTaskId && !desiredIds.includes(id) && taskIds(observed).includes(id)) {
      observed = wrapper.write(['unblock', observed.id, '--by', id], (task) => !taskIds(task).includes(id));
    }

    if (!reasons.length) {
      // No unresolved condition may have appeared while the subprocesses ran.
      const fresh = store.get(projectId, mapping.id);
      if (fresh?.revision !== mapping.revision || taskReadinessReasons(store.records(projectId), mapping).length) {
        throw new Error('readiness_changed_during_reconciliation');
      }
      for (const id of desiredIds) if (!wrapper.read(id)) reasons.push(`Missing prerequisite ${id}`);
    }
    if (options.guardTaskId && mapping.management!.managedDependencies.includes(options.guardTaskId) &&
      taskIds(observed).includes(options.guardTaskId) && (ownHold(observed) || !reasons.length)) {
      const guardId = options.guardTaskId;
      observed = wrapper.write(['unblock', observed.id, '--by', guardId], (task) => !taskIds(task).includes(guardId));
    }
    if (!reasons.length && ownHold(observed)) observed = wrapper.write(['unhold', observed.id], (task) => task.hold === null);
    const installed = [...new Set([...desiredIds, ...mapping.management!.managedDependencies])]
      .filter((id) => taskIds(observed!).includes(id));
    return recordOutcome(store, operation, observationErrors.length ? 'unknown' : 'succeeded',
      JSON.stringify({ task: observed, unresolved: reasons, observationErrors, events: wrapper.events }), mapping, installed);
  } catch (error) {
    const rejection = error instanceof DefinitiveTaskRejection && !operation.taskMutationAttempted ? error.message : undefined;
    const state = rejection || (error instanceof TaskProcessError && ['ENOENT', 'EACCES'].includes(error.code ?? '')) ? 'failed' : 'unknown';
    return recordOutcome(store, operation, state, JSON.stringify({ error: error instanceof Error ? error.message : String(error),
      task: observed, observationErrors, events: wrapper.events }), mapping, mapping.management!.managedDependencies, rejection);
  }
}

export function manageExecutionTask(store: ProjectStore, input: unknown, options: TaskAdapterOptions, permitOperationId?: string) {
  const command = MapManageExecutionTaskCommandSchema.parse(input);
  validateCommand(command);
  return store.withTaskLock(command.projectId, () => {
    // Explicit recovery permission shares the same lock as its child effect, so
    // disable/re-enable cannot revive a retired permission between these steps.
    let inheritedAttempt: Operation['externalAttempt'];
    if (permitOperationId) {
      const permit = store.get(command.projectId, permitOperationId);
      if (permit?.kind !== 'operation') throw new StoreError('not_found', 'task_recovery_permission_missing');
      store.assertExternalOperationsAllowed(command.projectId, permit);
      const receipt = store.receipt(command.projectId, permit.idempotencyKey);
      if (receipt?.command.command !== 'record_decision_suggestion') throw new StoreError('validation', 'task_recovery_permission_receipt_required');
      const binding = z.strictObject({ correctionId: z.string(), sourceOperationId: z.string(), taskDigest: z.string() })
        .parse(JSON.parse(receipt.command.payload.decision.rationale));
      const correction = store.get(command.projectId, binding.correctionId);
      const source = store.get(command.projectId, binding.sourceOperationId);
      const sourceReceipt = source?.kind === 'operation' && store.receipt(command.projectId, source.idempotencyKey);
      const original = sourceReceipt && sourceReceipt.command.command === 'deliver_correction' && sourceReceipt.command.payload.taskCommand;
      if (correction?.kind !== 'observation' || correction.correction?.operationId !== binding.sourceOperationId ||
        !original || original.targetId !== command.targetId || commandDigest(original) !== binding.taskDigest || JSON.stringify(original.payload) !== JSON.stringify(command.payload)) {
        throw new StoreError('conflict', 'task_correction_recovery_binding_changed');
      }
      const mapping = store.get(command.projectId, command.targetId);
      const previous = mapping?.kind === 'task_mapping' && mapping.management && store.get(command.projectId, mapping.management.operationId);
      if (previous && previous.kind === 'operation' && previous.suspended) inheritedAttempt = previous.externalAttempt;
    }
    const intent = queueTaskIntent(store, command, inheritedAttempt);
    const operation = reconcileTaskIntent(store, intent.mapping.projectId, intent.operation.id, options);
    const latest = store.get(command.projectId, intent.mapping.id);
    // Success also persists the installed dependency snapshot. Return its current
    // revision, while an old successful-key replay retains its original mapping.
    return { mapping: latest?.kind === 'task_mapping' && latest.management?.operationId === operation.id ? latest : intent.mapping, operation };
  });
}
