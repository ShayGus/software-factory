import { FirstMateTaskSchema } from './firstmate.js';
import { ref, requestCoverage, unclassifiedRequests } from './intake.js';
import type { Ref } from './primitives.js';
import type { FactoryRecord, FeatureRevision, DesignRevision, ImplementationPlanRevision } from './records.js';
import { hasUnchangedFeatureScope, validateReviewForCompletion } from './rules.js';
import { ProjectStore, StoreError } from './store.js';
import { currentAssignmentAttempts } from './task-readiness.js';
import { outstandingTaskCorrections } from './correction-state.js';
import { editBaseSourceUri } from './ui-edit.js';

export interface UiOptions { projectId: string; fixture?: boolean; staleAfterMs?: number; scottyUrl?: string }
export const sameRef = (a: Ref | null | undefined, b: Ref | null | undefined) => !!a && !!b && a.id === b.id && a.revision === b.revision;
export function projectView(store: ProjectStore, options: UiOptions, now = Date.now()) {
  const history = store.history(options.projectId);
  const records = store.records(options.projectId);
  const project = records.find((record) => record.kind === 'project');
  if (!project) throw new StoreError('not_found', 'project_not_found');
  const features = records.filter((record): record is FeatureRevision => record.kind === 'feature_revision');
  const lookup = (target: Ref) => history.find((record) => sameRef(record, target));
  const receipts = store.exportProject(options.projectId).receipts;
  const bundle = (design: DesignRevision, plan: ImplementationPlanRevision) => {
    const tasks = plan.deliverySequence.flatMap((target) => {
      const task = lookup(target);
      return task?.kind === 'detailed_plan_task' ? [task] : [];
    });
    return tasks.length === plan.deliverySequence.length ? { design, plan, tasks } : undefined;
  };
  const featureViews = features.map((feature) => {
    const designs = history.filter((record): record is Extract<FactoryRecord, { kind: 'design_revision' }> => record.kind === 'design_revision' && record.feature?.id === feature.id);
    designs.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.revision - b.revision);
    const plans = history.filter((record): record is Extract<FactoryRecord, { kind: 'implementation_plan_revision' }> => record.kind === 'implementation_plan_revision' && record.feature?.id === feature.id);
    plans.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.revision - b.revision);
    const stages = records.filter((record): record is Extract<FactoryRecord, { kind: 'stage_revision' }> =>
      record.kind === 'stage_revision' && sameRef(record.feature, feature))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.revision - b.revision);
    const currentPlanStage = stages.filter((stage) => stage.stage === 'plan').at(-1);
    const detailStage = stages.filter((stage) => stage.stage === 'detail' && currentPlanStage &&
      sameRef(stage.previousStage, currentPlanStage) && stage.artifact.id === currentPlanStage.artifact.id &&
      stage.artifact.revision >= currentPlanStage.artifact.revision).at(-1);
    const historicalDetails = stages.filter((stage) => stage.stage === 'detail' && !sameRef(stage, detailStage));
    const planStage = detailStage ?? currentPlanStage;
    const selectedPlan = planStage && lookup(planStage.artifact);
    const readyPlan = detailStage && plans.filter((candidate) => {
      const check = candidate.workflow?.readinessCheck && lookup(candidate.workflow.readinessCheck);
      return candidate.readiness.ready && check?.kind === 'plan_readiness_revision' && check.ready &&
        sameRef(check.detailStage, detailStage) && sameRef(check.plan, detailStage.artifact);
    }).at(-1);
    const plan = readyPlan || (selectedPlan?.kind === 'implementation_plan_revision' ? selectedPlan : plans.at(-1));
    const designStage = stages.filter((stage) => stage.stage === 'design').at(-1);
    const selectedDesign = designStage ? lookup(designStage.artifact) : plan && lookup(plan.design);
    const design = selectedDesign?.kind === 'design_revision' ? selectedDesign : designs.at(-1);
    const newer = (candidate: Ref & { updatedAt: string }, selected: (Ref & { updatedAt: string }) | undefined) => selected &&
      !sameRef(candidate, selected) && (Date.parse(candidate.updatedAt) > Date.parse(selected.updatedAt) ||
        (candidate.id === selected.id && candidate.revision > selected.revision));
    const designDrafts = designs.filter((candidate) => newer(candidate, design));
    const planDrafts = plans.filter((candidate) => newer(candidate, plan));
    const drafts = planDrafts.filter((candidate) => !candidate.readiness.ready && sameRef(candidate.feature, feature) &&
      !history.some((record) => record.kind === 'stage_revision' && sameRef(record.artifact, candidate))).map((candidate) => {
      const receipt = receipts.find((entry) => entry.command.command === 'design_plan_feature' &&
        'plan' in entry.command.payload && sameRef(entry.command.payload.plan, candidate));
      const command = receipt?.command;
      const baseDesign = command?.command === 'design_plan_feature' && 'plan' in command.payload ?
        command.payload.existingDesignRefs.find((source) => source.uri === editBaseSourceUri)?.record ?? candidate.design : candidate.design;
      const sourceDesign = lookup(candidate.design);
      return { baseDesign, plan: candidate, bundle: sourceDesign?.kind === 'design_revision' ? bundle(sourceDesign, candidate) : undefined };
    });
    // One edit base for every artifact editor. A draft must identify the selected
    // design it was built on; incompatible drafts remain read-only context.
    const editBundle = drafts.filter((draft) => sameRef(draft.baseDesign, design) && draft.bundle).at(-1)?.bundle ??
      (design && plan ? bundle(design, plan) : undefined);
    const conflictingDrafts = drafts.filter((draft) => !sameRef(draft.baseDesign, design)).map((draft) => draft.plan);
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
          hasUnchangedFeatureScope(history, assignment.feature, feature) && sameRef(assignment.design, design) && sameRef(assignment.plan, plan) &&
          currentAssignmentAttempts(records, (candidate) => candidate.firstMateTaskId === assignment.firstMateTaskId)
            .every((candidate, _index, all) => all.length === 1 && sameRef(candidate, assignment)) &&
          !outstandingTaskCorrections(records, assignment.firstMateTaskId).length;
      });
      const verified = demonstrated.some((result) => reviews.some((review) => {
        if (!review.feature || !hasUnchangedFeatureScope(history, review.feature, feature) ||
          !sameRef(review.design, design) || !sameRef(review.plan, plan) ||
          !review.results.some((entry) => sameRef(entry, result)) || !review.assignments.some((entry) => sameRef(entry, result.assignment))) return false;
        if (review.conformance) return !review.conformance.error && review.conformance.verdict?.criteria.some((outcome) =>
          sameRef(outcome.criterion, target) && outcome.state === 'accomplished') === true;
        const comparisons = [review.sourceComparison, review.instructionFidelity, review.planConformance];
        const findings = comparisons.flatMap((comparison) => comparison.findings).filter((finding) => finding.criterionId === target.id);
        if (findings.some((finding) => finding.result !== 'passed' && !finding.resolvedBy)) return false;
        return findings.some((finding) => finding.result === 'passed' && finding.evidence.length) ||
          comparisons.every((comparison) => comparison.result === 'passed');
      }));
      return { target, criterion, results, demonstrated, label: verified ? 'Demonstrated (reviewed)' :
        demonstrated.length ? 'Reported evidence; product review pending' : results.length ? 'Incomplete — no current passing evidence' : 'Missing evidence — untested' };
    });
    const decisions = records.filter((record): record is Extract<FactoryRecord, { kind: 'decision_change' }> => record.kind === 'decision_change' && (
      record.affectedRecords.some((target) => target.id === feature.id) || feature.decisions.some((target) => target.id === record.id)));
    const corrections = records.filter((record): record is Extract<FactoryRecord, { kind: 'observation' }> => record.kind === 'observation' && !!record.correction &&
      (record.correction.affectedRevision.id === feature.id || assignments.some((assignment) => assignment.id === record.correction!.assignment.id)));
    const tasks = records.filter((record): record is Extract<FactoryRecord, { kind: 'task_mapping' }> => record.kind === 'task_mapping' && record.feature?.id === feature.id).map((mapping) => {
      const operation = mapping.management && records.find((record) => record.id === mapping.management!.operationId);
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
        priority: task?.priority,
        label: operation?.kind === 'operation' && operation.state === 'unknown' ? 'Unknown outcome — reconciliation required' :
          !task ? 'Unknown — execution observation unavailable' : stale ? `Stale — last observed ${task.state}` : `Observed — ${task.state}` };
    });
    return { feature, designs, design, designDrafts, plans, plan, planDrafts, editBundle, conflictingDrafts, historicalDetails, assignments, reviews, criteria, decisions, corrections, tasks,
      stages: history.filter((record): record is Extract<FactoryRecord, { kind: 'stage_revision' }> => record.kind === 'stage_revision' && record.feature.id === feature.id),
      requests: feature.sourceRequests.map((target) => ({ target, record: lookup(target),
        coverage: requestCoverage(store, options.projectId, target.id) })),
      completeness: passedReviews.length ? 'Complete — current product review passed' : 'Incomplete — product behavior still needs verification',
      remaining: criteria.filter((item) => item.label !== 'Demonstrated (reviewed)'),
    };
  });
  const suggestions = records.filter((record): record is Extract<FactoryRecord, { kind: 'decision_change' }> => record.kind === 'decision_change' && record.disposition === 'proposed' && record.choice?.state !== 'open');
  const input = records.filter((record): record is Extract<FactoryRecord, { kind: 'decision_change' }> => record.kind === 'decision_change' && record.choice?.state === 'open');
  return { project, options, history, records, features: featureViews, suggestions, input,
    unclassified: unclassifiedRequests(store, options.projectId), readAt: new Date(now).toISOString() };
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
