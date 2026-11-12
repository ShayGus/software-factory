import { z } from 'zod';
import { IdSchema, TextSchema, TimestampSchema } from './primitives.js';
import { currentCorrections, intendedCorrectionRecipient, hasCorrectionFact, correctionRequiresIncorporation, correctionOrder } from './correction-state.js';
import { taskDependencyIds, taskPrerequisites, taskReadinessReasons } from './task-readiness.js';
import { executionTaskView, sameRef, uiStaleAfterMs, type ProjectView } from './ui-state.js';
import { hasDispatchCompatibleFeatureScope, hasCheckedDesignReuse } from './rules.js';
import type { Assignment } from './records.js';
import { FleetSnapshotSchema } from './runtime.js';

/** Toolkit observation projection, not a claimed fm-fleet-snapshot wire format.
 * The runtime adapter supplies only fields supported by its structured snapshot.
 * Missing values stay null/unknown; provenance and omissions are mandatory. */
export const WorkSnapshotSchema = z.strictObject({
  observedAt: TimestampSchema,
  provenance: TextSchema,
  omissions: z.array(TextSchema),
  tasks: z.array(z.strictObject({
    firstMateTaskId: IdSchema,
    workerState: TextSchema.nullable(),
    executionMs: z.number().finite().nonnegative().nullable(),
    waitingMs: z.number().finite().nonnegative().nullable(),
    reviewWait: TextSchema.nullable(),
    ready: z.array(z.strictObject({
      kind: z.enum(['pr', 'branch']),
      reference: TextSchema,
      readySince: TimestampSchema.nullable(),
      nextAction: TextSchema.nullable(),
    })).nullable(),
  })),
});
export type WorkSnapshot = z.infer<typeof WorkSnapshotSchema>;

/** Project integration observations are captured by the runtime adapter/importer.
 * Reading Work projects that evidence without invoking FirstMate or refreshing its time. */
function importedWorkSnapshot(view: ProjectView): WorkSnapshot | undefined {
  const observation = view.project.integration?.observation;
  if (observation === undefined) return undefined;
  const fleet = FleetSnapshotSchema.parse(JSON.parse(observation).snapshot);
  const omissions = fleet.backlog.records.filter(task => task.structured === false)
    .map(task => typeof task.raw === 'string' && task.raw.trim() ? task.raw : JSON.stringify(task));
  if (!fleet.backlog.present) omissions.push('FirstMate backlog unavailable');
  const inventory = fleet.main_inventory as { valid?: boolean; reason?: unknown } | undefined;
  if (inventory?.valid === false) omissions.push(`FirstMate inventory incomplete: ${typeof inventory.reason === 'string' ? inventory.reason : 'Unknown reason'}`);
  for (const value of Array.isArray(fleet.omissions) ? fleet.omissions : []) {
    omissions.push(typeof value === 'string' && value.trim() ? value : JSON.stringify(value));
  }
  return WorkSnapshotSchema.parse({ observedAt: fleet.generated,
    provenance: `Imported fm-fleet-snapshot.v1 from ${fleet.fm_home}${typeof fleet.provenance === 'string' ? ` — ${fleet.provenance}` : ''}`,
    omissions,
    tasks: fleet.tasks.map(task => {
      const current = task.current_state;
      const known = current.freshness === 'fresh' && current.observed_at === fleet.generated && current.state !== 'unknown';
      if (!known) omissions.push(`Task ${task.id}: worker state is stale or unknown (observed ${current.observed_at}; ${current.freshness})`);
      const pr = z.object({ url: TextSchema }).safeParse(task.pr);
      const status = z.object({ status_log: z.object({ last_event: z.object({ age_seconds: z.number().finite().nonnegative() }) }) }).safeParse(task.paths);
      // A PR link alone is not evidence of readiness. Retain the installed crew
      // state's ready-for-review observation, with unknown timing when absent.
      const ready = known && current.state === 'done' && typeof current.detail === 'string' && /\bready for review\b/iu.test(current.detail) && pr.success;
      return { firstMateTaskId: task.id, workerState: known ? current.state : null,
        executionMs: null, waitingMs: null,
        reviewWait: ready ? current.detail : null,
        ready: ready ? [{ kind: 'pr', reference: pr.data.url,
          readySince: status.success ? new Date(Date.parse(current.observed_at) - status.data.status_log.last_event.age_seconds * 1000).toISOString() : null,
          nextAction: 'Review the observed PR using the existing task and assignment delivery instructions' }] : null };
    }),
  });
}
export function durationLabel(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return 'Unknown';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function workView(view: ProjectView, now = Date.parse(view.readAt)) {
  let snapshot: WorkSnapshot | undefined;
  let snapshotError = 'Unknown — FirstMate snapshot unavailable';
  try {
    const raw = view.options.readSnapshot ? view.options.readSnapshot() : importedWorkSnapshot(view);
    const parsed = WorkSnapshotSchema.safeParse(raw);
    if (parsed.success && Date.parse(parsed.data.observedAt) <= now) snapshot = parsed.data;
    else if (raw !== undefined) snapshotError = 'Unknown — invalid FirstMate snapshot';
  } catch { snapshotError = 'Unknown — FirstMate snapshot read failed'; }
  const threshold = uiStaleAfterMs(view.options.staleAfterMs);
  const stale = !!snapshot && now - Date.parse(snapshot.observedAt) > threshold;
  const observations = snapshot?.tasks ?? [];
  const mappings = view.records.filter((record) => record.kind === 'task_mapping');
  const executions = new Map(mappings.map((mapping) => [mapping.id, executionTaskView(view.records, mapping, view.options, now)]));
  // Native observed edges enrich navigation, never the editable canonical intent.
  const graph = new Map(mappings.map((mapping) => {
    const execution = executions.get(mapping.id)!;
    const managed = new Set(taskDependencyIds(view.records, mapping));
    const native = execution.task?.deps.filter((edge) => edge.type === 'blocked-by').map((edge) => edge.id) ?? [];
    return [mapping.id, [...new Set([...managed, ...native])].map((id) => ({ id,
      source: managed.has(id) ? 'Toolkit/product prerequisite' : 'Native observed blocked-by',
      observedAt: managed.has(id) ? undefined : execution.observedAt,
      stale: !managed.has(id) && execution.stale,
    }))] as const;
  }));
  const rows = mappings.map((mapping) => {
    const feature = view.features.find((item) => item.feature.id === mapping.feature?.id);
    const execution = executions.get(mapping.id)!;
    const matches = observations.filter((item) => item.firstMateTaskId === mapping.firstMateTaskId);
    const observation = matches.length === 1 ? matches[0] : undefined;
    const assignments = view.records.filter((record): record is Assignment => record.kind === 'assignment' && record.firstMateTaskId === mapping.firstMateTaskId);
    const corrections = currentCorrections(view.records).filter((record) => !record.correction.supersededBy &&
      intendedCorrectionRecipient(view.history, record)?.firstMateTaskId === mapping.firstMateTaskId &&
      !hasCorrectionFact(record, correctionRequiresIncorporation(record) ? 'incorporated' : 'delivered'))
      .sort((a, b) => correctionOrder(a) - correctionOrder(b));
    const correctionOperations = corrections.flatMap((record) => {
      const operation = view.records.find((item) => item.id === record.correction.operationId);
      return operation?.kind === 'operation' ? [{ correction: record, operation }] : [];
    });
    const reasons = taskReadinessReasons(view.records, mapping);
    const unknowns: string[] = [];
    if (!execution.task) unknowns.push(execution.label);
    if (execution.stale) unknowns.push('Unknown current execution state — last task observation is missing or stale');
    if (!observation) unknowns.push(matches.length > 1 ? 'Unknown — ambiguous worker observations' : 'Unknown — worker observation unavailable');
    if (feature) {
      if (feature.feature.disposition.state !== 'active') reasons.push(`Feature ${feature.feature.disposition.state}: ${feature.feature.disposition.reason}`);
      if (!feature.plan) unknowns.push('Unknown — selected product plan unavailable');
      else if (!feature.plan.readiness.ready || !feature.plan.feature || !hasDispatchCompatibleFeatureScope(view.history, feature.plan.feature, feature.feature) ||
        !sameRef(feature.plan.design, feature.design) || feature.design?.sourceComparison.result !== 'passed' ||
        (!feature.design.feature || (!hasDispatchCompatibleFeatureScope(view.history, feature.design.feature, feature.plan.feature) &&
          !hasCheckedDesignReuse(view.history, feature.design, feature.plan.feature)))) reasons.push('Product readiness — selected plan is incomplete or stale');
      if (!mapping.feature || !hasDispatchCompatibleFeatureScope(view.history, mapping.feature, feature.feature)) reasons.push('Product readiness — mapping scope differs from the current feature');
    }
    const planTask = mapping.detailedPlanTask && view.history.find((record) => sameRef(record, mapping.detailedPlanTask));
    const exactAssignments = assignments.filter((assignment) => sameRef(assignment.detailedPlanTask, mapping.detailedPlanTask));
    const designRef = planTask?.kind === 'detailed_plan_task' ? planTask.design : undefined;
    const planRef = planTask?.kind === 'detailed_plan_task' ? planTask.plan : undefined;
    const design = designRef && view.history.find((record) => sameRef(record, designRef));
    const plan = planRef && view.history.find((record) => sameRef(record, planRef));
    const sourceRefs = [...(design?.kind === 'design_revision' ? design.sourceRefs : []),
      ...(plan?.kind === 'implementation_plan_revision' ? plan.readiness.comparison.sourceRefs : []),
      ...exactAssignments.flatMap((assignment) => assignment.sourceRefs)];
    const sourceRequests = [...new Map(sourceRefs.flatMap((source) => {
      const request = source.record && view.history.find((record) => sameRef(record, source.record));
      return request?.kind === 'request' ? [[`${request.id}@${request.revision}`, request] as const] : [];
    })).values()];
    const maintenance = mapping.feature === null && planTask?.kind === 'detailed_plan_task' && planTask.feature === null && planTask.maintenanceObjective ?
      { objective: planTask.maintenanceObjective, task: planTask, design, plan } : undefined;
    if (!feature && !maintenance) unknowns.push('Unknown — feature context unavailable');
    if (planTask?.kind === 'detailed_plan_task') reasons.push(...(planTask.blockers ?? []).map((reason) => `Plan blocker: ${reason}`));
    else unknowns.push('Unknown — detailed plan task unavailable');
    if (execution.task?.hold) reasons.push(`Hold: ${execution.task.hold.reason}${execution.task.hold.until ? ` until ${execution.task.hold.until}` : ' (indefinite)'}`);
    else if (execution.task?.held) unknowns.push('Unknown — hold reason unavailable');
    reasons.push(...(execution.task?.blocked_by ?? []).map((id) => `Execution dependency blocks: ${id}`));
    if (execution.task?.blocked && !execution.task.blocked_by.length) unknowns.push('Unknown — dependency blocking reason unavailable');
    for (const correction of corrections) reasons.push(`Unresolved correction delivery/incorporation: ${correction.id}`);
    for (const { correction, operation } of correctionOperations) reasons.push(`Correction ${correction.correction.action}: ${operation.state} — ${operation.reconciliation?.note ?? 'Unknown — delivery observation unavailable'}`);
    if (observation?.reviewWait) reasons.push(`Review wait: ${observation.reviewWait}`);
    const results = view.records.filter((record) => record.kind === 'criterion_result' && assignments.some((assignment) => sameRef(assignment, record.assignment)));
    if ((results.length || execution.task?.state === 'done' || observation?.workerState === 'returned') && feature?.completeness.startsWith('Incomplete')) reasons.push('Review wait — current product behavior still needs verification');
    if (observation?.executionMs == null) unknowns.push('Execution time: Unknown');
    if (observation?.waitingMs == null) unknowns.push('Waiting time: Unknown');
    if (observation?.workerState == null) unknowns.push('Worker state: Unknown');
    if (observation?.ready == null) unknowns.push('Ready PRs or branches: Unknown');
    if (observation?.reviewWait == null) unknowns.push('Review wait observation: Unknown');
    const dependencies = graph.get(mapping.id)!.map((edge) => {
      const { id } = edge;
      const candidates = mappings.filter((candidate) => candidate.firstMateTaskId === id);
      const prerequisite = candidates.length === 1 ? candidates[0] : undefined;
      const observed = prerequisite && executionTaskView(view.records, prerequisite, view.options, now);
      const label = prerequisite?.disposition.state === 'cancelled' ? 'Cancelled prerequisite — explicit replanning required' :
        !observed?.task ? 'Unknown — prerequisite observation unavailable' : observed.label;
      if (!observed?.task || observed.stale) unknowns.push(`Dependency ${id}: ${label}`);
      else if (observed.task.state !== 'done') reasons.push(`Dependency ${id}: ${label}`);
      return { ...edge, mapping: prerequisite, label };
    });
    const requirements = taskPrerequisites(view.records, mapping);
    const consumers = mappings.flatMap((candidate) => {
      const edge = graph.get(candidate.id)!.find((entry) => entry.id === mapping.firstMateTaskId);
      return edge ? [{ ...candidate, edge }] : [];
    });
    return { ...execution, feature, maintenance, sourceRequests, observation, assignments, corrections, correctionOperations, dependencies, requirements, consumers,
      reasons: [...new Set(reasons)], unknowns: [...new Set(unknowns)] };
  });
  const ready = observations.flatMap((observation) => {
    // Ambiguous observations must not create confident ready entries.
    if (observations.filter((item) => item.firstMateTaskId === observation.firstMateTaskId).length !== 1) return [];
    return (observation.ready ?? []).map((entry) => ({ ...entry, firstMateTaskId: observation.firstMateTaskId,
      row: rows.find((item) => item.mapping.firstMateTaskId === observation.firstMateTaskId),
      age: entry.readySince && Date.parse(entry.readySince) <= now ? durationLabel(now - Date.parse(entry.readySince)) : 'Unknown' }));
  });
  const readyKnown = !!snapshot && observations.length > 0 && observations.every((item) => item.ready !== null) &&
    new Set(observations.map((item) => item.firstMateTaskId)).size === observations.length;
  return { rows, ready, snapshot, stale, threshold, readyKnown,
    snapshotLabel: snapshot ? `${stale ? 'Stale' : 'Observed'} — FirstMate snapshot taken ${snapshot.observedAt}` : snapshotError };
}
export type WorkView = ReturnType<typeof workView>;
