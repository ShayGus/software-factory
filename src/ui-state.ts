import { FirstMateTaskSchema } from './firstmate.js';
import { ref, requestCoverage } from './intake.js';
import type { Ref } from './primitives.js';
import type { FactoryRecord, FeatureRevision } from './records.js';
import { hasUnchangedFeatureScope, validateReviewForCompletion } from './rules.js';
import { ProjectStore, StoreError } from './store.js';

export interface UiOptions { projectId: string; fixture?: boolean; staleAfterMs?: number; scottyUrl?: string }
export const sameRef = (a: Ref | null | undefined, b: Ref | null | undefined) => !!a && !!b && a.id === b.id && a.revision === b.revision;
export function projectView(store: ProjectStore, options: UiOptions, now = Date.now()) {
  const history = store.history(options.projectId);
  const records = store.records(options.projectId);
  const project = records.find((record) => record.kind === 'project');
  if (!project) throw new StoreError('not_found', 'project_not_found');
  const features = records.filter((record): record is FeatureRevision => record.kind === 'feature_revision');
  const lookup = (target: Ref) => history.find((record) => sameRef(record, target));
  const featureViews = features.map((feature) => {
    const designs = history.filter((record): record is Extract<FactoryRecord, { kind: 'design_revision' }> => record.kind === 'design_revision' && record.feature?.id === feature.id);
    designs.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.revision - b.revision);
    const design = designs.at(-1);
    const plans = history.filter((record): record is Extract<FactoryRecord, { kind: 'implementation_plan_revision' }> => record.kind === 'implementation_plan_revision' && record.feature?.id === feature.id);
    plans.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.revision - b.revision);
    const plan = plans.at(-1);
    const assignments = records.filter((record): record is Extract<FactoryRecord, { kind: 'assignment' }> => record.kind === 'assignment' && record.feature?.id === feature.id);
    const reviews = records.filter((record): record is Extract<FactoryRecord, { kind: 'product_review' }> => record.kind === 'product_review' && record.feature?.id === feature.id);
    const passedReviews = reviews.filter((review) => validateReviewForCompletion(history, ref(review)).ok &&
      sameRef(review.design, design) && sameRef(review.plan, plan));
    const criteria = feature.criteria.map((target) => {
      const criterion = lookup(target);
      const results = records.filter((record): record is Extract<FactoryRecord, { kind: 'criterion_result' }> => record.kind === 'criterion_result' && sameRef(record.criterion, target));
      const demonstrated = results.filter((result) => {
        const assignment = lookup(result.assignment);
        return result.result === 'passed' && assignment?.kind === 'assignment' && assignment.feature &&
          hasUnchangedFeatureScope(history, assignment.feature, feature) && sameRef(assignment.design, design) && sameRef(assignment.plan, plan);
      });
      const verified = demonstrated.some((result) => passedReviews.some((review) => review.results.some((entry) => sameRef(entry, result))));
      return { target, criterion, results, demonstrated, label: verified ? 'Demonstrated (reviewed)' :
        demonstrated.length ? 'Reported evidence; product review pending' : results.length ? 'Incomplete — no current passing evidence' : 'Missing evidence — untested' };
    });
    const decisions = records.filter((record): record is Extract<FactoryRecord, { kind: 'decision_change' }> => record.kind === 'decision_change' && (
      record.affectedRecords.some((target) => target.id === feature.id) || feature.decisions.some((target) => target.id === record.id)));
    const corrections = records.filter((record): record is Extract<FactoryRecord, { kind: 'observation' }> => record.kind === 'observation' && !!record.correction &&
      (record.correction.affectedRevision.id === feature.id || assignments.some((assignment) => assignment.id === record.correction!.assignment.id)));
    const tasks = records.filter((record): record is Extract<FactoryRecord, { kind: 'task_mapping' }> => record.kind === 'task_mapping' && record.feature?.id === feature.id).map((mapping) => {
      const operation = mapping.management && records.find((record) => record.id === mapping.management!.operationId);
      const receipt = operation?.kind === 'operation' && store.receipt(options.projectId, operation.idempotencyKey);
      let task;
      if (operation?.kind === 'operation' && operation.reconciliation) {
        try {
          const parsed = FirstMateTaskSchema.safeParse(JSON.parse(operation.reconciliation.note).task);
          if (parsed.success && parsed.data.id === mapping.firstMateTaskId) task = parsed.data;
        } catch { /* Malformed/missing observations are unknown, never empty work. */ }
      }
      const observedAt = operation?.kind === 'operation' ? operation.reconciliation?.observedAt : undefined;
      const stale = !observedAt || now - Date.parse(observedAt) > (options.staleAfterMs ?? 60000);
      return { mapping, operation, task, observedAt, stale,
        priority: task?.priority ?? (receipt && receipt.command.command === 'map_manage_execution_task' ? receipt.command.payload.priority : undefined),
        label: operation?.kind === 'operation' && operation.state === 'unknown' ? 'Unknown outcome — reconciliation required' :
          !task ? 'Unknown — execution observation unavailable' : stale ? `Stale — last observed ${task.state}` : `Observed — ${task.state}` };
    });
    return { feature, designs, design, plans, plan, assignments, reviews, criteria, decisions, corrections, tasks,
      stages: history.filter((record): record is Extract<FactoryRecord, { kind: 'stage_revision' }> => record.kind === 'stage_revision' && record.feature.id === feature.id),
      requests: feature.sourceRequests.map((target) => ({ target, record: lookup(target),
        coverage: requestCoverage(store, options.projectId, target.id) })),
      completeness: passedReviews.length ? 'Complete — current product review passed' : 'Incomplete — product behavior still needs verification',
      remaining: criteria.filter((item) => item.label !== 'Demonstrated (reviewed)'),
    };
  });
  const suggestions = records.filter((record): record is Extract<FactoryRecord, { kind: 'decision_change' }> => record.kind === 'decision_change' && record.disposition === 'proposed' && record.choice?.state !== 'open');
  const input = records.filter((record): record is Extract<FactoryRecord, { kind: 'decision_change' }> => record.kind === 'decision_change' && record.choice?.state === 'open');
  return { project, options, history, records, features: featureViews, suggestions, input, readAt: new Date(now).toISOString() };
}
export type ProjectView = ReturnType<typeof projectView>;
export type FeatureView = ProjectView['features'][number];
export function featureView(view: ProjectView, id: string): FeatureView {
  const feature = view.features.find((item) => item.feature.id === id);
  if (!feature) throw new StoreError('not_found', 'feature_not_found');
  return feature;
}
export function relatedRefs(record: FactoryRecord): Ref[] {
  const refs: Ref[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('id' in value && 'revision' in value && Object.keys(value).length === 2) refs.push(value as Ref);
    else for (const child of Object.values(value)) visit(child);
  };
  for (const value of Object.values(record)) visit(value);
  return [...new Map(refs.map((target) => [`${target.id}@${target.revision}`, target])).values()];
}
