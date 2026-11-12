import { z } from 'zod';
import { IdSchema, TextSchema, TimestampSchema } from './primitives.js';
import { outstandingTaskCorrections } from './correction-state.js';
import { taskDependencyIds, taskPrerequisites, taskReadinessReasons } from './task-readiness.js';
import { executionTaskView, sameRef, uiStaleAfterMs, type ProjectView } from './ui-state.js';

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
    const raw = view.options.readSnapshot?.();
    const parsed = WorkSnapshotSchema.safeParse(raw);
    if (parsed.success && Date.parse(parsed.data.observedAt) <= now) snapshot = parsed.data;
    else if (raw !== undefined) snapshotError = 'Unknown — invalid FirstMate snapshot';
  } catch { snapshotError = 'Unknown — FirstMate snapshot read failed'; }
  const threshold = uiStaleAfterMs(view.options.staleAfterMs);
  const stale = !!snapshot && now - Date.parse(snapshot.observedAt) > threshold;
  const observations = snapshot?.tasks ?? [];
  const mappings = view.records.filter((record) => record.kind === 'task_mapping');
  const rows = mappings.map((mapping) => {
    const feature = view.features.find((item) => item.feature.id === mapping.feature?.id);
    const execution = executionTaskView(view.records, mapping, view.options, now);
    const matches = observations.filter((item) => item.firstMateTaskId === mapping.firstMateTaskId);
    const observation = matches.length === 1 ? matches[0] : undefined;
    const assignments = view.records.filter((record) => record.kind === 'assignment' && record.firstMateTaskId === mapping.firstMateTaskId);
    const corrections = outstandingTaskCorrections(view.records, mapping.firstMateTaskId);
    const reasons = taskReadinessReasons(view.records, mapping);
    const unknowns: string[] = [];
    if (!execution.task) unknowns.push(execution.label);
    if (execution.stale) unknowns.push('Unknown current execution state — last task observation is missing or stale');
    if (!observation) unknowns.push(matches.length > 1 ? 'Unknown — ambiguous worker observations' : 'Unknown — worker observation unavailable');
    if (!feature) unknowns.push('Unknown — feature context unavailable');
    else {
      if (feature.feature.disposition.state !== 'active') reasons.push(`Feature ${feature.feature.disposition.state}: ${feature.feature.disposition.reason}`);
      if (!feature.plan) unknowns.push('Unknown — selected product plan unavailable');
      else if (!feature.plan.readiness.ready || !sameRef(feature.plan.feature, feature.feature) || !sameRef(feature.plan.design, feature.design)) reasons.push('Product readiness — selected plan is incomplete or stale');
      if (!sameRef(mapping.feature, feature.feature)) reasons.push('Product readiness — mapping names an earlier feature revision');
    }
    const planTask = mapping.detailedPlanTask && view.history.find((record) => sameRef(record, mapping.detailedPlanTask));
    if (planTask?.kind === 'detailed_plan_task') reasons.push(...(planTask.blockers ?? []).map((reason) => `Plan blocker: ${reason}`));
    else unknowns.push('Unknown — detailed plan task unavailable');
    if (execution.task?.hold) reasons.push(`Hold: ${execution.task.hold.reason}${execution.task.hold.until ? ` until ${execution.task.hold.until}` : ' (indefinite)'}`);
    else if (execution.task?.held) unknowns.push('Unknown — hold reason unavailable');
    reasons.push(...(execution.task?.blocked_by ?? []).map((id) => `Execution dependency blocks: ${id}`));
    if (execution.task?.blocked && !execution.task.blocked_by.length) unknowns.push('Unknown — dependency blocking reason unavailable');
    for (const correction of corrections) reasons.push(`Unresolved correction delivery/incorporation: ${correction.id}`);
    if (observation?.reviewWait) reasons.push(`Review wait: ${observation.reviewWait}`);
    const results = view.records.filter((record) => record.kind === 'criterion_result' && assignments.some((assignment) => sameRef(assignment, record.assignment)));
    if ((results.length || execution.task?.state === 'done' || observation?.workerState === 'returned') && feature?.completeness.startsWith('Incomplete')) reasons.push('Review wait — current product behavior still needs verification');
    if (observation?.executionMs == null) unknowns.push('Execution time: Unknown');
    if (observation?.waitingMs == null) unknowns.push('Waiting time: Unknown');
    if (observation?.workerState == null) unknowns.push('Worker state: Unknown');
    if (observation?.ready == null) unknowns.push('Ready PRs or branches: Unknown');
    if (observation?.reviewWait == null) unknowns.push('Review wait observation: Unknown');
    const dependencies = taskDependencyIds(view.records, mapping).map((id) => {
      const candidates = mappings.filter((candidate) => candidate.firstMateTaskId === id);
      const prerequisite = candidates.length === 1 ? candidates[0] : undefined;
      const observed = prerequisite && executionTaskView(view.records, prerequisite, view.options, now);
      const label = prerequisite?.disposition.state === 'cancelled' ? 'Cancelled prerequisite — explicit replanning required' :
        !observed?.task ? 'Unknown — prerequisite observation unavailable' : observed.label;
      if (!observed?.task || observed.stale) unknowns.push(`Dependency ${id}: ${label}`);
      else if (observed.task.state !== 'done') reasons.push(`Dependency ${id}: ${label}`);
      return { id, mapping: prerequisite, label };
    });
    const requirements = taskPrerequisites(view.records, mapping);
    const consumers = mappings.filter((candidate) => taskDependencyIds(view.records, candidate).includes(mapping.firstMateTaskId));
    return { ...execution, feature, observation, assignments, corrections, dependencies, requirements, consumers,
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
