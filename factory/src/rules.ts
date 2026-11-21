import { unansweredOwnerQuestions } from './owner-questions.js';
import { correctionTargetsAttempt, outstandingTaskCorrections, unresolvedTaskCorrections, correctionOrder, type TrackedCorrection } from './correction-state.js';
import { activeGuidance, learningKey } from './learning-context.js';
import { reusableAnswer } from './decision-context.js';
import { planReadinessFindings, sliceCriterionProvenance, stageCriteria, stageDependencies, stageSliceCriteria } from './planning-checks.js';
import { createHash } from 'node:crypto';
import { expectedReviewCriteria, technicalReviewSatisfied } from './review-contracts.js';
import { pullRequestIdentity, samePullRequest } from './repository-identity.js';
import { parseRoborevResult } from './quality-results.js';
import { digestText, missingAssignmentContext, sameSource } from './instruction-context.js';
import { assertTaskDependencyAcyclic, taskReadinessReasons } from './task-readiness.js';
import { CommandEnvelopeSchema, type CommandEnvelope } from './commands.js';
import { type Comparison, type Ref } from './primitives.js';
import {
  artifactReuse, RecordSchema, RecordsSchema, type Assignment, type FactoryRecord, type FeatureRevision, type StageRevision,
  type ProductReview, type Operation, type DetailedPlanTask, type ImplementationPlanRevision,
  DetailedPlanTaskSchema,
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
const sameRef = (left: Ref | null, right: Ref | null) => left === null || right === null ?
  left === right : left.id === right.id && left.revision === right.revision;
const asRef = (record: FactoryRecord): Ref => ({ id: record.id, revision: record.revision });

class Context {
  readonly issues: RuleIssue[] = [];
  readonly index = new Map<string, FactoryRecord>();
  readonly current = new Map<string, FactoryRecord>();
  constructor(readonly records: FactoryRecord[]) {
    for (const record of records) {
      if (this.index.has(key(record))) this.add(record, 'duplicate_record', 'id', 'Duplicate ID and revision');
      this.index.set(key(record), record);
      if (record.revision > (this.current.get(record.id)?.revision ?? 0)) this.current.set(record.id, record);
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
  equal(owner: FactoryRecord, left: Ref | null, right: Ref | null, path: string) {
    if (!sameRef(left, right)) this.add(owner, 'revision_mismatch', path,
      `Expected ${right ? `${right.id}@${right.revision}` : 'no feature'}; received ${left ? `${left.id}@${left.revision}` : 'no feature'}`);
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

function featureContent(feature: FeatureRevision) {
  const { revision: _revision, previousRevision: _previous, updatedAt: _updatedAt, changeReason: _reason,
    state: _state, methodStage: _stage, completionEvidence: _evidence, ...content } = feature;
  return content;
}

/** Dispatch permits priority and workflow-state edits without changing scope.
 * Shared with observational UIs; product-evidence continuity remains stricter. */
export function hasDispatchCompatibleFeatureScope(records: FactoryRecord[], from: Ref, to: Ref): boolean {
  const assigned = records.find((record) => record.kind === 'feature_revision' && sameRef(record, from));
  const current = records.find((record) => record.kind === 'feature_revision' && sameRef(record, to));
  if (assigned?.kind !== 'feature_revision' || current?.kind !== 'feature_revision' || assigned.id !== current.id ||
    current.disposition.state !== 'active') return false;
  const { priority: _assignedPriority, ...assignedScope } = featureContent(assigned);
  const { priority: _currentPriority, ...currentScope } = featureContent(current);
  return canonical(assignedScope) === canonical(currentScope);
}

/** A workflow-state revision preserves product evidence only if every intervening
 * revision has the same content and remains active. A changed-and-reverted scope
 * is not silently treated as uninterrupted evidence. */
export function hasUnchangedFeatureScope(records: FactoryRecord[], from: Ref, to: Ref): boolean {
  if (from.id !== to.id || from.revision > to.revision) return false;
  const original = records.find((record) => record.kind === 'feature_revision' && sameRef(record, from));
  if (original?.kind !== 'feature_revision' || original.disposition.state !== 'active') return false;
  const content = canonical(featureContent(original));
  for (let revision = from.revision; revision <= to.revision; revision++) {
    const feature = records.find((record) => record.kind === 'feature_revision' && record.id === to.id && record.revision === revision);
    if (feature?.kind !== 'feature_revision' || feature.disposition.state !== 'active' || canonical(featureContent(feature)) !== content) return false;
  }
  return true;
}

function carriesCompletionEvidence(ctx: Context, feature: FeatureRevision) {
  const evidence = feature.completionEvidence;
  if (!evidence) return false;
  const review = ctx.get(feature, evidence.review, 'product_review', 'completionEvidence.review');
  if (review?.outcome !== 'passed' || !review.feature || review.feature.id !== feature.id || review.feature.revision >= feature.revision) return false;
  const content = canonical(featureContent(feature));
  for (let revision = feature.revision - 1; revision >= review.feature.revision; revision--) {
    const predecessor = ctx.index.get(key({ id: feature.id, revision }));
    if (predecessor?.kind !== 'feature_revision' || canonical(featureContent(predecessor)) !== content) return false;
  }
  return true;
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

function currentPlanCriteria(ctx: Context, plan: ImplementationPlanRevision, task: DetailedPlanTask): Ref[] {
  const check = plan.workflow?.readinessCheck && ctx.index.get(key(plan.workflow.readinessCheck));
  const detail = check?.kind === 'plan_readiness_revision' && check.ready && ctx.index.get(key(check.detailStage));
  return detail && detail.kind === 'stage_revision' ? stageCriteria(ctx.records, detail, task.criteria, task.feature, [task]) : task.criteria;
}

function retainedTask(ctx: Context, plan: ImplementationPlanRevision, task: DetailedPlanTask): boolean {
  if (!plan.deliverySequence.some((ref) => sameRef(ref, task))) return false;
  let current = plan;
  while (!sameRef(current, task.plan)) {
    if (!current.workflow?.retainedTasks.some((entry) => sameRef(entry.task, task))) return false;
    const previous = ctx.index.get(key({ id: current.id, revision: current.revision - 1 }));
    if (previous?.kind !== 'implementation_plan_revision' || previous.projectId !== plan.projectId ||
      !previous.deliverySequence.some((ref) => sameRef(ref, task))) return false;
    current = previous;
  }
  // Retention cannot attach a task from another feature/design silently. New
  // criterion revisions must be covered by the ready plan's recorded reuse check.
  if (plan.feature === null || task.feature === null) return plan.feature === task.feature &&
    current.feature === null && sameRef(current.design, task.design) && task.design.id === plan.design.id;
  const criteria = currentPlanCriteria(ctx, plan, task);
  const feature = ctx.index.get(key(plan.feature));
  return sameRef(current.feature, task.feature) && sameRef(current.design, task.design) &&
    task.design.id === plan.design.id && feature?.kind === 'feature_revision' &&
    (task.feature.id === plan.feature.id || (task.criteria.length > 0 && criteria.every((ref) =>
      !task.criteria.some((original) => sameRef(ref, original))))) &&
    criteria.every((ref) => feature.criteria.some((expected) => sameRef(ref, expected)));
}

/** A review can combine deliveries only through the existing unchanged-task retention rule. */
export function assignmentMatchesReviewPlan(records: FactoryRecord[], assignment: Assignment, planRef: Ref): boolean {
  if (sameRef(assignment.plan, planRef)) return true;
  if (assignment.plan.id !== planRef.id || assignment.plan.revision > planRef.revision) return false;
  const ctx = new Context(records);
  const plan = ctx.index.get(key(planRef)); const task = ctx.index.get(key(assignment.detailedPlanTask));
  return plan?.kind === 'implementation_plan_revision' && plan.readiness.ready &&
    plan.readiness.comparison.result === 'passed' && task?.kind === 'detailed_plan_task' && retainedTask(ctx, plan, task);
}

function checkTaskPlan(ctx: Context, owner: FactoryRecord, task: DetailedPlanTask, plan: ImplementationPlanRevision) {
  if (!retainedTask(ctx, plan, task)) {
    ctx.equal(owner, task.plan, plan, 'task.plan');
    ctx.equal(owner, task.design, plan.design, 'task.design');
    ctx.equal(owner, task.feature, plan.feature, 'task.feature');
  }
}

function matchesAssignment(mapping: OfKind<'task_mapping'>, assignment: Assignment) {
  return !mapping.legacy && mapping.projectId === assignment.projectId &&
    mapping.firstMateTaskId === assignment.firstMateTaskId && sameRef(mapping.detailedPlanTask, assignment.detailedPlanTask) &&
    sameRef(mapping.feature, assignment.feature);
}

function designRequests(ctx: Context, design: OfKind<'design_revision'> | undefined): Ref[] {
  return design?.sourceRefs.flatMap((source) => source.record && ctx.index.get(key(source.record))?.kind === 'request' ?
    [source.record] : []) ?? [];
}

function checkAssignment(ctx: Context, assignment: Assignment) {
  const feature = assignment.feature ? ctx.get(assignment, assignment.feature, 'feature_revision', 'feature') : undefined;
  const design = ctx.get(assignment, assignment.design, 'design_revision', 'design');
  const plan = ctx.get(assignment, assignment.plan, 'implementation_plan_revision', 'plan');
  const task = ctx.get(assignment, assignment.detailedPlanTask, 'detailed_plan_task', 'detailedPlanTask');
  ctx.criteria(assignment, assignment.criteria, feature);
  ctx.comparison(assignment, assignment.instructionFidelity, feature);
  ctx.sources(assignment, assignment.instructionFidelity, [
    ...(feature?.sourceRequests ?? designRequests(ctx, design)), assignment.design, assignment.plan, assignment.detailedPlanTask,
  ]);
  if (design && !hasCheckedDesignReuse(ctx.records, design, assignment.feature)) ctx.equal(assignment, design.feature, assignment.feature, 'design.feature');
  if (plan) {
    ctx.equal(assignment, plan.design, assignment.design, 'plan.design');
    ctx.equal(assignment, plan.feature, assignment.feature, 'plan.feature');
  }
  if (task) {
    if (plan) checkTaskPlan(ctx, assignment, task, plan);
    else ctx.equal(assignment, task.plan, assignment.plan, 'task.plan');
    const criteria = plan && retainedTask(ctx, plan, task) ? currentPlanCriteria(ctx, plan, task) : task.criteria;
    for (const required of criteria) {
      if (!assignment.criteria.some((actual) => sameRef(actual, required))) ctx.add(
        assignment, 'omitted_criterion', 'criteria', `Assignment omitted task criterion ${required.id}`);
    }
    for (const actual of assignment.criteria) {
      if (!criteria.some((expected) => sameRef(actual, expected))) ctx.add(
        assignment, 'invented_criterion', 'criteria', `Criterion ${actual.id} is outside the detailed task`);
    }
  }
  const mapping = ctx.records.find((record) => record.kind === 'task_mapping' && matchesAssignment(record, assignment));
  if (!mapping) ctx.add(assignment, 'missing_mapping', 'firstMateTaskId', 'No matching managed task mapping');
}

function checkTicketReview(ctx: Context, review: ProductReview) {
  const proof = review.ticketReview!;
  const publication = ctx.get(review, proof.publication, 'ticket_publication', 'ticketReview.publication');
  const aggregate = publication && ctx.index.get(key(publication.aggregateReview));
  const reject = (message: string) => ctx.add(review, 'invalid_ticket_review', 'ticketReview', message);
  if (!publication || publication.repository !== proof.repository || publication.ticketId !== proof.ticketId ||
    !samePullRequest(publication.prUrl, proof.prUrl) || (proof.currentTicket && proof.currentTicket.id !== proof.ticketId)) {
    reject('Proof must match its published ticket, repository and pull request');
  }
  if (aggregate?.kind !== 'product_review' || canonical(reviewAuthority(review)) !== canonical(reviewAuthority(aggregate)) ||
    review.results.length || review.conformance || review.reviewedArtifacts.length !== 1 ||
    review.reviewedArtifacts[0]?.revision !== proof.head ||
    review.reviewedArtifacts[0]?.uri !== `https://${proof.repository}` ||
    review.reviewedArtifacts[0]?.digest !== proof.changes?.digest) {
    reject('Ticket review must preserve aggregate authority and identify its own evidence');
  }
  if (proof.priorReview) {
    const prior = ctx.get(review, proof.priorReview, 'product_review', 'ticketReview.priorReview');
    const priorProof = prior?.ticketReview;
    const bound = priorProof ? sameRef(priorProof.publication, proof.publication) && priorProof.head === proof.from :
      publication?.initialBaseline && sameRef(publication.aggregateReview, proof.priorReview) && publication.reviewedCommit === proof.from;
    if (!bound || prior?.outcome !== 'passed' || proof.from === proof.head ||
      canonical(reviewAuthority(prior)) !== canonical(reviewAuthority(review)) ||
      canonical(priorProof?.currentTicket ?? prior?.conformance?.currentTicket) !== canonical(proof.currentTicket)) {
      reject('Prior review must be a passing baseline on this pull request under the same authority');
    }
    const visited = new Set([key(review)]);
    let node = prior;
    while (node) {
      if (visited.has(key(node))) { reject('Cyclic ticket review history'); break; }
      visited.add(key(node));
      const parent = node.ticketReview?.priorReview;
      const record = parent && ctx.index.get(key(parent));
      node = record?.kind === 'product_review' ? record : undefined;
    }
  }
  if (proof.changes && proof.changes.digest !== digestText(proof.changes.patch)) reject('Patch does not match its frozen digest');
  if (proof.verdict) for (const finding of proof.verdict.findings) for (const quote of finding.quotes) {
    const sources = quote.source === 'patch' ? [proof.changes?.patch] : [
      proof.currentTicket?.text, ...review.originalRequests.map((reference) => {
        const request = ctx.index.get(key(reference));
        return request?.kind === 'request' ? request.originalText : undefined;
      }),
    ];
    if (!sources.some((text) => text?.includes(quote.text))) reject('Reviewer quoted evidence outside the snapshot');
  }
  if (proof.quality) {
    try {
      const observed = parseRoborevResult(proof.quality.raw, proof.head, proof.quality.observedAt);
      if (canonical(observed) !== canonical(proof.quality)) reject('Quality evidence differs from the exact-head technical result');
    } catch { reject('Quality evidence must be a recorded result for the exact head'); }
  }
}

function reviewAuthority(review: ProductReview | undefined) {
  return review && [review.feature, review.design, review.plan, review.originalRequests, review.assignments, review.detailedPlanTasks];
}

function checkReview(ctx: Context, review: ProductReview) {
  const feature = review.feature ? ctx.get(review, review.feature, 'feature_revision', 'feature') : undefined;
  const design = ctx.get(review, review.design, 'design_revision', 'design');
  const plan = ctx.get(review, review.plan, 'implementation_plan_revision', 'plan');
  if (design && !hasCheckedDesignReuse(ctx.records, design, review.feature)) ctx.equal(review, design.feature, review.feature, 'design.feature');
  if (plan) {
    ctx.equal(review, plan.design, review.design, 'plan.design');
    ctx.equal(review, plan.feature, review.feature, 'plan.feature');
  }
  for (const request of review.originalRequests) ctx.get(review, request, 'request', 'originalRequests');
  for (const source of feature?.sourceRequests ?? designRequests(ctx, design)) {
    if (!review.originalRequests.some((ref) => sameRef(source, ref))) {
      ctx.add(review, 'omitted_source', 'originalRequests', `Review omitted original request ${source.id}`);
    }
  }
  for (const ref of review.detailedPlanTasks) {
    const task = ctx.get(review, ref, 'detailed_plan_task', 'detailedPlanTasks');
    if (task && plan) checkTaskPlan(ctx, review, task, plan);
  }
  for (const ref of review.assignments) {
    const assignment = ctx.get(review, ref, 'assignment', 'assignments');
    if (assignment) {
      ctx.equal(review, assignment.feature, review.feature, 'assignment.feature');
      ctx.equal(review, assignment.design, review.design, 'assignment.design');
      if (!assignmentMatchesReviewPlan(ctx.records, assignment, review.plan)) {
        ctx.equal(review, assignment.plan, review.plan, 'assignment.plan');
      }
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
    if (result.criterion) ctx.criteria(review, [result.criterion], feature);
    if (result.artifact && !review.reviewedArtifacts.some((artifact) =>
      artifact.uri === result.artifact!.uri && artifact.revision === result.artifact!.revision &&
      artifact.digest === result.artifact!.digest)) {
      ctx.add(review, 'unreviewed_artifact', 'reviewedArtifacts', 'Result artifact identity was not reviewed');
    }
  }
  for (const comparison of [review.sourceComparison, review.instructionFidelity, review.planConformance]) {
    ctx.comparison(review, comparison, feature);
    if (comparison.result === 'passed') ctx.sources(review, comparison, [review.design, review.plan, ...review.detailedPlanTasks,
      ...(review.feature === null ? review.originalRequests : [])]);
  }
  ctx.sources(review, review.sourceComparison, review.originalRequests);
  if (review.ticketReview) checkTicketReview(ctx, review);
  // Failed/incomplete reviews are valid records. A passed review makes stronger claims.
  if (review.outcome === 'passed') checkCompletion(ctx, review);
}

function checkCompletion(ctx: Context, review: ProductReview, scope: 'feature' | 'task' = 'feature') {
  if (review.ticketReview) {
    const { changes, verdict, quality } = review.ticketReview;
    if (scope !== 'feature' || !changes || verdict?.verdict !== 'passed' || quality?.verdict !== 'passed' ||
      review.unresolvedQuestions.length || [review.sourceComparison, review.instructionFidelity, review.planConformance]
        .some((check) => check.result !== 'passed')) {
      ctx.add(review, 'unresolved_ticket_review', 'ticketReview', 'Completion requires a product pass and separate exact-head technical pass');
    }
    return;
  }
  const outsideTicket = (criterion: Ref | null) => {
    const proof = review.conformance;
    const ticket = proof?.currentTicket;
    return !!criterion && !!ticket && proof?.verdict?.criteria.some((outcome) =>
      outcome.state === 'out_of_scope' && sameRef(criterion, outcome.criterion) &&
      outcome.quotes.some((quote) => quote.source === 'original_request' && ticket.text.includes(quote.text)));
  };
  if (review.conformance) {
    const proof = review.conformance;
    if (!proof.verdict || proof.error || proof.qualityError ||
      !proof.technicalReviews.length || proof.technicalReviews.some((result) => !technicalReviewSatisfied(result)) ||
      proof.verdict.criteria.some((criterion) => criterion.state !== 'accomplished' && !outsideTicket(criterion.criterion)) ||
      [proof.verdict.sourceComparison, proof.verdict.instructionFidelity, proof.verdict.planConformance].some((result) => result !== 'passed')) {
      ctx.add(review, 'unresolved_conformance', 'conformance', 'A fresh product review with accomplished behavior and passing existing quality evidence is required');
    }
    if (proof.sessionId !== review.reviewerSession) ctx.add(review, 'review_session_mismatch', 'conformance.sessionId', 'Product reviewer session must match');
    if (proof.reusedProductReview) {
      const original = ctx.get(review, proof.reusedProductReview, 'product_review', 'conformance.reusedProductReview');
      if (!original?.conformance || original.id !== review.id || original.revision >= review.revision ||
        original.reviewerSession !== review.reviewerSession ||
        !sameRef(original.plan, review.plan) || !sameRef(original.design, review.design) ||
        canonical(original.assignments) !== canonical(review.assignments) ||
        canonical(original.conformance.currentTicket ?? null) !== canonical(proof.currentTicket ?? null) ||
        canonical(original.conformance.verdict) !== canonical(proof.verdict)) {
        ctx.add(review, 'reused_review_mismatch', 'conformance.reusedProductReview', 'Reused product judgment must retain its exact earlier scope and verdict');
      }
    }
    if (proof.previousRound) {
      const previous = ctx.get(review, proof.previousRound, 'product_review', 'conformance.previousRound');
      if (!previous?.conformance || previous.id !== review.id || previous.revision !== review.revision - 1 ||
        canonical(previous.assignments) !== canonical(review.assignments) ||
        canonical(previous.conformance.currentTicket ?? null) !== canonical(proof.currentTicket ?? null)) {
        ctx.add(review, 'previous_round_mismatch', 'conformance.previousRound', 'Follow-up review must keep the prior assignment and ticket scope');
      }
    }
    for (const assignmentRef of review.assignments) {
      const assignment = ctx.index.get(key(assignmentRef));
      if (assignment?.kind !== 'assignment') continue;
      for (const criterion of assignment.criteria.length ? assignment.criteria : [null]) {
        if (outsideTicket(criterion)) continue;
        if (!review.results.some((resultRef) => {
          const result = ctx.index.get(key(resultRef));
          return result?.kind === 'criterion_result' && sameRef(result.assignment, assignmentRef) && sameRef(result.criterion, criterion);
        })) ctx.add(review, 'missing_worker_return', 'results', 'Every assigned criterion, including optional criteria, needs a worker return');
      }
    }
    const expectedCriteria = expectedReviewCriteria(review.assignments.flatMap((ref) => {
      const assignment = ctx.index.get(key(ref));
      return assignment?.kind === 'assignment' ? [assignment.criteria] : [];
    }));
    if (proof.verdict?.criteria.length !== expectedCriteria.length || expectedCriteria.some((criterion) =>
      proof.verdict?.criteria.filter((outcome) => sameRef(outcome.criterion, criterion)).length !== 1)) {
      ctx.add(review, 'incomplete_conformance', 'conformance.verdict.criteria', 'Every distinct assigned criterion and any maintenance need exactly one reviewer outcome');
    }
    for (const artifact of review.reviewedArtifacts) if (!proof.technicalReviews.some((result) => result.commit === artifact.revision)) {
      ctx.add(review, 'missing_quality_evidence', 'conformance.technicalReviews', 'Every delivered commit needs quality evidence');
    }
    if (proof.deliveries) for (const assignment of review.assignments) {
      if (proof.deliveries.filter((delivery) => sameRef(delivery.assignment, assignment)).length !== 1) {
        ctx.add(review, 'missing_delivery_provenance', 'conformance.deliveries', 'Every reviewed assignment needs exactly one delivery provenance entry');
      }
    }
    const roundQuality = proof.technicalReviews.some((result) => result.reviewer !== undefined);
    if (roundQuality && !proof.deliveries?.length) {
      ctx.add(review, 'missing_delivery_provenance', 'conformance.deliveries', 'Review round evidence requires exact delivery provenance');
    }
    for (const delivery of proof.deliveries ?? []) {
      const quality = delivery.technicalReviewIndexes?.map((index) => proof.technicalReviews[index]);
      if (roundQuality && !(['code', 'scope'] as const).every((reviewer) =>
        quality?.some((result) => result?.reviewer === reviewer && result.commit === delivery.artifact.revision))) {
        ctx.add(review, 'missing_quality_evidence', 'conformance.technicalReviews', 'Code and scope review must both cover the delivered commit');
      }
      const assignment = ctx.index.get(key(delivery.assignment));
      if (assignment?.kind !== 'assignment' || !sameRef(assignment.detailedPlanTask, delivery.detailedPlanTask) ||
        delivery.fileArtifacts.some((artifact) => artifact.revision !== delivery.artifact.revision ||
          !artifact.uri.startsWith(`${delivery.artifact.uri}#`) || !proof.deliveredFiles.some((file) =>
            file.artifact.uri === artifact.uri && file.artifact.revision === artifact.revision && file.artifact.digest === artifact.digest))) {
        ctx.add(review, 'delivery_context_mismatch', 'conformance.deliveries', 'Delivery files and detailed task must retain their assignment and artifact identity');
      }
      if (!review.assignments.some((assignment) => sameRef(assignment, delivery.assignment)) ||
        !review.detailedPlanTasks.some((task) => sameRef(task, delivery.detailedPlanTask)) ||
        !review.reviewedArtifacts.some((artifact) => artifact.uri === delivery.artifact.uri && artifact.revision === delivery.artifact.revision && artifact.digest === delivery.artifact.digest)) {
        ctx.add(review, 'unreviewed_delivery', 'conformance.deliveries', 'Delivery provenance must name reviewed assignments, tasks and artifacts');
      }
      for (const resultRef of delivery.results) {
        const result = ctx.index.get(key(resultRef));
        if (!review.results.some((ref) => sameRef(ref, resultRef)) || result?.kind !== 'criterion_result' ||
          !sameRef(result.assignment, delivery.assignment) || (result.artifact &&
            (result.artifact.uri !== delivery.artifact.uri || result.artifact.revision !== delivery.artifact.revision || result.artifact.digest !== delivery.artifact.digest))) {
          ctx.add(review, 'delivery_result_mismatch', 'conformance.deliveries.results', 'Worker evidence must retain its exact assignment and delivered artifact');
        }
      }
    }
    for (const file of proof.deliveredFiles) if (!review.reviewedArtifacts.some((artifact) => artifact.revision === file.artifact.revision)) {
      ctx.add(review, 'unreviewed_artifact', 'conformance.deliveredFiles', 'Snapshot must name the delivered commit');
    }
    for (const quality of proof.technicalReviews) if (!review.reviewedArtifacts.some((artifact) => artifact.revision === quality.commit)) {
      ctx.add(review, 'unreviewed_artifact', 'conformance.technicalReviews', 'Quality evidence must name the delivered commit');
    }
  }
  const feature = review.feature ? ctx.get(review, review.feature, 'feature_revision', 'feature') : undefined;
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
  for (const assignmentRef of review.assignments) {
    const assignment = ctx.index.get(key(assignmentRef));
    if (assignment?.kind !== 'assignment' || assignment.criteria.length) continue;
    const results = review.results.flatMap((ref) => {
      const result = ctx.index.get(key(ref));
      return result?.kind === 'criterion_result' && sameRef(result.assignment, assignment) && result.criterion === null ? [result] : [];
    });
    if (!results.length || results.some((result) => result.result !== 'passed')) {
      ctx.add(review, 'incomplete_maintenance', 'results', `Maintenance assignment ${assignment.id} lacks passing objective evidence`);
    }
  }
  const criteria = scope === 'feature' ? feature?.criteria ?? [] : review.assignments.flatMap((reference) => {
    const assignment = ctx.index.get(key(reference));
    return assignment?.kind === 'assignment' ? assignment.criteria : [];
  });
  for (const ref of criteria) {
    const criterion = ctx.get(review, ref, 'criterion', 'criteria');
    if (!criterion || criterion.disposition.state !== 'active' || outsideTicket(ref) ||
      (scope === 'feature' && criterion.requirement !== 'required')) continue;
    const results = review.results.flatMap((resultRef) => {
      const record = ctx.index.get(key(resultRef));
      return record?.kind === 'criterion_result' && sameRef(record.criterion, ref) ? [record] : [];
    });
    if (!results.length || results.some((result) => result.result !== 'passed')) {
      ctx.add(review, 'incomplete_criterion', 'results', `Required criterion ${criterion.id} lacks current passing evidence`);
    }
  }
}

export function hasCheckedDesignReuse(records: FactoryRecord[], design: Ref, feature: Ref | null): boolean {
  return feature !== null && records.some((record) => record.kind === 'stage_revision' && record.stage === 'design' &&
    artifactReuse(record)?.check.result === 'passed' && sameRef(record.artifact, design) && sameRef(record.feature, feature));
}

function checkRecord(ctx: Context, record: FactoryRecord) {
  const project = ctx.records.find((candidate) => candidate.kind === 'project' && candidate.id === record.projectId);
  if (!project) ctx.add(record, 'missing_project', 'projectId', 'Project record is absent');
  switch (record.kind) {
    case 'understanding_revision': {
      const feature = ctx.get(record, record.feature, 'feature_revision', 'feature');
      ctx.criteria(record, record.criteria, feature);
      for (const ref of record.sourceRequests) ctx.get(record, ref, 'request', 'sourceRequests');
      for (const scope of record.scope) {
        const request = ctx.get(record, scope.request, 'request', 'scope.request');
        if (request && !request.originalText.toLocaleLowerCase('en').includes(scope.term.toLocaleLowerCase('en'))) {
          ctx.add(record, 'invalid_scope_term', 'scope', 'Scope term must occur in the original request');
        }
      }
      break;
    }
    case 'stage_revision': {
      const feature = ctx.get(record, record.feature, 'feature_revision', 'feature');
      ctx.criteria(record, record.criteria, feature);
      for (const ref of record.sourceRequests) ctx.get(record, ref, 'request', 'sourceRequests');
      const artifactKind = record.stage === 'understand' ? 'understanding_revision' :
        record.stage === 'design' ? 'design_revision' : 'implementation_plan_revision';
      const artifact = ctx.get(record, record.artifact, artifactKind, 'artifact');
      const reusedPlan = record.stage === 'detail' && ctx.records.some((stage) => stage.kind === 'stage_revision' &&
        stage.stage === 'plan' && artifactReuse(stage) && sameRef(stage.feature, record.feature) && sameRef(stage.artifact, record.artifact));
      if (artifact && (artifact.feature === null || (!artifactReuse(record) && !reusedPlan))) {
        ctx.equal(record, artifact.feature, record.feature, 'artifact.feature');
      }
      const predecessor = { design: 'understand', plan: 'design', detail: 'plan' };
      if (record.stage === 'understand') {
        if (record.previousStage) ctx.add(record, 'stage_order', 'previousStage', 'Understand starts the stage chain');
      } else {
        const previous = record.previousStage && ctx.get(record, record.previousStage, 'stage_revision', 'previousStage');
        if (!previous || previous.stage !== predecessor[record.stage]) ctx.add(record,
          'stage_order', 'previousStage', 'Stage must name its immediate method predecessor');
        if (previous) {
          ctx.equal(record, previous.feature, record.feature, 'previousStage.feature');
          if (record.stage === 'design' && artifact?.kind === 'design_revision' && !artifactReuse(record) && artifact.workflow) {
            ctx.equal(record, artifact.workflow.understanding, previous.artifact, 'workflow.understanding');
          }
          if (record.stage === 'plan' && artifact?.kind === 'implementation_plan_revision' && !artifactReuse(record)) {
            ctx.equal(record, artifact.design, previous.artifact, 'artifact.design');
          }
          if (record.stage === 'detail' && artifact?.kind === 'implementation_plan_revision' &&
            (artifact.id !== previous.artifact.id || artifact.revision < previous.artifact.revision)) {
            ctx.add(record, 'stage_order', 'artifact', 'Detail refines the selected plan');
          }
        }
      }
      if (record.reuse) {
        ctx.comparison(record, record.reuse.check, feature);
        ctx.sources(record, record.reuse.check, [...(feature?.sourceRequests ?? []),
          ...(artifactReuse(record) ? [record.artifact] : [])]);
        if (record.reuse.kind === 'project_code') {
          for (const source of record.reuse.sources) {
            if (!record.reuse.check.sourceRefs.some(candidate => sameSource(candidate, source))) {
              ctx.add(record, 'reuse_not_checked', 'reuse.sources', 'Code reuse must compare every selected source');
            }
            if (source.record) ctx.add(record, 'invalid_code_reuse', 'reuse.sources', 'Project code must name source files, not factory records');
          }
        }
        if (record.reuse.check.result !== 'passed') ctx.add(record, 'reuse_not_checked', 'reuse.check', 'Reuse check must pass');
        for (const mapping of record.reuse.criterionMap) {
          ctx.criteria(record, [mapping.current], feature);
          const existingFeature = artifact?.feature && ctx.get(record, artifact.feature, 'feature_revision', 'reuse.artifact.feature');
          ctx.criteria(record, [mapping.existing], existingFeature ?? undefined);
        }
        for (const ref of artifactReuse(record) ? feature?.criteria ?? [] : []) if (!record.reuse.criterionMap.some((entry) => sameRef(entry.current, ref))) {
          ctx.add(record, 'reuse_not_checked', 'reuse.criterionMap', `Reuse did not check current criterion ${ref.id}`);
        }
      }
      break;
    }
    case 'plan_readiness_revision': {
      const stage = ctx.get(record, record.detailStage, 'stage_revision', 'detailStage');
      ctx.get(record, record.plan, 'implementation_plan_revision', 'plan');
      if (stage) {
        ctx.equal(record, stage.feature, record.feature, 'feature');
        ctx.equal(record, stage.artifact, record.plan, 'plan');
        // Archived checks retain example findings from the former readiness rule.
        const findings = record.findings.filter(finding => finding.code !== 'example_driven_narrowing');
        if (canonical(planReadinessFindings(ctx.records, stage)) !== canonical(findings)) {
          ctx.add(record, 'readiness_mismatch', 'findings', 'Readiness findings must match deterministic checks');
        }
      }
      break;
    }
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
      if (record.completionEvidence) {
        if (record.state !== 'complete' || !carriesCompletionEvidence(ctx, record)) ctx.add(record,
          'invalid_completion_evidence', 'completionEvidence', 'Carry-forward needs a passing review and unchanged feature content');
      } else if (record.state === 'complete' && !ctx.records.some((candidate) => candidate.kind === 'product_review' &&
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
      const feature = record.feature ? ctx.get(record, record.feature, 'feature_revision', 'feature') : undefined;
      for (const ref of record.decisions) ctx.get(record, ref, 'decision_change', 'decisions');
      if (record.workflow) ctx.get(record, record.workflow.understanding, 'understanding_revision', 'workflow.understanding');
      ctx.comparison(record, record.sourceComparison, feature);
      const requests = feature?.sourceRequests ?? designRequests(ctx, record);
      if (record.feature === null && !requests.length) ctx.add(record, 'omitted_source', 'sourceRefs',
        'Standalone maintenance design must name its original request');
      ctx.sources(record, record.sourceComparison, requests);
      break;
    }
    case 'implementation_plan_revision': {
      const feature = record.feature ? ctx.get(record, record.feature, 'feature_revision', 'feature') : undefined;
      for (const slice of record.workflow?.slices ?? []) if (slice.criteriaProvenance) {
        if (canonical(slice.criteria) !== canonical(slice.criteriaProvenance.criteria)) ctx.add(record,
          'invalid_ref', 'workflow.slices.criteriaProvenance', 'Slice criteria must match its explicit provenance snapshot');
        const origin = slice.criteriaProvenance.feature ?
          ctx.get(record, slice.criteriaProvenance.feature, 'feature_revision', 'workflow.slices.criteriaProvenance.feature') : undefined;
        ctx.criteria(record, slice.criteriaProvenance.criteria, origin);
      }
      const design = ctx.get(record, record.design, 'design_revision', 'design');
      if (design && !hasCheckedDesignReuse(ctx.records, design, record.feature)) ctx.equal(record, design.feature, record.feature, 'design.feature');
      const covered = new Set<string>();
      const seen = new Set<string>();
      for (const ref of record.deliverySequence) {
        if (seen.has(ref.id)) ctx.add(record, 'duplicate_task', 'deliverySequence', `Repeated task ${ref.id}`);
        seen.add(ref.id);
        const task = ctx.get(record, ref, 'detailed_plan_task', 'deliverySequence');
        if (task) {
          const retained = record.workflow?.retainedTasks.some((entry) => sameRef(entry.task, task));
          if (retained) {
            const previous = ctx.get(record, { id: record.id, revision: record.revision - 1 },
              'implementation_plan_revision', 'workflow.retainedTasks');
            if (!previous?.deliverySequence.some((entry) => sameRef(entry, task))) ctx.add(record,
              'invalid_retained_task', 'workflow.retainedTasks', 'Retained task must occur unchanged in the previous plan');
          } else {
            ctx.equal(record, task.plan, asRef(record), 'task.plan');
            ctx.equal(record, task.design, record.design, 'task.design');
            ctx.equal(record, task.feature, record.feature, 'task.feature');
          }
          if (record.readiness.ready && (task.draft || !DetailedPlanTaskSchema.safeParse({ ...task, draft: false }).success)) {
            ctx.add(record, 'detail_gap', 'deliverySequence', `Ready plan has draft or incomplete task ${task.id}`);
          }
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
      ctx.sources(record, record.readiness.comparison, [...(feature?.sourceRequests ?? designRequests(ctx, design)), record.design]);
      if (record.readiness.ready) {
        if (record.workflow) {
          const check = record.workflow.readinessCheck && ctx.get(record, record.workflow.readinessCheck,
            'plan_readiness_revision', 'workflow.readinessCheck');
          if (check) ctx.equal(record, check.feature, record.feature, 'readinessCheck.feature');
          const previous = check && ctx.get(record, check.plan, 'implementation_plan_revision', 'readinessCheck.plan');
          const detail = check && ctx.index.get(key(check.detailStage));
          const content = (plan: typeof record, dependencies = plan.dependencies, selectedDetail?: StageRevision) => {
            const { revision: _revision, updatedAt: _updatedAt, readiness: _readiness, feature: _feature, workflow, ...rest } = plan;
            if (!workflow) return { ...rest, dependencies };
            const { readinessCheck: _check, retainedTasks: _retained, changeReason: _reason, ...design } = workflow;
            return { ...rest, dependencies, workflow: { ...design, slices: design.slices.map((slice) => {
              const { criteriaProvenance: _provenance, criteriaFeature: _legacy, ...content } = slice;
              return selectedDetail && record.workflow?.slices.some((item) => item.id === slice.id && item.criteriaProvenance) ?
                { ...content, criteria: stageSliceCriteria(ctx.records, selectedDetail, plan, slice).criteria } : content;
            }) } };
          };
          if (previous) {
            const dependencies = detail?.kind === 'stage_revision' ?
              stageDependencies(ctx.records, detail, previous.dependencies) : previous.dependencies;
            if (canonical(content(previous, dependencies, detail?.kind === 'stage_revision' ? detail : undefined)) !== canonical(content(record))) ctx.add(record,
              'plan_not_ready', 'workflow.readinessCheck', 'Ready plan content differs from the checked plan revision');
            if (detail?.kind === 'stage_revision') for (const slice of record.workflow.slices) {
              const old = previous.workflow?.slices.find((item) => item.id === slice.id);
              if (old && canonical(sliceCriterionProvenance(ctx.records, record, slice)) !==
                canonical(stageSliceCriteria(ctx.records, detail, previous, old))) ctx.add(record,
                'plan_not_ready', 'workflow.slices.criteriaProvenance', 'Slice provenance differs from the checked criterion interpretation');
            }
          }
          if (!check || !check.ready || check.plan.id !== record.id || check.plan.revision !== record.revision - 1) {
            ctx.add(record, 'plan_not_ready', 'workflow.readinessCheck', 'Ready revision needs a successful deterministic check of its predecessor');
          }
        }
        if (record.readiness.comparison.result !== 'passed') ctx.add(record, 'plan_not_ready', 'readiness', 'Source comparison did not pass');
        if (feature) for (const ref of feature.criteria) {
          const criterion = ctx.get(record, ref, 'criterion', 'criteria');
          const mapped = record.workflow?.readinessCheck && ctx.records.some((check) =>
            check.kind === 'plan_readiness_revision' && sameRef(check, record.workflow!.readinessCheck!) && check.ready);
          if (criterion?.requirement === 'required' && criterion.disposition.state === 'active' && !covered.has(key(ref)) && !mapped) {
            ctx.add(record, 'omitted_criterion', 'deliverySequence', `Plan omitted required criterion ${ref.id}`);
          }
        }
      }
      break;
    }
    case 'detailed_plan_task': {
      const feature = record.feature ? ctx.get(record, record.feature, 'feature_revision', 'feature') : undefined;
      const plan = ctx.get(record, record.plan, 'implementation_plan_revision', 'plan');
      const design = ctx.get(record, record.design, 'design_revision', 'design');
      ctx.criteria(record, record.criteria, feature);
      if (plan) {
        ctx.equal(record, record.feature, plan.feature, 'feature');
        ctx.equal(record, record.design, plan.design, 'design');
      }
      if (design && !hasCheckedDesignReuse(ctx.records, design, record.feature)) ctx.equal(record, record.feature, design.feature, 'design.feature');
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
        if (task && (!record.legacy || record.feature) && !ctx.records.some((plan) => plan.kind === 'implementation_plan_revision' &&
          plan.readiness.ready && sameRef(plan.feature, record.feature) && retainedTask(ctx, plan, task))) {
          ctx.equal(record, task.feature, record.feature, 'task.feature');
        }
      }
      break;
    }
    case 'assignment': checkAssignment(ctx, record); break;
    case 'criterion_result': {
      const assignment = ctx.get(record, record.assignment, 'assignment', 'assignment');
      if (record.criterion) ctx.get(record, record.criterion, 'criterion', 'criterion');
      const task = record.criterion === null && assignment ?
        ctx.get(record, assignment.detailedPlanTask, 'detailed_plan_task', 'assignment.detailedPlanTask') : undefined;
      const assigned = record.criterion === null ? task?.maintenanceObjective !== undefined && task.criteria.length === 0 :
        assignment?.criteria.some((ref) => sameRef(ref, record.criterion));
      if (assignment && !assigned) {
        ctx.add(record, 'unassigned_criterion', 'criterion', 'Result names a criterion/revision outside the assignment');
      }
      break;
    }
    case 'product_review': checkReview(ctx, record); break;
    case 'ticket_publication': {
      const aggregate = ctx.get(record, record.aggregateReview, 'product_review', 'aggregateReview');
      const assignments = aggregate?.assignments.map((assignment) => ctx.index.get(key(assignment))) ?? [];
      if (!aggregate?.feature || aggregate.ticketReview || aggregate.outcome !== 'passed' ||
        !aggregate.conformance?.deliveries?.some((delivery) => delivery.artifact.revision === record.reviewedCommit) ||
        (aggregate.conformance.currentTicket && aggregate.conformance.currentTicket.id !== record.ticketId) ||
        pullRequestIdentity(record.prUrl).repository !== record.repository || record.revision !== 1 ||
        record.sourceBranch !== `fm/ticket/${record.ticketId}` ||
        (record.firstObservedHead === record.reviewedCommit && !record.initialBaseline) ||
        assignments.some((assignment) => assignment?.kind !== 'assignment' ||
          !ctx.records.some((mapping) => mapping.kind === 'task_mapping' &&
            mapping.firstMateTaskId === assignment.firstMateTaskId && mapping.feature?.id === aggregate.feature?.id &&
            (mapping.featureTaskId === record.ticketId || mapping.firstMateTaskId === record.ticketId))) ||
        ctx.records.some((candidate) => candidate.kind === 'ticket_publication' && candidate.id !== record.id &&
          (candidate.ticketId === record.ticketId || samePullRequest(candidate.prUrl, record.prUrl)))) {
        ctx.add(record, 'invalid_ticket_publication', 'aggregateReview', 'Publication must bind one reviewed ticket delivery to one pull request');
      }
      break;
    }
    case 'measurement_claim':
      if (record.correctionOf) ctx.get(record, record.correctionOf, 'measurement_claim', 'correctionOf');
      break;
    case 'decision_change':
      if (record.answer) {
        if (record.choice?.kind !== 'product' || record.choice.state !== 'resolved' || record.disposition !== 'selected') {
          ctx.add(record, 'invalid_product_answer', 'answer', 'An answer requires a selected, resolved product decision');
        }
        if (record.answer.reusedFrom) {
          const source = ctx.get(record, record.answer.reusedFrom, 'decision_change', 'answer.reusedFrom');
          if (source && (!reusableAnswer(record, source) || record.answer.text !== source.answer?.text)) {
            ctx.add(record, 'invalid_answer_reuse', 'answer.reusedFrom', 'Reused answer must match the question, affected revisions and source text');
          }
        }
      }
      if (record.choice?.state === 'resolved' && !['selected', 'rejected'].includes(record.disposition)) {
        ctx.add(record, 'unsettled_decision', 'choice', 'Resolved decisions must have a selected or rejected disposition');
      }
      if (record.choice?.state === 'open' && ['selected', 'rejected'].includes(record.disposition)) {
        ctx.add(record, 'unsettled_decision', 'choice', 'Selected and rejected decisions are settled');
      }
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
        const intended = ctx.get(record, record.correction.assignment, 'assignment', 'correction.assignment');
        const original = record.correction.intendedRecipient;
        if (original) {
          const origin = ctx.get(record, original.assignment, 'assignment', 'correction.intendedRecipient');
          if (origin && (origin.attemptId !== original.attemptId || origin.firstMateTaskId !== original.firstMateTaskId ||
            origin.firstMateTaskId !== intended?.firstMateTaskId)) ctx.add(record, 'correction_recipient_mismatch',
            'correction.intendedRecipient', 'The original recipient and runtime task remain immutable');
        }
        const address = record.correction.addressedRecipient;
        if (address && (!sameRef(address.assignment, record.correction.assignment) || address.attemptId !== intended?.attemptId ||
          address.firstMateTaskId !== intended.firstMateTaskId)) ctx.add(record, 'correction_recipient_mismatch',
          'correction.addressedRecipient', 'Re-addressing must pin the selected attempt');
        for (const past of record.correction.deliveryHistory ?? []) {
          if (past.suspendedOperation) {
            const retired = ctx.get(record, past.suspendedOperation, 'operation', 'correction.deliveryHistory.suspendedOperation');
            if (retired && (!retired.suspended || retired.externalAttempt || retired.state !== 'pending' || retired.id !== past.operationId)) {
              ctx.add(record, 'invalid_suspended_replacement', 'correction.deliveryHistory', 'Only an unattempted retired delivery can be replaced on the same recipient');
            }
          }
          const target = ctx.get(record, past.assignment, 'assignment', 'correction.deliveryHistory');
          if (target && (past.recipient.attemptId !== target.attemptId || past.recipient.firstMateTaskId !== target.firstMateTaskId ||
            past.recipient.firstMateTaskId !== intended?.firstMateTaskId)) ctx.add(record, 'correction_recipient_mismatch',
            'correction.deliveryHistory', 'Historical delivery facts must retain their earlier attempt');
        }
        const captured = record.correction.deliveryRecipient;
        const recipient = captured && ctx.get(record, captured.assignment, 'assignment', 'correction.deliveryRecipient');
        if (captured && recipient && (recipient.id !== intended?.id || recipient.attemptId !== intended.attemptId || recipient.firstMateTaskId !== intended.firstMateTaskId ||
          recipient.attemptId !== captured.attemptId || recipient.firstMateTaskId !== captured.firstMateTaskId)) ctx.add(record,
          'correction_recipient_mismatch', 'correction.deliveryRecipient', 'Delivery receipt must preserve the intended attempt');
        if (record.correction.incorporationAssignment) {
          const incorporated = ctx.get(record, record.correction.incorporationAssignment, 'assignment', 'correction.incorporationAssignment');
          if (!record.correction.facts.some((fact) => fact.fact === 'incorporated') || (incorporated &&
            (incorporated.id !== intended?.id || incorporated.attemptId !== intended.attemptId ||
              incorporated.firstMateTaskId !== intended.firstMateTaskId))) ctx.add(record,
            'correction_incorporation_mismatch', 'correction.incorporationAssignment', 'Incorporation must name the delivered attempt');
        }
        if (!ctx.index.has(key(record.correction.affectedRevision))) ctx.add(record, 'missing_reference', 'correction.affectedRevision', 'Missing corrected revision');
        const initial = ctx.index.get(key({ id: record.id, revision: 1 }));
        const lineageRef = original?.assignment ?? (initial?.kind === 'observation' ? initial.correction?.assignment : undefined) ?? record.correction.assignment;
        for (const ref of record.correction.supersedes) {
          const prior = ctx.get(record, ref, 'observation', 'correction.supersedes');
          if (!prior?.correction) continue;
          // Supersession was authored on this original lineage. Re-addressing
          // changes delivery only; it must not rewrite these historical links.
          const lineage = ctx.get(record, lineageRef, 'assignment', 'correction.supersedes');
          const source = ctx.get(record, prior.correction.assignment, 'assignment', 'correction.supersedes');
          if (prior.correction.assignment.id !== lineageRef.id || source?.firstMateTaskId !== lineage?.firstMateTaskId ||
            source?.attemptId !== lineage?.attemptId || correctionOrder(prior as TrackedCorrection) >= correctionOrder(record as TrackedCorrection) ||
            prior.correction.urgentStop || prior.correction.facts.some((fact) => fact.fact === 'delivered')) ctx.add(record,
            'invalid_correction_supersession', 'correction.supersedes', 'Supersession must preserve earlier undelivered amendments on the original task lineage');
        }
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
  const activeLearning = activeGuidance(parsed.data).filter((record) => record.learning);
  for (const guidance of activeLearning) {
    const identity = guidance.learning!;
    for (const other of activeLearning) {
      if (other.projectId !== guidance.projectId || other.id === guidance.id || other.learning!.topic !== identity.topic) continue;
      const scope = identity.scope, otherScope = other.learning!.scope;
      const overlap = scope.kind === 'project' || otherScope.kind === 'project' || learningKey(identity) === learningKey(other.learning!);
      const override = scope.kind === 'feature' && otherScope.kind === 'project' && identity.authority === 'explicit' ||
        scope.kind === 'project' && otherScope.kind === 'feature' && other.learning!.authority === 'explicit';
      if (overlap && !override) ctx.add(guidance, 'contradictory_active_guidance', 'learning', 'Overlapping guidance must be consolidated or remain an open conflict');
    }
  }
  const mappings = [...ctx.current.values()].filter((record) => record.kind === 'task_mapping');
  for (const mapping of mappings) {
    if (mappings.some((other) => other.id !== mapping.id && other.firstMateTaskId === mapping.firstMateTaskId)) {
      ctx.add(mapping, 'duplicate_mapping', 'firstMateTaskId', 'One mapping owns each FirstMate task');
    }
  }
  try { assertTaskDependencyAcyclic([...ctx.current.values()]); }
  catch { if (mappings[0]) ctx.add(mappings[0], 'dependency_cycle', 'dependencies', 'Managed dependency cycle'); }
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
  if (ctx.current.get(owner.id)?.revision !== owner.revision) ctx.add(owner,
    'superseded_assignment', 'assignment', 'A newer revision of this assignment exists');
  for (const correction of outstandingTaskCorrections(validated.data, owner.firstMateTaskId)) {
    if (correctionTargetsAttempt(validated.data, correction, owner) && !correction.correction.deliveryHistory?.length) continue;
    if (!owner.correctionContext?.corrections.some((item) => item.id === correction.id) ||
      !owner.selectedContext.some((item) => item.source.record?.id === correction.id)) ctx.add(owner,
      'missing_correction_context', 'selectedContext', 'Replacement instructions must retain outstanding task corrections');
  }
  for (const unresolved of unresolvedTaskCorrections(validated.data, owner)) ctx.add(owner,
    'unresolved_correction_delivery', 'assignment', `Correction ${unresolved.correction.id} requires explicit delivery from ${unresolved.earlier.attemptId} to ${unresolved.replacement.attemptId}`);
  if (owner.correctionContext?.requiresReplan) ctx.add(owner, 'correction_requires_replan', 'assignment', 'Amended outcome needs checked replanning');
  if (owner.instructionFidelity.result !== 'passed') ctx.add(owner, 'instruction_fidelity', 'instructionFidelity',
    'Instruction comparison with original request, design and task has not passed');
  for (const source of missingAssignmentContext(validated.data, owner)) ctx.add(owner,
    'missing_required_context', 'selectedContext', `Missing required context: ${JSON.stringify(source)}`);
  const plan = ctx.get(owner, owner.plan, 'implementation_plan_revision', 'plan');
  const design = ctx.get(owner, owner.design, 'design_revision', 'design');
  if (!plan?.readiness.ready || design?.sourceComparison.result !== 'passed') ctx.add(owner, 'plan_not_ready', 'plan', 'Design/plan not ready');
  if (owner.feature) {
    for (const question of unansweredOwnerQuestions(validated.data, owner.feature.id)) ctx.add(owner,
      'ticket_awaiting_owner', 'feature', `${question.id}@${question.revision}: ${question.questionOrChange}`);
    const assigned = ctx.get(owner, owner.feature, 'feature_revision', 'feature');
    const current = ctx.current.get(owner.feature.id);
    if (assigned && current?.kind === 'feature_revision') {
      if (current.disposition.state !== 'active') ctx.add(owner, 'inactive_feature', 'feature', 'Feature is deferred or cancelled');
      else if (!hasDispatchCompatibleFeatureScope(ctx.records, assigned, current)) ctx.add(owner, 'superseded_feature', 'feature',
        'The current feature content supersedes this assignment');
    }
  }
  const mappings = [...ctx.current.values()].filter((record): record is OfKind<'task_mapping'> => record.kind === 'task_mapping' && !record.legacy &&
    record.projectId === owner.projectId && record.firstMateTaskId === owner.firstMateTaskId);
  const mapping = mappings.length === 1 ? mappings[0] : undefined;
  if (!mapping || !matchesAssignment(mapping, owner) || mapping.criteria.length !== owner.criteria.length ||
    !mapping.criteria.every((criterion) => owner.criteria.some((ref) => sameRef(criterion, ref)))) {
    ctx.add(owner, 'missing_mapping', 'firstMateTaskId', 'The current managed task mapping must match the assignment');
  } else if (mapping.disposition.state !== 'active') {
    ctx.add(owner, 'inactive_mapping', 'firstMateTaskId', 'The current managed task mapping is deferred or cancelled');
  }
  if (mapping?.management) {
    const operation = ctx.current.get(mapping.management.operationId);
    if (operation?.kind !== 'operation' || operation.state !== 'succeeded') {
      ctx.add(owner, 'task_mutation_unconfirmed', 'firstMateTaskId', 'Managed task mutation is not confirmed');
    }
    for (const reason of taskReadinessReasons([...ctx.current.values()], mapping)) {
      ctx.add(owner, 'task_not_ready', 'firstMateTaskId', reason);
    }
  }
  return ctx.issues.length ? { ok: false, issues: ctx.issues } : { ok: true, data: owner };
}

export function validateReviewForCompletion(input: unknown, reviewRef: Ref): ValidationResult<ProductReview> {
  return validateProductReview(input, reviewRef, 'feature');
}

/** A task's delivery depends on its own assigned criteria and exact delivery
 * evidence. The canonical review can remain feature-incomplete independently. */
export function validateTaskReviewForDelivery(input: unknown, reviewRef: Ref): ValidationResult<ProductReview> {
  return validateProductReview(input, reviewRef, 'task');
}

function validateProductReview(input: unknown, reviewRef: Ref, scope: 'feature' | 'task'): ValidationResult<ProductReview> {
  const validated = validateRecords(input);
  if (!validated.ok) return validated;
  const ctx = new Context(validated.data);
  const owner = validated.data.find((record) => record.kind === 'product_review' && sameRef(record, reviewRef));
  if (!owner || owner.kind !== 'product_review') return { ok: false, issues: [{ code: 'missing_review', recordId: reviewRef.id,
    path: 'review', message: 'Review revision is absent' }] };
  if (scope === 'task' && (owner.assignments.length !== 1 || !owner.conformance)) ctx.add(owner,
    'invalid_task_review', 'assignments', 'Task delivery requires one assignment and its generated conformance evidence');
  checkCompletion(ctx, owner, scope);
  // A historical review remains valid history, but cannot complete current work.
  if (owner.feature) {
    const feature = ctx.current.get(owner.feature.id);
    if (feature?.kind !== 'feature_revision' || !hasUnchangedFeatureScope(ctx.records, owner.feature, feature)) ctx.add(owner,
      'superseded_feature', 'feature', 'Completion requires unchanged active product scope or current evidence');
  }
  for (const assignment of owner.assignments) {
    const target = ctx.index.get(key(assignment));
    if (target?.kind !== 'assignment') continue;
    const candidates = [...ctx.current.values()].filter((record) => record.kind === 'assignment' && record.firstMateTaskId === target.firstMateTaskId);
    const time = Math.max(...candidates.map((record) => Date.parse(record.updatedAt)));
    const latest = candidates.filter((record) => Date.parse(record.updatedAt) === time);
    if (latest.length !== 1 || !sameRef(latest[0]!, assignment)) ctx.add(owner,
      'superseded_assignment', 'assignments', 'Completion requires the current unambiguous attempt');
    const mapping = [...ctx.current.values()].find((record) => record.kind === 'task_mapping' && record.firstMateTaskId === target.firstMateTaskId);
    if (mapping?.kind === 'task_mapping' && mapping.disposition.state !== 'active') ctx.add(owner,
      'inactive_mapping', 'assignments', 'Cancelled or deferred work cannot establish current completion');
    if (target.correctionContext?.requiresReplan) ctx.add(owner, 'correction_requires_replan', 'assignments', 'Changed outcome requires checked design and plan');
    for (const record of outstandingTaskCorrections(ctx.records, target.firstMateTaskId)) ctx.add(owner,
      'correction_not_incorporated', 'assignments', `Outstanding correction ${record.id} cannot be closed by a replacement or acknowledgement`);
  }
  if (owner.conformance) for (const assignment of owner.assignments) {
    if (ctx.current.get(assignment.id)?.revision !== assignment.revision) ctx.add(owner, 'superseded_assignment', 'assignments', 'Completion names an old assignment');
  }
  if (owner.outcome === 'failed' || (scope === 'feature' && owner.outcome !== 'passed')) ctx.add(owner,
    'review_failed', 'outcome', 'Review did not pass');
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
  if (previous.kind === 'operation' && next.kind === 'operation') {
    if ((previous.externalAttempt && canonical(previous.externalAttempt) !== canonical(next.externalAttempt)) ||
      (previous.suspended && canonical(previous.suspended) !== canonical(next.suspended))) {
      throw new Error('external_operation_history_mutation');
    }
  }
  if (previous.kind === 'observation' && next.kind === 'observation' && previous.correction) {
    const old = previous.correction; const correction = next.correction;
    const source = (item: typeof old) => [item.action, item.originalText, item.affectedRevision, item.sequence, item.taskOrder,
      item.supersedes, item.sourceRefs, item.urgentStop, item.compatibilityKey, item.impact, item.intendedRecipient];
    if (!correction || canonical(source(old)) !== canonical(source(correction)) ||
      (old.supersededBy && !sameRef(old.supersededBy, correction.supersededBy ?? null))) throw new Error('correction_history_mutation');
    const before = old.deliveryHistory ?? []; const after = correction.deliveryHistory ?? [];
    const readdressed = after.length === before.length + 1;
    if (readdressed) {
      const address = old.addressedRecipient ?? old.intendedRecipient ?? old.deliveryRecipient;
      const snapshot = after.at(-1)!;
      const expected = { assignment: old.assignment, recipient: address ?? snapshot.recipient, facts: old.facts,
        ...(snapshot.suspendedOperation ? { suspendedOperation: snapshot.suspendedOperation } : {}),
        ...(old.operationId ? { operationId: old.operationId } : {}),
        ...(old.deliveryRecipient ? { deliveryRecipient: old.deliveryRecipient } : {}),
        ...(old.incorporationAssignment ? { incorporationAssignment: old.incorporationAssignment } : {}) };
      if (canonical(after.slice(0, -1)) !== canonical(before) || canonical(snapshot) !== canonical(expected) ||
        !sameRef(snapshot.recipient.assignment, old.assignment) || !correction.addressedRecipient ||
        !sameRef(correction.addressedRecipient.assignment, correction.assignment) ||
        correction.addressedRecipient.firstMateTaskId !== snapshot.recipient.firstMateTaskId ||
        (correction.addressedRecipient.assignment.id === snapshot.recipient.assignment.id && correction.addressedRecipient.attemptId === snapshot.recipient.attemptId && !snapshot.suspendedOperation) ||
        (snapshot.suspendedOperation && (snapshot.suspendedOperation.id !== old.operationId || old.facts.some((fact) => fact.fact === 'delivered'))) ||
        !correction.operationId || correction.operationId === old.operationId || correction.deliveryRecipient || correction.incorporationAssignment ||
        old.facts.some((fact) => fact.fact === 'incorporated') || old.supersededBy ||
        canonical(correction.facts) !== canonical(old.facts.filter((fact) => fact.fact === 'recorded'))) throw new Error('correction_history_mutation');
    } else if (canonical(after) !== canonical(before) || !sameRef(old.assignment, correction.assignment) || old.operationId !== correction.operationId ||
      canonical(old.addressedRecipient) !== canonical(correction.addressedRecipient) ||
      old.facts.some((fact) => !correction.facts.some((item) => canonical(fact) === canonical(item))) ||
      (old.deliveryRecipient && canonical(old.deliveryRecipient) !== canonical(correction.deliveryRecipient)) ||
      (old.incorporationAssignment && !sameRef(old.incorporationAssignment, correction.incorporationAssignment ?? null))) {
      throw new Error('correction_history_mutation');
    }
  }
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
