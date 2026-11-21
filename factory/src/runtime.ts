import { checkConfiguredWorkerStart } from './worker-start-hook.js';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { TimestampSchema } from './primitives.js';
import { type Operation } from './records.js';
import { ref, stableId } from './intake.js';
import { pendingOperation, ProjectStore, StoreError } from './store.js';
import { commandDigest } from './rules.js';

const absolute = z.string().refine(isAbsolute, 'Absolute path required');
export const RuntimeAdapterSchema = z.strictObject({
  fmHome: absolute, snapshotExecutable: absolute.optional(), timeoutMs: z.number().int().positive().optional(),
  maxObservationAgeMs: z.number().int().positive().default(30_000),
});
export type RuntimeAdapter = z.input<typeof RuntimeAdapterSchema>;
// Additive fields are retained, including omissions, provenance and unknown state.
export const FleetSnapshotSchema = z.object({
  schema: z.literal('fm-fleet-snapshot.v1'), generated: TimestampSchema, fm_home: absolute,
  backlog: z.object({ present: z.boolean(), records: z.array(z.union([
    z.object({ id: z.string().min(1), structured: z.literal(true).optional() }).passthrough(),
    z.object({ id: z.null(), structured: z.literal(false) }).passthrough(),
  ])) }).passthrough(),
  tasks: z.array(z.object({ id: z.string().min(1), spawn_gen: z.string().nullable(),
    project: z.string().nullable(), endpoint: z.object({ exists: z.boolean().nullable(),
      agent_alive: z.enum(['alive', 'dead', 'unknown', 'not_checked']), observed_at: TimestampSchema,
      freshness: z.string(), target: z.string().nullable().optional(), status: z.string().optional(),
    }).passthrough().optional(), current_state: z.object({ state: z.string().min(1),
      observed_at: TimestampSchema, freshness: z.string() }).passthrough(),
  }).passthrough()),
}).passthrough();
export type FleetSnapshot = z.infer<typeof FleetSnapshotSchema>;
export function firstMateEnv(home: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FM_') && !key.startsWith('TASKS_AXI_')));
  env.FM_HOME = resolve(home); return env;
}
export function readFleetSnapshot(input: RuntimeAdapter): FleetSnapshot {
  const options = RuntimeAdapterSchema.parse(input);
  const raw = execFileSync(options.snapshotExecutable ?? join(options.fmHome, 'bin', 'fm-fleet-snapshot.sh'), ['--json'], {
    cwd: options.fmHome, env: firstMateEnv(options.fmHome), encoding: 'utf8', timeout: options.timeoutMs ?? 10_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const snapshot = FleetSnapshotSchema.parse(JSON.parse(raw));
  const age = Date.now() - Date.parse(snapshot.generated);
  if (resolve(snapshot.fm_home) !== resolve(options.fmHome) || age < -1000 || age > options.maxObservationAgeMs ||
    !snapshot.backlog.present || new Set(snapshot.tasks.map((task) => task.id)).size !== snapshot.tasks.length) {
    throw new StoreError('validation', 'fleet_snapshot_wrong_home_stale_or_incomplete');
  }
  return snapshot;
}
export function runtimeTask(snapshot: FleetSnapshot, id: string, requireCrewState = true) {
  const task = snapshot.tasks.find((entry) => entry.id === id);
  const inventory = snapshot.main_inventory as {
    valid?: boolean; orphan_in_flight?: unknown[]; unstructured_current_count?: number;
  } | undefined;
  const orphanIds = inventory?.orphan_in_flight?.map((entry) =>
    entry && typeof entry === 'object' && 'id' in entry ? entry.id : entry) ?? [];
  const records = snapshot.backlog.records;
  const inFlight = records.some((entry) => entry.id === id && entry.state === 'in_flight');
  const queued = records.some((entry) => entry.id === id && entry.state === 'queued');
  // Known missing metadata for other tasks cannot conceal this structured
  // queued target. Unstructured rows or an unexplained invalidity still can.
  const onlyKnownOrphans = inventory?.unstructured_current_count === 0 && orphanIds.length > 0 &&
    orphanIds.every((orphan) => typeof orphan === 'string' &&
      records.some((entry) => entry.id === orphan && entry.state === 'in_flight'));
  const incomplete = inventory?.valid === false && !(queued && onlyKnownOrphans);
  if (orphanIds.includes(id) || (!task?.spawn_gen && (incomplete || inFlight))) throw new Error('target_inventory_metadata_incomplete');
  if (requireCrewState && task && (task.current_state.freshness !== 'fresh' || task.current_state.state === 'unknown' ||
    task.current_state.observed_at !== snapshot.generated)) throw new Error('runtime_task_unknown_or_stale');
  return task;
}
/** Endpoint evidence is separate from crew/pipeline state. Unknown is not dead. */
export function endpointAlive(snapshot: FleetSnapshot, id: string): boolean | undefined {
  const task = snapshot.tasks.find((entry) => entry.id === id);
  const endpoint = task?.endpoint;
  if (!endpoint || endpoint.freshness !== 'fresh' || endpoint.observed_at !== snapshot.generated) return undefined;
  if (endpoint.agent_alive === 'alive') return true;
  if (endpoint.agent_alive === 'dead') return false;
  return undefined;
}
export function observedAgentStopped(snapshot: FleetSnapshot, attempt: NonNullable<Operation['externalAttempt']>): boolean {
  const task = runtimeTask(snapshot, attempt.firstMateTaskId, false);
  return task?.spawn_gen === attempt.baselineGeneration &&
    Date.parse(snapshot.generated) >= Date.parse(attempt.startedAt) && endpointAlive(snapshot, attempt.firstMateTaskId) === false;
}
export function recordOperationObservation(store: ProjectStore, operation: Operation, state: Operation['state'], note: string,
  extra: Partial<Pick<Operation, 'externalAttempt'>> = {}): Operation {
  const at = new Date().toISOString(); const id = randomUUID();
  const decision = { kind: 'decision_change' as const, id, projectId: operation.projectId, schemaVersion: 1 as const,
    revision: 1, createdAt: at, updatedAt: at, questionOrChange: 'Reconcile external operation',
    affectedRecords: [ref(operation)], rationale: note, disposition: 'selected' as const,
    sourceRefs: [{ uri: `factory:operation/${operation.id}` }], scopeChanges: [] };
  const next: Operation = { ...operation, ...extra, state, revision: operation.revision + 1, updatedAt: at,
    reconciliation: { observedAt: at, observedState: state, note, evidence: [{
      artifact: { uri: `factory:operation-observation/${id}`, digest: `sha256:${createHash('sha256').update(note).digest('hex')}` },
      description: note, observedAt: at }] } };
  store.mutate({ schemaVersion: 1, id, projectId: operation.projectId, issuedAt: at, idempotencyKey: id,
    command: 'record_decision_suggestion', targetId: operation.id, expectedRevision: operation.revision, payload: { decision } }, () => [decision, next]);
  return next;
}

export const WorkerStartInputSchema = z.strictObject({
  projectId: z.string().min(1), idempotencyKey: z.string().min(1), assignment: z.object({ id: z.string(), revision: z.number().int().positive() }),
  repository: absolute, executable: absolute, hookRegistry: absolute.optional(), args: z.array(z.string()),
});
/** One explicit start through FirstMate. An ambiguous call is observed, never blindly retried. */
export function startManagedWorker(store: ProjectStore, input: unknown, adapter: RuntimeAdapter): Operation {
  const data = WorkerStartInputSchema.parse(input);
  const options = RuntimeAdapterSchema.parse(adapter);
  return store.withTaskLock(data.projectId, () => {
    store.assertExternalOperationsAllowed(data.projectId);
    const assignment = store.get(data.projectId, data.assignment.id, data.assignment.revision);
    if (assignment?.kind !== 'assignment' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(assignment.firstMateTaskId) ||
      data.args[0] !== assignment.firstMateTaskId || data.args[1] !== data.repository) throw new Error('worker_start_assignment_mismatch');
    const id = stableId('worker-start', data.projectId, data.idempotencyKey);
    const at = new Date().toISOString();
    const decision = { kind: 'decision_change' as const, id: stableId('worker-start-intent', id), projectId: data.projectId,
      schemaVersion: 1 as const, revision: 1, createdAt: at, updatedAt: at, questionOrChange: 'Start checked worker through FirstMate',
      affectedRecords: [data.assignment], rationale: JSON.stringify({ ...data, fmHome: options.fmHome }),
      disposition: 'selected' as const, sourceRefs: [{ uri: `firstmate:task/${assignment.firstMateTaskId}` }], scopeChanges: [] };
    const command = { schemaVersion: 1 as const, id, projectId: data.projectId, issuedAt: at, idempotencyKey: data.idempotencyKey,
      command: 'record_decision_suggestion' as const, targetId: id, expectedRevision: 0, payload: { decision } };
    // Compare semantic receipt content independent of its first issuance timestamp.
    const receipt = store.receipt(data.projectId, data.idempotencyKey);
    let operation = store.get(data.projectId, id);
    if (receipt) {
      if (receipt.command.command !== command.command || receipt.command.targetId !== id ||
        receipt.command.payload.decision.rationale !== decision.rationale || operation?.kind !== 'operation' ||
        commandDigest(receipt.command) !== operation.payloadDigest) throw new Error('worker_start_intent_conflict');
    } else {
      store.mutate(command, () => [decision, pendingOperation(command, id)]);
      operation = store.get(data.projectId, id);
    }
    if (operation?.kind !== 'operation') throw new Error('worker_start_intent_missing');
    store.assertExternalOperationsAllowed(data.projectId, operation);
    if (operation.state === 'succeeded') return operation;
    let snapshot: FleetSnapshot;
    try { snapshot = readFleetSnapshot(options); }
    catch (error) { return recordOperationObservation(store, operation, operation.externalAttempt ? 'unknown' : 'pending', String(error)); }
    try {
      const task = runtimeTask(snapshot, assignment.firstMateTaskId);
      const latest = store.get(data.projectId, assignment.id);
      const currentAttempts = store.records(data.projectId).filter((record) => record.kind === 'assignment' && record.firstMateTaskId === assignment.firstMateTaskId);
      if (latest?.kind !== 'assignment' || latest.attemptId !== assignment.attemptId ||
        latest.firstMateTaskId !== assignment.firstMateTaskId || currentAttempts.some((record) => record.id !== assignment.id &&
          Date.parse(record.updatedAt) >= Date.parse(assignment.updatedAt))) throw new Error('worker_start_attempt_superseded');
      if (operation.externalAttempt) {
        if (task?.spawn_gen && task.project === data.repository &&
          Date.parse(snapshot.generated) >= Date.parse(operation.externalAttempt.startedAt) &&
          task.spawn_gen !== operation.externalAttempt.baselineGeneration) {
          return recordOperationObservation(store, operation, 'succeeded', JSON.stringify({ recovered: 'worker_start', snapshot }));
        }
        return recordOperationObservation(store, operation, 'unknown', JSON.stringify({ reason: 'Start outcome unresolved; no retry authorized', snapshot }));
      }
      if (latest.revision !== assignment.revision) throw new Error('worker_start_attempt_superseded');
      // Any pre-existing generation belongs to ordinary FirstMate management.
      if (task?.spawn_gen) return recordOperationObservation(store, operation, 'unknown', JSON.stringify({ reason: 'Existing worker generation; explicit new attempt required', snapshot }));
      if (!data.hookRegistry || !assignment.brief) return recordOperationObservation(store, operation, 'pending', 'Worker start requires configured instruction and dispatch check');
      const checked = checkConfiguredWorkerStart(store, data.projectId, assignment.firstMateTaskId, options.fmHome, data.hookRegistry, assignment.brief.path);
      if (!checked.ok || !checked.managed) return recordOperationObservation(store, operation, 'pending', JSON.stringify({ reason: 'worker_start_check_failed', checked }));
      operation = recordOperationObservation(store, operation, 'unknown', JSON.stringify({ reason: 'Worker start begun', snapshot }), {
        externalAttempt: { action: 'start', firstMateTaskId: assignment.firstMateTaskId, assignment: data.assignment,
          attemptId: assignment.attemptId, repository: data.repository, baselineGeneration: null, startedAt: new Date().toISOString() } });
      const stdout = execFileSync(data.executable, data.args, { cwd: options.fmHome, env: firstMateEnv(options.fmHome),
        encoding: 'utf8', timeout: options.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return recordOperationObservation(store, operation, 'succeeded', JSON.stringify({ accepted: true, stdout }));
    } catch (error) { return recordOperationObservation(store, operation, 'unknown', String(error)); }
  });
}
