// Browser-safe command construction. Imports are types only; no second write path.
import type { CommandEnvelope } from './commands.js';
import type { Criterion, DesignRevision, DetailedPlanTask, FeatureRevision, ImplementationPlanRevision, TaskMapping } from './records.js';

type ProductContext = { feature: FeatureRevision; design: DesignRevision; plan: ImplementationPlanRevision; tasks: DetailedPlanTask[] };
export type EditContext =
  | { kind: 'feature'; feature: FeatureRevision }
  | { kind: 'criterion'; feature: FeatureRevision; criterion: Criterion }
  | { kind: 'task'; mapping: TaskMapping; action: 'set_priority' | 'edit_dependencies' | 'pause' | 'resume' }
  | (ProductContext & { kind: 'design' | 'plan' | 'plan-task'; taskId?: string });
export type EditValues = Record<string, string>;
const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
const lines = (value = '') => value.split('\n').map((line) => line.trim()).filter(Boolean);
const integer = (value: string | undefined) => {
  if (!value?.trim() || !/^-?\d+$/u.test(value)) throw new Error('Enter a whole-number priority.');
  return Number(value);
};
export function buildEditCommand(context: EditContext, values: EditValues, key: string, at: string): CommandEnvelope {
  if (!values.reason?.trim()) throw new Error('Explain the reason for this change.');
  const reason = values.reason.trim();
  const envelope = { schemaVersion: 1 as const, id: `ui-${key}`, projectId: context.kind === 'task' ? context.mapping.projectId : context.feature.projectId,
    issuedAt: at, idempotencyKey: key };
  if (context.kind === 'task') {
    const mapping = context.mapping;
    const priority = context.action === 'set_priority' ? integer(values.priority) : undefined;
    if (priority !== undefined && (priority < 0 || priority > 4)) throw new Error('Task priority must be between 0 and 4.');
    return { ...envelope, command: 'map_manage_execution_task', targetId: mapping.id, expectedRevision: mapping.revision,
      payload: { feature: mapping.feature, criteria: mapping.criteria, detailedPlanTask: mapping.detailedPlanTask,
        task: { kind: 'existing', firstMateTaskId: mapping.firstMateTaskId }, action: context.action,
        dependencies: context.action === 'edit_dependencies' ? (values.dependencies ?? '').split(',').map((id) => id.trim()).filter(Boolean) : mapping.dependencies,
        ...(priority === undefined ? {} : { priority }), reason } };
  }
  const feature = context.feature;
  const nextFeature = { ...feature, revision: feature.revision + 1, previousRevision: feature.revision, updatedAt: at,
    changeReason: reason, decisions: [...feature.decisions, { id: `change-${key}`, revision: 1 }],
    state: feature.state === 'complete' ? 'in_review' as const : feature.state };
  delete nextFeature.completionEvidence;
  if (context.kind === 'feature' || context.kind === 'criterion') {
    const nextCriterion = context.kind === 'criterion' ? { ...context.criterion, revision: context.criterion.revision + 1,
      updatedAt: at, expectedBehavior: values.expectedBehavior ?? context.criterion.expectedBehavior,
      verificationMethod: values.verificationMethod ?? context.criterion.verificationMethod } : undefined;
    if (context.kind === 'feature') {
      nextFeature.priority = integer(values.priority);
      nextFeature.outcome = values.outcome ?? feature.outcome;
      if (values.disposition === 'deferred') nextFeature.disposition = { state: 'deferred', reason, decision: { id: `change-${key}`, revision: 1 } };
      else if (values.disposition === 'active') nextFeature.disposition = { state: 'active' };
    }
    if (nextCriterion) nextFeature.criteria = nextFeature.criteria.map((entry) => entry.id === nextCriterion.id ? ref(nextCriterion) : entry);
    const records = nextCriterion ? [nextFeature, nextCriterion] : [nextFeature];
    return { ...envelope, command: 'record_decision_suggestion', targetId: feature.id, expectedRevision: feature.revision,
      payload: { decision: { kind: 'decision_change', id: `change-${key}`, projectId: feature.projectId, schemaVersion: 1,
        revision: 1, createdAt: at, updatedAt: at, questionOrChange: context.kind === 'feature' ? 'Edit feature priority, outcome or disposition' : 'Amend criterion behavior or verification',
        rationale: reason, disposition: 'selected', affectedRecords: records.map(ref),
        sourceRefs: feature.sourceRequests.map((request) => ({ uri: `factory:record/${encodeURIComponent(request.id)}@${request.revision}`, record: request })),
        scopeChanges: nextCriterion ? [{ featureId: feature.id, fromRevision: feature.revision, toRevision: nextFeature.revision,
          criterionId: nextCriterion.id, action: 'amend' }] : [],
      }, intakeRecords: records } };
  }
  const design = { ...context.design, revision: context.design.revision + 1, updatedAt: at, feature: ref(feature),
    sourceComparison: { ...context.design.sourceComparison, result: 'untested' as const, findings: [], comparedAt: at } };
  if (design.workflow) design.workflow = { ...design.workflow, changeReason: reason };
  if (context.kind === 'design') {
    for (const field of ['productBehavior', 'technicalDesign', 'dataFlow', 'testingApproach'] as const) if (values[field] !== undefined) design[field] = values[field];
    for (const field of ['examples', 'reuseFindings', 'interfaces', 'alternatives', 'exclusions', 'unresolvedQuestions'] as const) if (values[field] !== undefined) design[field] = lines(values[field]);
  }
  const plan = { ...context.plan, revision: context.plan.revision + 1, updatedAt: at, feature: ref(feature), design: ref(design),
    readiness: { ready: false, comparison: { ...context.plan.readiness.comparison, result: 'untested' as const, findings: [], comparedAt: at,
      sourceRefs: [...feature.sourceRequests, ref(design)].map((target) => ({ uri: `factory:record/${encodeURIComponent(target.id)}@${target.revision}`, record: target })) } } };
  if (context.kind === 'plan') {
    plan.integrationApproach = values.integrationApproach ?? plan.integrationApproach;
    plan.strategyReason = values.strategyReason ?? plan.strategyReason;
    if (values.strategy === 'focused' || values.strategy === 'parallel') plan.strategy = values.strategy;
  }
  const tasks = context.tasks.map((original) => {
    const task = { ...original, revision: original.revision + 1, updatedAt: at, feature: ref(feature), design: ref(design), plan: ref(plan) };
    if (context.kind === 'plan-task' && original.id === context.taskId) {
      for (const field of ['expectedBehavior', 'verificationMethod'] as const) if (values[field] !== undefined) task[field] = values[field];
      for (const field of ['boundaries', 'inputs', 'outputs', 'verificationCases', 'returnRequirements', 'blockers'] as const) if (values[field] !== undefined) task[field] = lines(values[field]);
    }
    return task;
  });
  plan.deliverySequence = tasks.map(ref);
  if (plan.workflow) {
    const { readinessCheck: _check, ...workflow } = plan.workflow;
    plan.workflow = { ...workflow, changeReason: reason, retainedTasks: [], slices: workflow.slices.map((slice) => ({ ...slice,
      tasks: slice.tasks.map((target) => ref(tasks.find((task) => task.id === target.id) ?? target)) })),
      integrationSteps: values.integrationSteps === undefined ? workflow.integrationSteps : lines(values.integrationSteps),
      finalVerification: values.finalVerification === undefined ? workflow.finalVerification : lines(values.finalVerification) };
  }
  return { ...envelope, command: 'design_plan_feature', targetId: context.kind === 'design' ? context.design.id : context.plan.id,
    expectedRevision: context.kind === 'design' ? context.design.revision : context.plan.revision,
    payload: { feature: ref(feature), sourceRefs: design.sourceRefs, existingDesignRefs: [],
      expectedRevisions: [feature, context.design, context.plan, ...context.tasks].map(ref), design, plan, tasks } };
}
