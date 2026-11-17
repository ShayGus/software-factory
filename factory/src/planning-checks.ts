import { artifactReuse } from './records.js';
import type { Ref } from './primitives.js';
import { isDeepStrictEqual } from 'node:util';
import type {
  FactoryRecord, ReadinessFinding, StageRevision, ImplementationPlanRevision, SliceCriterionProvenance,
} from './records.js';

export const samePlanningRef = (a: Ref, b: Ref) => a.id === b.id && a.revision === b.revision;
export function planningRecord(records: FactoryRecord[], ref: Ref) {
  return records.find((record) => samePlanningRef(record, ref));
}

/** Task/dependency lineage. Slice provenance is resolved separately below. */
export function stageCriteria(records: FactoryRecord[], detail: StageRevision, refs: Ref[], sourceFeature?: Ref | null,
  taskRefs?: Ref[]): Ref[] {
  if (sourceFeature === null || (sourceFeature && samePlanningRef(sourceFeature, detail.feature))) return refs;
  const plan = planningRecord(records, detail.artifact);
  if (plan?.kind !== 'implementation_plan_revision' || !plan.feature) return refs;

  // Detail may revise a reused ready plan. Follow the selected entity
  // back to that plan before composing its checked criterion mappings.
  const planStage = detail.previousStage && planningRecord(records, detail.previousStage);
  const selected = planStage?.kind === 'stage_revision' && planStage.stage === 'plan' && artifactReuse(planStage) &&
    planningRecord(records, planStage.artifact);
  let checkedPlan = plan;
  if (selected && selected.kind === 'implementation_plan_revision' && selected.feature && selected.readiness.ready &&
    selected.id === plan.id && selected.revision < plan.revision) {
    const retained = taskRefs ?? plan.deliverySequence;
    let cursor = plan;
    while (cursor.revision > selected.revision) {
      const previous = planningRecord(records, { id: cursor.id, revision: cursor.revision - 1 });
      if (previous?.kind !== 'implementation_plan_revision' || previous.projectId !== plan.projectId) break;
      if (!retained.length || !retained.every((task) =>
        cursor.deliverySequence.some((ref) => samePlanningRef(ref, task)) &&
        cursor.workflow?.retainedTasks.some((entry) => samePlanningRef(entry.task, task)) &&
        previous.deliverySequence.some((ref) => samePlanningRef(ref, task)))) break;
      cursor = previous;
    }
    if (samePlanningRef(cursor, selected)) checkedPlan = selected;
  }
  const prior = checkedPlanDetail(records, checkedPlan);
  if (prior && checkedPlan.feature &&
    (!sourceFeature || !samePlanningRef(sourceFeature, checkedPlan.feature))) {
    // The ready revision retained task revisions from its predecessor.
    refs = stageCriteria(records, prior, refs, sourceFeature, taskRefs);
    sourceFeature = checkedPlan.feature;
  }
  return mapStageCriteria(records, detail, refs, sourceFeature ?? plan.feature);
}

function mapStageCriteria(records: FactoryRecord[], detail: StageRevision, refs: Ref[], origin: Ref | null): Ref[] {
  if (!origin || samePlanningRef(origin, detail.feature)) return refs;

  const maps: NonNullable<StageRevision['reuse']>['criterionMap'][] = [];
  let stage: StageRevision | undefined = detail;
  for (let depth = 0; stage && depth < 3; depth++) {
    const artifact = planningRecord(records, stage.artifact);
    if (artifactReuse(stage)?.check.result === 'passed' && artifact &&
      (artifact.kind === 'design_revision' || artifact.kind === 'implementation_plan_revision') &&
      artifact.feature && samePlanningRef(artifact.feature, origin)) maps.push(artifactReuse(stage)!.criterionMap);
    const previous: FactoryRecord | undefined = stage.previousStage && planningRecord(records, stage.previousStage);
    stage = previous?.kind === 'stage_revision' ? previous : undefined;
  }
  return refs.flatMap((ref) => {
    for (const map of maps) {
      const mappings = map.filter((entry) => samePlanningRef(entry.existing, ref));
      if (mappings.length) return mappings.map((mapping) => mapping.current);
    }
    return [ref];
  }).filter((ref, index, all) => all.findIndex((other) => samePlanningRef(ref, other)) === index);
}

type Slice = NonNullable<ImplementationPlanRevision['workflow']>['slices'][number];

function checkedPlanDetail(records: FactoryRecord[], plan: ImplementationPlanRevision): StageRevision | undefined {
  const check = plan.readiness.ready && plan.workflow?.readinessCheck && planningRecord(records, plan.workflow.readinessCheck);
  const detail = check && check.kind === 'plan_readiness_revision' && check.ready &&
    check.plan.id === plan.id && check.plan.revision === plan.revision - 1 && planningRecord(records, check.detailStage);
  return detail && detail.kind === 'stage_revision' && samePlanningRef(detail.artifact, check.plan) ? detail : undefined;
}

/** The single compatibility boundary for pre-provenance history. Resolve a
 * retained slice independently of its task links, composing each readiness
 * check once. All new writes persist the resulting explicit record. */
export function sliceCriterionProvenance(records: FactoryRecord[], plan: ImplementationPlanRevision,
  slice: Slice): SliceCriterionProvenance {
  if (slice.criteriaProvenance) return slice.criteriaProvenance;
  const prior = planningRecord(records, { id: plan.id, revision: plan.revision - 1 });
  const previous = prior?.kind === 'implementation_plan_revision' ? prior : undefined;
  const old = previous?.workflow?.slices.find((item) => item.id === slice.id);
  const retained = old && isDeepStrictEqual(old.criteria, slice.criteria) &&
    (!slice.criteriaFeature || (old.criteriaFeature && samePlanningRef(slice.criteriaFeature, old.criteriaFeature)));
  const provenance = previous && retained ?
    sliceCriterionProvenance(records, previous, old) :
    { feature: slice.criteriaFeature ?? plan.feature, criteria: slice.criteria };
  const detail = checkedPlanDetail(records, plan);
  return detail ?
    { feature: detail.feature, criteria: mapStageCriteria(records, detail, provenance.criteria, provenance.feature) } : provenance;
}

/** Materialize the selected slice interpretation for readiness and editor reads. */
export function stageSliceCriteria(records: FactoryRecord[], detail: StageRevision, plan: ImplementationPlanRevision,
  slice: Slice): SliceCriterionProvenance {
  let provenance = sliceCriterionProvenance(records, plan, slice);
  // A named older bundle can predate the selected plan's source snapshot.
  // Carry its explicit interpretation through each intervening checked reuse
  // before applying the selected stage's mapping, including criterion splits.
  const selected = planningRecord(records, detail.artifact);
  if (selected?.kind === 'implementation_plan_revision' && selected.id === plan.id) {
    for (let revision = plan.revision + 1; revision <= selected.revision; revision++) {
      const next = planningRecord(records, { id: plan.id, revision });
      if (next?.kind !== 'implementation_plan_revision') break;
      const checked = checkedPlanDetail(records, next);
      if (checked) provenance = { feature: checked.feature,
        criteria: mapStageCriteria(records, checked, provenance.criteria, provenance.feature) };
    }
  }
  return { feature: detail.feature, criteria: mapStageCriteria(records, detail, provenance.criteria, provenance.feature) };
}

/** Shared by staged and combined authoring. Only criterion edits reauthor the
 * interpretation; changing task links never changes criterion provenance. */
export function withSliceCriterionProvenance(records: FactoryRecord[], plan: ImplementationPlanRevision,
  feature: Ref | null): ImplementationPlanRevision {
  if (!plan.workflow) return plan;
  const prior = planningRecord(records, { id: plan.id, revision: plan.revision - 1 });
  const previous = prior?.kind === 'implementation_plan_revision' ? prior : undefined;
  return { ...plan, workflow: { ...plan.workflow, slices: plan.workflow.slices.map((slice) => {
    const old = previous?.workflow?.slices.find((item) => item.id === slice.id);
    const retained = old && isDeepStrictEqual(old.criteria, slice.criteria);
    const supplied = slice.criteriaProvenance;
    const explicit = supplied && isDeepStrictEqual(supplied.criteria, slice.criteria) &&
      (!old || !isDeepStrictEqual(supplied, old.criteriaProvenance));
    const criteriaProvenance = explicit ? supplied : previous && retained ?
      sliceCriterionProvenance(records, previous, old) :
      { feature, criteria: slice.criteria };
    const { criteriaFeature: _legacy, ...content } = slice;
    return { ...content, criteria: criteriaProvenance.criteria, criteriaProvenance };
  }) } };
}

export function stageDependencies(records: FactoryRecord[], detail: StageRevision,
  dependencies: ImplementationPlanRevision['dependencies'], sourceFeature?: Ref | null): ImplementationPlanRevision['dependencies'] {
  const plan = planningRecord(records, detail.artifact);
  if (plan?.kind !== 'implementation_plan_revision') return dependencies;
  return dependencies.flatMap((dependency) => dependency.needs.kind === 'criterion' ?
    stageCriteria(records, detail, [dependency.needs.criterion], sourceFeature === undefined ? plan.feature : sourceFeature).map((criterion) => ({
      ...dependency, needs: { kind: 'criterion' as const, criterion },
    })) : [dependency]);
}

/** Structural, deterministic source checks. Scope roles are explicit source-analysis
 * data, not a claim that a keyword matcher understands arbitrary requests. */
export function planReadinessFindings(records: FactoryRecord[], detail: StageRevision): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  const add = (code: ReadinessFinding['code'], record: Ref, path: string, message: string) => {
    findings.push({ code, record: { id: record.id, revision: record.revision }, path, message });
  };
  const feature = planningRecord(records, detail.feature);
  if (feature?.kind !== 'feature_revision') {
    add('stage_gap', detail, 'feature', 'Feature revision is missing'); return findings;
  }
  const chain: StageRevision[] = [];
  let stage: StageRevision | undefined = detail;
  for (const expected of ['detail', 'plan', 'design', 'understand'] as const) {
    if (!stage || stage.stage !== expected || !samePlanningRef(stage.feature, feature)) {
      add('stage_gap', detail, 'previousStage', `Missing linked ${expected} stage`); return findings;
    }
    chain.push(stage);
    const prior: FactoryRecord | undefined = stage.previousStage && planningRecord(records, stage.previousStage);
    stage = prior?.kind === 'stage_revision' ? prior : undefined;
  }
  const [detailStage, planStage, designStage, understandStage] = chain as
    [StageRevision, StageRevision, StageRevision, StageRevision];
  const understanding = planningRecord(records, understandStage.artifact);
  const design = planningRecord(records, designStage.artifact);
  const plan = planningRecord(records, detailStage.artifact);
  const initialPlan = planningRecord(records, planStage.artifact);
  if (understanding?.kind !== 'understanding_revision' || design?.kind !== 'design_revision' ||
    plan?.kind !== 'implementation_plan_revision' || initialPlan?.kind !== 'implementation_plan_revision') {
    add('stage_gap', detail, 'artifact', 'Stage artifact is missing or has the wrong kind'); return findings;
  }
  if (plan.id !== initialPlan.id || plan.revision < initialPlan.revision || !samePlanningRef(plan.design, design)) {
    add('stage_gap', detail, 'artifact', 'Detail must refine the selected plan and preserve its selected design');
  }
  if ((!design.workflow && !artifactReuse(designStage)) || !plan.workflow) {
    add('stage_gap', plan, 'workflow', 'Design and plan need staged workflow content'); return findings;
  }
  if (design.sourceComparison.result !== 'passed' && !artifactReuse(designStage)) {
    add('source_gap', design, 'sourceComparison', 'Design source comparison has material findings');
  }
  for (const item of chain) {
    for (const request of feature.sourceRequests) if (!item.sourceRequests.some((ref) => samePlanningRef(ref, request))) {
      add('source_gap', item, 'sourceRequests', `Stage omitted original request ${request.id}`);
    }
    for (const criterion of feature.criteria) if (!item.criteria.some((ref) => samePlanningRef(ref, criterion))) {
      add('dropped_behavior', item, 'criteria', `Stage omitted criterion ${criterion.id}`);
    }
    if (item.reuse) {
      const comparison = item.reuse.check;
      if (comparison.result !== 'passed' || [...feature.sourceRequests, ...(artifactReuse(item) ? [item.artifact] : [])].some((ref) =>
        !comparison.sourceRefs.some((source) => source.record && samePlanningRef(source.record, ref)))) {
        add('source_gap', item, 'reuse.check', 'Reuse must pass a comparison against the current request and artifact');
      }
    }
  }
  for (const source of feature.sourceRequests) if (!understanding.sourceRequests.some((ref) => samePlanningRef(ref, source))) {
    add('source_gap', understanding, 'sourceRequests', `Understanding omitted original request ${source.id}`);
  }
  for (const criterion of feature.criteria) if (!understanding.criteria.some((ref) => samePlanningRef(ref, criterion))) {
    add('dropped_behavior', understanding, 'criteria', `Understanding omitted criterion ${criterion.id}`);
  }
  if (understanding.openUnknowns.length) add('stage_gap', understanding, 'openUnknowns', 'Material understanding unknowns remain open');
  const decisions = design.decisions.map((ref) => planningRecord(records, ref));
  const isSettled = (decision: FactoryRecord | undefined) => decision?.kind === 'decision_change' &&
    (decision.choice?.state === 'resolved' || (artifactReuse(designStage) && !decision.choice &&
      ['selected', 'rejected'].includes(decision.disposition)));
  for (const question of design.unresolvedQuestions) {
    const matches = decisions.filter((decision) => decision?.kind === 'decision_change' && decision.questionOrChange === question);
    if (!matches.some((decision) => isSettled(decision) ||
      (decision?.kind === 'decision_change' && decision.choice?.kind === 'technical'))) {
      add('unresolved_product_decision', design, 'unresolvedQuestions', question);
    }
  }
  if (['failed', 'blocked'].includes(plan.readiness.comparison.result) || plan.readiness.comparison.findings.some(
    (finding) => finding.result !== 'passed' && !finding.resolvedBy)) {
    add('source_gap', plan, 'readiness.comparison', 'Plan source comparison has material findings');
  }
  const selectedCriteria = (refs: Ref[], sourceFeature?: Ref | null, taskRefs?: Ref[]) =>
    stageCriteria(records, detail, refs, sourceFeature, taskRefs);
  const isCriterion = (ref: Ref) => feature.criteria.some((criterion) => samePlanningRef(criterion, ref));
  const slices = plan.workflow.slices;
  const tasks = plan.deliverySequence.flatMap((ref) => {
    const task = planningRecord(records, ref);
    if (task?.kind === 'detailed_plan_task') return [task];
    add('detail_gap', plan, 'deliverySequence', `Missing detailed task ${ref.id}`); return [];
  });
  const taskCriteria = tasks.flatMap((task) => selectedCriteria(task.criteria, task.feature, [task]));
  const sliceCriteria = slices.flatMap((slice) => stageSliceCriteria(records, detail, plan, slice).criteria);
  for (const ref of feature.criteria) {
    const criterion = planningRecord(records, ref);
    if (criterion?.kind !== 'criterion' || criterion.disposition.state !== 'active') continue;
    const inSlices = sliceCriteria.some((item) => samePlanningRef(item, ref));
    const inTasks = taskCriteria.some((item) => samePlanningRef(item, ref));
    if (criterion.requirement === 'optional' && !inSlices && !inTasks) continue;
    if (!inSlices || !inTasks) {
      add('dropped_behavior', plan, 'workflow.slices', `Criterion ${ref.id} needs both a delivery slice and a detailed task`);
    }
  }
  const ids = new Set<string>();
  for (const slice of slices) {
    if (slice.criteriaProvenance && !isDeepStrictEqual(slice.criteria, slice.criteriaProvenance.criteria)) {
      add('detail_gap', plan, 'workflow.slices.criteriaProvenance', `Slice ${slice.id} criteria differ from its provenance snapshot`);
    }
    if (ids.has(slice.id)) add('detail_gap', plan, 'workflow.slices', `Duplicate slice ${slice.id}`);
    ids.add(slice.id);
    const criteria = stageSliceCriteria(records, detail, plan, slice).criteria;
    const maintenanceSlice = slice.tasks.length > 0 && slice.tasks.every((ref) => {
      const task = tasks.find((candidate) => samePlanningRef(candidate, ref));
      return task && task.criteria.length === 0 && task.maintenanceObjective !== undefined;
    });
    if ((!criteria.length && !maintenanceSlice) || criteria.some((ref) => !isCriterion(ref))) {
      add('invented_scope', plan, 'workflow.slices', `Slice ${slice.id} is not linked to current criteria`);
    }
    if (!slice.tasks.length || slice.tasks.some((ref) => !plan.deliverySequence.some((task) => samePlanningRef(task, ref)))) {
      add('detail_gap', plan, 'workflow.slices', `Slice ${slice.id} needs tasks in the delivery sequence`);
    }
    for (const criterion of criteria) if (!slice.tasks.some((ref) => {
      const task = tasks.find((item) => samePlanningRef(item, ref));
      return task && selectedCriteria(task.criteria, task.feature, [task]).some((item) => samePlanningRef(item, criterion));
    })) add('dropped_behavior', plan, 'workflow.slices', `Slice ${slice.id} has no task for ${criterion.id}`);
  }
  for (const task of tasks) {
    const criteria = selectedCriteria(task.criteria, task.feature, [task]);
    if ((!criteria.length && !task.maintenanceObjective) || criteria.some((ref) => !isCriterion(ref))) {
      add('invented_scope', task, 'criteria', 'Task is not linked to current criteria');
    }
    if (!slices.some((slice) => slice.tasks.some((ref) => samePlanningRef(ref, task)))) {
      add('invented_scope', task, 'criteria', 'Task is outside the delivery slices');
    }
    const fields = ['expectedBehavior', 'designRefs', 'boundaries', 'reuseTargets', 'inputs', 'outputs',
      'verificationCases', 'returnRequirements', 'decisionsToKeep', 'verificationMethod', 'blockers'] as const;
    for (const field of fields) if (task[field] === undefined) {
      add('detail_gap', task, field, `Task is missing ${field}`);
    }
    // Empty inputs/reuse/decision lists explicitly mean none. Output and acceptance
    // arrays, when supplied, are nonempty by the canonical record schema.
    if (task.draft) add('detail_gap', task, 'draft', 'Task detail is still a draft');
    for (const decisionRef of task.decisionsToKeep ?? []) if (!design.decisions.some((ref) => samePlanningRef(ref, decisionRef))) {
      add('detail_gap', task, 'decisionsToKeep', `Task preserves a decision outside its design: ${decisionRef.id}`);
    }

  }
  if ((slices.length > 1 && !plan.workflow.integrationSteps.length) || !plan.workflow.finalVerification.length) {
    add('missing_integration', plan, 'workflow', 'Multiple slices need integration steps; every plan needs final feature verification');
  }
  for (const scope of understanding.scope) {
    for (const [owner, selectedStage] of [[design, designStage], [plan, planStage]] as const) {
      const actual = owner.workflow?.scope.find((entry) => samePlanningRef(entry.request, scope.request) &&
        entry.term.toLocaleLowerCase('en') === scope.term.toLocaleLowerCase('en'));
      // A passed comparison binds unchanged historical scope to the current
      // requests. A directly applicable scope entry still has to agree.
      const checkedReuse = artifactReuse(selectedStage)?.check.result === 'passed' && samePlanningRef(selectedStage.artifact, owner);
      if (!actual && checkedReuse) continue;
      const expected = scope.role === 'example' ? 'general' : scope.role;
      if (!actual || actual.coverage !== expected) add(scope.role === 'example' ? 'example_driven_narrowing' :
        scope.role === 'entire_scope' ? 'invented_scope' : 'dropped_behavior', owner, 'workflow.scope',
      `${scope.term} has request role ${scope.role}; planned coverage must be ${expected}`);
    }
  }
  for (const ref of design.decisions) {
    const decision = planningRecord(records, ref);
    if (isSettled(decision)) continue;
    if (decision?.kind !== 'decision_change' || !decision.choice) {
      add('detail_gap', design, 'decisions', `Decision ${ref.id} needs a product/technical classification and state`);
    } else if (decision.choice.kind === 'product' && decision.choice.state === 'open') {
      add('unresolved_product_decision', decision, 'choice', decision.questionOrChange);
    }
  }
  const orderedSlices = slices.flatMap((slice) => slice.tasks.map((ref) => ref.id));
  for (const dependency of plan.dependencies) {
    const prerequisite = tasks.find((task) => task.id === dependency.prerequisiteTaskId);
    if (dependency.needs.kind === 'criterion' && prerequisite) {
      const supplied = selectedCriteria(prerequisite.criteria, prerequisite.feature, [prerequisite]);
      const needed = selectedCriteria([dependency.needs.criterion], plan.feature);
      if (!needed.every((need) => supplied.some((ref) => samePlanningRef(ref, need)))) {
        add('dependency_gap', plan, 'dependencies', 'A prerequisite must supply every criterion that the dependency needs');
      }
    }
    if (orderedSlices.indexOf(dependency.prerequisiteTaskId) > orderedSlices.indexOf(dependency.consumerTaskId)) {
      add('dependency_gap', plan, 'workflow.slices', 'Slice order conflicts with the real task dependencies');
    }
  }
  dependencyFindings(plan, tasks.map((task) => task.id), add);
  return findings;
}

function dependencyFindings(plan: ImplementationPlanRevision, taskIds: string[],
  add: (code: ReadinessFinding['code'], record: Ref, path: string, message: string) => void) {
  for (const dependency of plan.dependencies) {
    const before = taskIds.indexOf(dependency.prerequisiteTaskId);
    const after = taskIds.indexOf(dependency.consumerTaskId);
    if (before < 0 || after < 0 || before >= after) add('dependency_gap', plan, 'dependencies',
      'Dependencies must name actual tasks and place prerequisites before consumers');
  }
}
