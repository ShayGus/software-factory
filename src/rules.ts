import { createHash } from 'node:crypto';
import { CommandEnvelopeSchema, type CommandEnvelope } from './commands.js';
import { type Comparison, type Ref } from './primitives.js';
import {
  RecordSchema, RecordsSchema, type Assignment, type FactoryRecord, type FeatureRevision,
  type ProductReview, type Operation,
} from './records.js';

export interface RuleIssue {
  code: string;
  recordId: string;
  path: string;
  message: string;
}
type Kind = FactoryRecord['kind'];
type OfKind<K extends Kind> = Extract<FactoryRecord, { kind: K }>;
const key = (ref: Ref) => JSON.stringify([ref.id, ref.revision]);
const sameRef = (left: Ref, right: Ref) => left.id === right.id && left.revision === right.revision;
const asRef = (record: FactoryRecord): Ref => ({ id: record.id, revision: record.revision });

class Context {
  readonly issues: RuleIssue[] = [];
  readonly index = new Map<string, FactoryRecord>();
  constructor(readonly records: FactoryRecord[]) {
    for (const record of records) {
      if (this.index.has(key(record))) this.add(record, 'duplicate_record', 'id', 'Duplicate ID and revision');
      this.index.set(key(record), record);
    }
  }
  add(record: FactoryRecord, code: string, path: string, message: string) {
    this.issues.push({ code, recordId: record.id, path, message });
  }
  get<K extends Kind>(owner: FactoryRecord, ref: Ref, kind: K, path: string): OfKind<K> | undefined {
    const target = this.index.get(key(ref));
    if (!target) {
      const knownId = this.records.some((record) => record.id === ref.id);
      this.add(owner, kind === 'criterion' && !knownId ? 'unknown_criterion' :
        knownId ? 'revision_mismatch' : 'missing_reference', path,
      `Missing ${kind} ${ref.id} revision ${ref.revision}`);
    } else if (target.kind !== kind) {
      this.add(owner, 'reference_kind', path, `Expected ${kind}, found ${target.kind}`);
    } else if (target.projectId !== owner.projectId) {
      this.add(owner, 'project_mismatch', path, 'Reference crosses project boundaries');
    } else {
      return target as OfKind<K>;
    }
    return undefined;
  }
  equal(owner: FactoryRecord, left: Ref, right: Ref, path: string) {
    if (!sameRef(left, right)) this.add(owner, 'revision_mismatch', path,
      `Expected ${right.id}@${right.revision}; received ${left.id}@${left.revision}`);
  }
  criteria(owner: FactoryRecord, refs: Ref[], feature?: FeatureRevision) {
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.id)) this.add(owner, 'duplicate_criterion', 'criteria', `Repeated criterion ${ref.id}`);
      seen.add(ref.id);
      const criterion = this.get(owner, ref, 'criterion', 'criteria');
      if (feature && criterion) {
        if (criterion.featureId !== feature.id) this.add(owner, 'criterion_feature', 'criteria', 'Wrong feature');
        if (!feature.criteria.some((expected) => sameRef(expected, ref))) {
          this.add(owner, 'revision_mismatch', 'criteria', `Criterion ${ref.id} is outside the named feature revision`);
        }
      }
    }
  }
  comparison(owner: FactoryRecord, comparison: Comparison, feature?: FeatureRevision) {
    for (const finding of comparison.findings) {
      if (finding.criterionId !== undefined && !this.records.some((record) =>
        record.kind === 'criterion' && record.id === finding.criterionId && record.projectId === owner.projectId &&
        (!feature || feature.criteria.some((ref) => ref.id === record.id)))) {
        this.add(owner, 'unknown_criterion', 'findings', `Unknown criterion ${finding.criterionId}`);
      }
      if (finding.resolvedBy) {
        const decision = this.get(owner, finding.resolvedBy, 'decision_change', 'resolvedBy');
        if (decision && decision.disposition !== 'selected') {
          this.add(owner, 'unselected_decision', 'resolvedBy', 'Only a selected decision resolves a finding');
        }
      }
    }
  }
  sources(owner: FactoryRecord, comparison: Comparison, required: Ref[]) {
    for (const ref of required) {
      if (!comparison.sourceRefs.some((source) => source.record && sameRef(source.record, ref))) {
        this.add(owner, 'omitted_source', 'sourceRefs', `Comparison omitted ${ref.id}@${ref.revision}`);
      }
    }
  }
}

function checkScopeTransition(ctx: Context, before: FeatureRevision, after: FeatureRevision) {
  for (const ref of before.criteria) {
    const old = ctx.get(before, ref, 'criterion', 'criteria');
    if (!old || old.requirement !== 'required' || old.disposition.state !== 'active') continue;
    const nextRef = after.criteria.find((criterion) => criterion.id === ref.id);
    const next = nextRef ? ctx.get(after, nextRef, 'criterion', 'criteria') : undefined;
    const action = !nextRef ? 'remove' : next?.requirement === 'optional' ? 'demote' :
      next && next.disposition.state !== 'active' ? 'defer' : undefined;
    if (!action) continue;
    const authorized = after.decisions.some((decisionRef) => {
      const decision = ctx.get(after, decisionRef, 'decision_change', 'decisions');
      return decision?.disposition === 'selected' && decision.scopeChanges.some((change) =>
        change.featureId === after.id && change.fromRevision === before.revision &&
        change.toRevision === after.revision && change.criterionId === old.id && change.action === action);
    });
    if (!authorized) ctx.add(after, 'unapproved_scope_change', 'decisions',
      `${action} of required criterion ${old.id} needs a linked selected decision for this transition`);
  }
}

function checkAssignment(ctx: Context, assignment: Assignment) {
  const feature = ctx.get(assignment, assignment.feature, 'feature_revision', 'feature');
  const design = ctx.get(assignment, assignment.design, 'design_revision', 'design');
  const plan = ctx.get(assignment, assignment.plan, 'implementation_plan_revision', 'plan');
  const task = ctx.get(assignment, assignment.detailedPlanTask, 'detailed_plan_task', 'detailedPlanTask');
  ctx.criteria(assignment, assignment.criteria, feature);
  ctx.comparison(assignment, assignment.instructionFidelity, feature);
  ctx.sources(assignment, assignment.instructionFidelity, [
    ...(feature?.sourceRequests ?? []), assignment.design, assignment.plan, assignment.detailedPlanTask,
  ]);
  if (design) ctx.equal(assignment, design.feature, assignment.feature, 'design.feature');
  if (plan) {
    ctx.equal(assignment, plan.design, assignment.design, 'plan.design');
    ctx.equal(assignment, plan.feature, assignment.feature, 'plan.feature');
  }
  if (task) {
    ctx.equal(assignment, task.plan, assignment.plan, 'task.plan');
    ctx.equal(assignment, task.design, assignment.design, 'task.design');
    ctx.equal(assignment, task.feature, assignment.feature, 'task.feature');
    for (const required of task.criteria) {
      if (!assignment.criteria.some((actual) => sameRef(actual, required))) ctx.add(
        assignment, 'omitted_criterion', 'criteria', `Assignment omitted task criterion ${required.id}`);
    }
    for (const actual of assignment.criteria) {
      if (!task.criteria.some((expected) => sameRef(actual, expected))) ctx.add(
        assignment, 'invented_criterion', 'criteria', `Criterion ${actual.id} is outside the detailed task`);
    }
  }
  const mapping = ctx.records.find((record) => record.kind === 'task_mapping' && !record.legacy &&
    record.projectId === assignment.projectId && record.firstMateTaskId === assignment.firstMateTaskId &&
    record.detailedPlanTask && sameRef(record.detailedPlanTask, assignment.detailedPlanTask) &&
    record.feature && sameRef(record.feature, assignment.feature));
  if (!mapping) ctx.add(assignment, 'missing_mapping', 'firstMateTaskId', 'No matching managed task mapping');
}

function checkReview(ctx: Context, review: ProductReview) {
  const feature = ctx.get(review, review.feature, 'feature_revision', 'feature');
  const design = ctx.get(review, review.design, 'design_revision', 'design');
  const plan = ctx.get(review, review.plan, 'implementation_plan_revision', 'plan');
  if (design) ctx.equal(review, design.feature, review.feature, 'design.feature');
  if (plan) {
    ctx.equal(review, plan.design, review.design, 'plan.design');
    ctx.equal(review, plan.feature, review.feature, 'plan.feature');
  }
  for (const request of review.originalRequests) ctx.get(review, request, 'request', 'originalRequests');
  if (feature) for (const source of feature.sourceRequests) {
    if (!review.originalRequests.some((ref) => sameRef(source, ref))) {
      ctx.add(review, 'omitted_source', 'originalRequests', `Review omitted original request ${source.id}`);
    }
  }
  for (const ref of review.detailedPlanTasks) {
    const task = ctx.get(review, ref, 'detailed_plan_task', 'detailedPlanTasks');
    if (task) { ctx.equal(review, task.plan, review.plan, 'task.plan'); ctx.equal(review, task.design, review.design, 'task.design'); }
  }
  for (const ref of review.assignments) {
    const assignment = ctx.get(review, ref, 'assignment', 'assignments');
    if (assignment) {
      ctx.equal(review, assignment.feature, review.feature, 'assignment.feature');
      ctx.equal(review, assignment.design, review.design, 'assignment.design');
      ctx.equal(review, assignment.plan, review.plan, 'assignment.plan');
      if (!review.detailedPlanTasks.some((task) => sameRef(task, assignment.detailedPlanTask))) {
        ctx.add(review, 'omitted_task', 'detailedPlanTasks', 'Review omitted an assignment detailed task');
      }
    }
  }
  for (const ref of review.results) {
    const result = ctx.get(review, ref, 'criterion_result', 'results');
    if (!result) continue;
    if (!review.assignments.some((assignment) => sameRef(assignment, result.assignment))) {
      ctx.add(review, 'unreviewed_assignment', 'results', 'Result is from an unreviewed assignment');
    }
    ctx.criteria(review, [result.criterion], feature);
    if (result.artifact && !review.reviewedArtifacts.some((artifact) =>
      artifact.uri === result.artifact!.uri && artifact.revision === result.artifact!.revision &&
      artifact.digest === result.artifact!.digest)) {
      ctx.add(review, 'unreviewed_artifact', 'reviewedArtifacts', 'Result artifact identity was not reviewed');
    }
  }
  for (const comparison of [review.sourceComparison, review.instructionFidelity, review.planConformance]) {
    ctx.comparison(review, comparison, feature);
  }
  ctx.sources(review, review.sourceComparison, review.originalRequests);
  // Failed/incomplete reviews are valid records. A passed review makes stronger claims.
  if (review.outcome === 'passed') checkCompletion(ctx, review);
}

function checkCompletion(ctx: Context, review: ProductReview) {
  const feature = ctx.get(review, review.feature, 'feature_revision', 'feature');
  if (!feature) return;
  for (const [path, comparison] of Object.entries({
    sourceComparison: review.sourceComparison, instructionFidelity: review.instructionFidelity,
    planConformance: review.planConformance,
  })) {
    if (comparison.result !== 'passed') ctx.add(review, 'unresolved_review', path, 'Comparison has not passed');
  }
  if (review.unresolvedQuestions.length) ctx.add(review, 'unresolved_review', 'unresolvedQuestions', 'Open product questions');
  if (!review.baselineEvidence.length) ctx.add(review, 'missing_baseline', 'baselineEvidence',
    'Review must compare delivered behavior with the starting baseline');
  if (!review.improvementEvidence.length) ctx.add(review, 'missing_improvement', 'improvementEvidence',
    'Regression success alone cannot demonstrate the requested improvement');
  for (const ref of feature.criteria) {
    const criterion = ctx.get(review, ref, 'criterion', 'criteria');
    if (criterion?.requirement !== 'required' || criterion.disposition.state !== 'active') continue;
    const results = review.results.flatMap((resultRef) => {
      const record = ctx.index.get(key(resultRef));
      return record?.kind === 'criterion_result' && sameRef(record.criterion, ref) ? [record] : [];
    });
    if (!results.length || results.some((result) => result.result !== 'passed')) {
      ctx.add(review, 'incomplete_criterion', 'results', `Required criterion ${criterion.id} lacks current passing evidence`);
    }
  }
}

function checkRecord(ctx: Context, record: FactoryRecord) {
  const project = ctx.records.find((candidate) => candidate.kind === 'project' && candidate.id === record.projectId);
  if (!project) ctx.add(record, 'missing_project', 'projectId', 'Project record is absent');
  switch (record.kind) {
    case 'project':
      if (record.id !== record.projectId) ctx.add(record, 'project_mismatch', 'projectId', 'Project must name itself');
      break;
    case 'request':
      for (const ref of [...record.interpretationRefs, ...record.dispositionRefs]) {
        if (!ctx.index.has(key(ref))) ctx.add(record, 'missing_reference', 'interpretationRefs', `Missing ${ref.id}`);
      }
      break;
    case 'feature_revision': {
      ctx.criteria(record, record.criteria, record);
      for (const ref of record.sourceRequests) ctx.get(record, ref, 'request', 'sourceRequests');
      for (const ref of record.decisions) ctx.get(record, ref, 'decision_change', 'decisions');
      if (record.revision > 1) {
        if (record.previousRevision !== record.revision - 1) ctx.add(record, 'revision_mismatch', 'previousRevision',
          'Feature revision must name its immediate predecessor');
        else {
          const previous = ctx.get(record, { id: record.id, revision: record.previousRevision }, 'feature_revision', 'previousRevision');
          if (previous) checkScopeTransition(ctx, previous, record);
        }
      } else if (record.previousRevision !== undefined) ctx.add(record, 'revision_mismatch', 'previousRevision',
        'First revision has no predecessor');
      if (record.state === 'complete' && !ctx.records.some((candidate) => candidate.kind === 'product_review' &&
        sameRef(candidate.feature, record) && candidate.outcome === 'passed')) {
        ctx.add(record, 'incomplete_feature', 'state', 'Complete feature needs a passing review at this revision');
      }
      break;
    }
    case 'criterion':
      if (!ctx.records.some((candidate) => candidate.kind === 'feature_revision' &&
        candidate.id === record.featureId && candidate.projectId === record.projectId)) {
        ctx.add(record, 'missing_reference', 'featureId', 'Criterion has no feature');
      }
      break;
    case 'design_revision': {
      const feature = ctx.get(record, record.feature, 'feature_revision', 'feature');
      for (const ref of record.decisions) ctx.get(record, ref, 'decision_change', 'decisions');
      ctx.comparison(record, record.sourceComparison, feature);
      ctx.sources(record, record.sourceComparison, feature?.sourceRequests ?? []);
      break;
    }
    case 'implementation_plan_revision': {
      const feature = ctx.get(record, record.feature, 'feature_revision', 'feature');
      const design = ctx.get(record, record.design, 'design_revision', 'design');
      if (design) ctx.equal(record, design.feature, record.feature, 'design.feature');
      const covered = new Set<string>();
      const seen = new Set<string>();
      for (const ref of record.deliverySequence) {
        if (seen.has(ref.id)) ctx.add(record, 'duplicate_task', 'deliverySequence', `Repeated task ${ref.id}`);
        seen.add(ref.id);
        const task = ctx.get(record, ref, 'detailed_plan_task', 'deliverySequence');
        if (task) {
          ctx.equal(record, task.plan, asRef(record), 'task.plan');
          ctx.equal(record, task.design, record.design, 'task.design');
          ctx.equal(record, task.feature, record.feature, 'task.feature');
          for (const criterion of task.criteria) covered.add(key(criterion));
        }
      }
      for (const dependency of record.dependencies) {
        if (!seen.has(dependency.consumerTaskId) || !seen.has(dependency.prerequisiteTaskId)) {
          ctx.add(record, 'missing_dependency', 'dependencies', 'Dependency does not name two tasks in this plan');
        } else if (record.deliverySequence.findIndex((ref) => ref.id === dependency.prerequisiteTaskId) >=
          record.deliverySequence.findIndex((ref) => ref.id === dependency.consumerTaskId)) {
          ctx.add(record, 'dependency_order', 'dependencies', 'Prerequisite must precede consumer; cycles are invalid');
        }
        if (dependency.needs.kind === 'criterion') ctx.criteria(record, [dependency.needs.criterion], feature);
      }
      ctx.comparison(record, record.readiness.comparison, feature);
      ctx.sources(record, record.readiness.comparison, [...(feature?.sourceRequests ?? []), record.design]);
      if (record.readiness.ready) {
        if (record.readiness.comparison.result !== 'passed') ctx.add(record, 'plan_not_ready', 'readiness', 'Source comparison did not pass');
        if (feature) for (const ref of feature.criteria) {
          const criterion = ctx.get(record, ref, 'criterion', 'criteria');
          if (criterion?.requirement === 'required' && criterion.disposition.state === 'active' && !covered.has(key(ref))) {
            ctx.add(record, 'omitted_criterion', 'deliverySequence', `Plan omitted required criterion ${ref.id}`);
          }
        }
      }
      break;
    }
    case 'detailed_plan_task': {
      const feature = ctx.get(record, record.feature, 'feature_revision', 'feature');
      const plan = ctx.get(record, record.plan, 'implementation_plan_revision', 'plan');
      const design = ctx.get(record, record.design, 'design_revision', 'design');
      ctx.criteria(record, record.criteria, feature);
      if (plan) {
        ctx.equal(record, record.feature, plan.feature, 'feature');
        ctx.equal(record, record.design, plan.design, 'design');
      }
      if (design) ctx.equal(record, record.feature, design.feature, 'design.feature');
      if (plan && !plan.deliverySequence.some((ref) => sameRef(ref, record))) {
        ctx.add(record, 'unplanned_task', 'plan', 'Task is absent from its plan delivery sequence');
      }
      break;
    }
    case 'task_mapping': {
      const feature = record.feature ? ctx.get(record, record.feature, 'feature_revision', 'feature') : undefined;
      ctx.criteria(record, record.criteria, feature);
      if (record.detailedPlanTask) {
        const task = ctx.get(record, record.detailedPlanTask, 'detailed_plan_task', 'detailedPlanTask');
        if (task && record.feature) ctx.equal(record, task.feature, record.feature, 'task.feature');
      }
      break;
    }
    case 'assignment': checkAssignment(ctx, record); break;
    case 'criterion_result': {
      const assignment = ctx.get(record, record.assignment, 'assignment', 'assignment');
      ctx.get(record, record.criterion, 'criterion', 'criterion');
      if (assignment && !assignment.criteria.some((ref) => sameRef(ref, record.criterion))) {
        ctx.add(record, 'unassigned_criterion', 'criterion', 'Result names a criterion/revision outside the assignment');
      }
      break;
    }
    case 'product_review': checkReview(ctx, record); break;
    case 'measurement_claim':
      if (record.correctionOf) ctx.get(record, record.correctionOf, 'measurement_claim', 'correctionOf');
      break;
    case 'decision_change':
      if (record.requestMapping) {
        const mapping = record.requestMapping;
        const request = ctx.get(record, mapping.request, 'request', 'requestMapping.request');
        const feature = mapping.feature ? ctx.get(record, mapping.feature, 'feature_revision', 'requestMapping.feature') : undefined;
        ctx.criteria(record, mapping.criteria, feature);
        if (request && (mapping.end > request.originalText.length || !record.sourceRefs.some((source) =>
          source.record && sameRef(source.record, mapping.request) &&
          source.excerpt === request.originalText.slice(mapping.start, mapping.end)))) {
          ctx.add(record, 'invalid_request_range', 'requestMapping', 'Range must name an exact excerpt of the original request');
        }
        if (feature && !feature.sourceRequests.some((source) => sameRef(source, mapping.request))) {
          ctx.add(record, 'omitted_source', 'requestMapping.feature', 'Feature must name the mapped source request');
        }
        for (const ref of [mapping.request, ...(mapping.feature ? [mapping.feature] : []), ...mapping.criteria]) {
          if (!record.affectedRecords.some((affected) => sameRef(ref, affected))) {
            ctx.add(record, 'omitted_source', 'affectedRecords', 'Mapping target must be an affected record');
          }
        }
        for (const ref of mapping.replaces) {
          const prior = ctx.get(record, ref, 'decision_change', 'requestMapping.replaces');
          if (prior && (!prior.requestMapping || !sameRef(prior.requestMapping.request, mapping.request))) {
            ctx.add(record, 'invalid_mapping_replacement', 'requestMapping.replaces', 'Replacement must map the same request');
          }
        }
      }
      for (const ref of record.affectedRecords) {
        const target = ctx.index.get(key(ref));
        if (!target || target.projectId !== record.projectId) ctx.add(record, 'missing_reference', 'affectedRecords', `Missing affected ${ref.id}`);
      }
      for (const change of record.scopeChanges) {
        if (!ctx.records.some((candidate) => candidate.kind === 'criterion' && candidate.id === change.criterionId &&
          candidate.projectId === record.projectId)) ctx.add(record, 'unknown_criterion', 'scopeChanges', `Unknown criterion ${change.criterionId}`);
      }
      break;
    case 'observation':
      if (record.correction) {
        ctx.get(record, record.correction.assignment, 'assignment', 'correction.assignment');
        if (!ctx.index.has(key(record.correction.affectedRevision))) ctx.add(record, 'missing_reference', 'correction.affectedRevision', 'Missing corrected revision');
        for (const ref of record.correction.supersedes) ctx.get(record, ref, 'observation', 'correction.supersedes');
      }
      break;
    case 'guidance_revision':
      for (const ref of record.supportingObservations) ctx.get(record, ref, 'observation', 'supportingObservations');
      for (const ref of record.supersededGuidance) ctx.get(record, ref, 'guidance_revision', 'supersededGuidance');
      break;
    case 'operation':
      if (record.reconciliation && record.reconciliation.observedState !== record.state) {
        ctx.add(record, 'operation_state_mismatch', 'reconciliation', 'Reconciled state contradicts operation state');
      }
      break;
  }
  if ('disposition' in record && typeof record.disposition === 'object' && record.disposition.state !== 'active') {
    const decision = ctx.get(record, record.disposition.decision, 'decision_change', 'disposition.decision');
    if (decision?.disposition !== 'selected') ctx.add(record, 'unselected_decision', 'disposition', 'Disposition requires selected decision');
  }
}

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; issues: RuleIssue[] };

/** Validate a closed, project-scoped reference context, including referenced history. */
export function validateRecords(input: unknown): ValidationResult<FactoryRecord[]> {
  const parsed = RecordsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => ({
    code: 'schema', recordId: String(issue.path[0] ?? ''), path: issue.path.join('.'), message: issue.message,
  })) };
  const ctx = new Context(parsed.data);
  for (const record of parsed.data) {
    checkRecord(ctx, record);
    // All nested exact reference objects, including context and evidence source pointers,
    // resolve in the supplied context. Artifact revisions are strings, not record refs.
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}.${index}`)); return; }
      if (value === null || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (Object.keys(object).length === 2 && typeof object.id === 'string' && typeof object.revision === 'number') {
        const target = ctx.index.get(key({ id: object.id, revision: object.revision }));
        if (!target) ctx.add(record, 'missing_reference', path, `Missing ${object.id}@${object.revision}`);
        else if (target.projectId !== record.projectId) ctx.add(record, 'project_mismatch', path, 'Reference crosses projects');
      }
      for (const [name, item] of Object.entries(object)) visit(item, `${path}.${name}`);
    };
    visit(record, 'record');
  }
  const histories = new Map<string, FactoryRecord[]>();
  for (const record of parsed.data) {
    const history = histories.get(record.id) ?? [];
    history.push(record);
    histories.set(record.id, history);
  }
  for (const history of histories.values()) {
    history.sort((a, b) => a.revision - b.revision);
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1]!;
      const current = history[index]!;
      if (current.kind !== previous.kind || current.projectId !== previous.projectId) ctx.add(current,
        'identity_change', 'id', 'Stable ID changed record kind or project');
      if (current.createdAt !== previous.createdAt || Date.parse(current.updatedAt) < Date.parse(previous.updatedAt)) {
        ctx.add(current, 'history_change', 'createdAt', 'History must retain creation time and ordered update times');
      }
      if (current.kind === 'request' && previous.kind === 'request' &&
        canonical([current.originalText, current.source, current.channel, current.capturedAt, current.clientRequestId, current.attachments]) !==
        canonical([previous.originalText, previous.source, previous.channel, previous.capturedAt, previous.clientRequestId, previous.attachments])) {
        ctx.add(current, 'source_mutation', 'originalText', 'Original request capture is immutable; add a correction');
      }
    }
  }
  return ctx.issues.length ? { ok: false, issues: ctx.issues } : { ok: true, data: parsed.data };
}

/** Dispatch eligibility is distinct from storing a failed fidelity finding. */
export function validateAssignmentForDispatch(input: unknown, assignmentRef: Ref): ValidationResult<Assignment> {
  const validated = validateRecords(input);
  if (!validated.ok) return validated;
  const ctx = new Context(validated.data);
  const owner = validated.data.find((record) => record.kind === 'assignment' && sameRef(record, assignmentRef));
  if (!owner || owner.kind !== 'assignment') return { ok: false, issues: [{ code: 'missing_assignment', recordId: assignmentRef.id,
    path: 'assignment', message: 'Assignment revision is absent' }] };
  if (owner.instructionFidelity.result !== 'passed') ctx.add(owner, 'instruction_fidelity', 'instructionFidelity',
    'Instruction comparison with original request, design and task has not passed');
  const plan = ctx.get(owner, owner.plan, 'implementation_plan_revision', 'plan');
  const feature = ctx.get(owner, owner.feature, 'feature_revision', 'feature');
  const design = ctx.get(owner, owner.design, 'design_revision', 'design');
  if (!plan?.readiness.ready || design?.sourceComparison.result !== 'passed') ctx.add(owner, 'plan_not_ready', 'plan', 'Design/plan not ready');
  if (feature?.disposition.state !== 'active') ctx.add(owner, 'inactive_feature', 'feature', 'Feature is deferred or cancelled');
  return ctx.issues.length ? { ok: false, issues: ctx.issues } : { ok: true, data: owner };
}

export function validateReviewForCompletion(input: unknown, reviewRef: Ref): ValidationResult<ProductReview> {
  const validated = validateRecords(input);
  if (!validated.ok) return validated;
  const ctx = new Context(validated.data);
  const owner = validated.data.find((record) => record.kind === 'product_review' && sameRef(record, reviewRef));
  if (!owner || owner.kind !== 'product_review') return { ok: false, issues: [{ code: 'missing_review', recordId: reviewRef.id,
    path: 'review', message: 'Review revision is absent' }] };
  checkCompletion(ctx, owner);
  if (owner.outcome !== 'passed') ctx.add(owner, 'review_failed', 'outcome', 'Review did not pass');
  return ctx.issues.length ? { ok: false, issues: ctx.issues } : { ok: true, data: owner };
}

export function assertExpectedRevision(expectedRevision: number, actualRevision: number | null): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
    (actualRevision !== null && (!Number.isSafeInteger(actualRevision) || actualRevision < 1)) ||
    expectedRevision !== (actualRevision ?? 0)) throw new Error('revision_conflict');
}

/** Validate a proposed write independently of storage/CAS (BUILD-03 owns atomicity). */
export function assertRevisionTransition(previousInput: unknown, nextInput: unknown): void {
  const previous = RecordSchema.parse(previousInput);
  const next = RecordSchema.parse(nextInput);
  if (previous.id !== next.id || previous.projectId !== next.projectId || previous.kind !== next.kind ||
    next.revision !== previous.revision + 1 || next.createdAt !== previous.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw new Error('invalid_revision_transition');
  if (previous.kind === 'request' && next.kind === 'request' && canonical([
    previous.originalText, previous.source, previous.channel, previous.capturedAt, previous.clientRequestId, previous.attachments,
  ]) !== canonical([next.originalText, next.source, next.channel, next.capturedAt, next.clientRequestId, next.attachments])) {
    throw new Error('source_mutation');
  }
}

/** Key order is irrelevant; array order and exact source text remain meaningful. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value)!;
}
export function commandDigest(input: unknown): string {
  const command = CommandEnvelopeSchema.parse(input);
  const { id: _id, issuedAt: _issuedAt, idempotencyKey: _key, ...meaning } = command;
  return `sha256:${createHash('sha256').update(canonical(meaning)).digest('hex')}`;
}
export function assertIdempotencyReuse(previous: Operation, next: CommandEnvelope): void {
  if (previous.projectId !== next.projectId || previous.idempotencyKey !== next.idempotencyKey ||
    previous.command !== next.command || previous.payloadDigest !== commandDigest(next)) {
    throw new Error('idempotency_conflict');
  }
}
