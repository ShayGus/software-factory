import { createHash } from 'node:crypto';
import type { Artifact, Ref } from './primitives.js';
import type { Assignment, CriterionResult, FactoryRecord, ImplementationPlanRevision } from './records.js';
import { planningRecord, samePlanningRef, stageCriteria } from './planning-checks.js';

export type Source = Assignment['sourceRefs'][number];
export type Context = Assignment['selectedContext'][number];
export const digestText = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const recordSource = (record: Ref): Source => ({
  uri: `factory:record/${encodeURIComponent(record.id)}@${record.revision}`,
  record: { id: record.id, revision: record.revision },
});
export const sameSource = (a: Source, b: Source) => a.uri === b.uri && a.excerpt === b.excerpt &&
  (a.record ? !!b.record && samePlanningRef(a.record, b.record) : !b.record);
export const sameArtifactIdentity = (a: Artifact, b: Artifact) =>
  a.uri === b.uri && a.revision === b.revision && a.digest === b.digest;
export type MissingContext = Source & { artifact?: Artifact };
type ContextRequirement = { source: Source; artifact?: Artifact };
const unique = <T>(items: T[], equal: (a: T, b: T) => boolean) =>
  items.filter((item, index) => items.findIndex((other) => equal(item, other)) === index);
function contextRequirements(sources: Source[], artifacts: Artifact[]): ContextRequirement[] {
  return sources.flatMap((source) => {
    // A quoted source identifies content to receive, not a quote required from
    // every version at that URI. Bare artifact sources are added separately.
    const versions = source.record || source.excerpt !== undefined ? [] :
      unique(artifacts.filter((artifact) => artifact.uri === source.uri), sameArtifactIdentity);
    return versions.length ? versions.map((artifact) => ({ source, artifact })) : [{ source }];
  });
}
const missingContext = ({ source, artifact }: ContextRequirement): MissingContext =>
  ({ ...source, ...(artifact ? { artifact } : {}) });

export function assignmentCriteria(records: FactoryRecord[], plan: ImplementationPlanRevision, task: Ref): Ref[] {
  const detailTask = planningRecord(records, task);
  if (detailTask?.kind !== 'detailed_plan_task') return [];
  const check = plan.workflow?.readinessCheck && planningRecord(records, plan.workflow.readinessCheck);
  const detail = check?.kind === 'plan_readiness_revision' ? planningRecord(records, check.detailStage) : undefined;
  return unique(detail?.kind === 'stage_revision' ?
    stageCriteria(records, detail, detailTask.criteria, detailTask.feature, [task]) : detailTask.criteria, samePlanningRef);
}

/** Select exact revisions, never a latest-by-title approximation. Original
 * request/attachment pointers remain distinct from the captured request record. */
export function requiredAssignmentContext(records: FactoryRecord[], assignment: Pick<Assignment,
  'feature' | 'design' | 'plan' | 'detailedPlanTask' | 'criteria' | 'projectId'>, received?: Context[]) {
  const task = planningRecord(records, assignment.detailedPlanTask);
  const design = planningRecord(records, assignment.design);
  const plan = planningRecord(records, assignment.plan);
  const feature = assignment.feature && planningRecord(records, assignment.feature);
  const requests = feature?.kind === 'feature_revision' ? feature.sourceRequests :
    design?.kind === 'design_revision' ? design.sourceRefs.flatMap((source) => source.record &&
      planningRecord(records, source.record)?.kind === 'request' ? [source.record] : []) : [];
  const dependencies = plan?.kind === 'implementation_plan_revision' ?
    plan.dependencies.filter((dependency) => dependency.consumerTaskId === assignment.detailedPlanTask.id) : [];
  const prerequisites = dependencies.flatMap((dependency) => dependency.needs.kind === 'artifact' ? [dependency.needs.artifact] : []);
  const dependencyResults = dependencies.flatMap((dependency) => {
    if (dependency.needs.kind !== 'criterion' || plan?.kind !== 'implementation_plan_revision') return [];
    const criterion = dependency.needs.criterion;
    const prerequisite = plan.deliverySequence.find((task) => task.id === dependency.prerequisiteTaskId);
    return records.filter((record): record is CriterionResult => {
      if (record.kind !== 'criterion_result' || record.result !== 'passed' || !record.criterion ||
        !samePlanningRef(record.criterion, criterion)) return false;
      // A checked assignment describes what was received then. Later results
      // must not silently replace that pinned handover context.
      if (received && !received.some((context) => context.source.record && samePlanningRef(context.source.record, record))) return false;
      const owner = planningRecord(records, record.assignment);
      return owner?.kind === 'assignment' && !!prerequisite && samePlanningRef(owner.detailedPlanTask, prerequisite);
    }).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id) || a.revision - b.revision).slice(-1);
  });
  const refs: Ref[] = [assignment.design, assignment.plan, assignment.detailedPlanTask,
    ...(assignment.feature ? [assignment.feature] : []), ...requests, ...assignment.criteria,
    ...(design?.kind === 'design_revision' ? design.decisions : []),
    ...(task?.kind === 'detailed_plan_task' ? task.decisionsToKeep ?? [] : []),
    ...(feature?.kind === 'feature_revision' ? feature.decisions : []),
    ...dependencies.flatMap((dependency) => dependency.needs.kind === 'criterion' ? [dependency.needs.criterion] : []),
    ...dependencies.flatMap((dependency) => plan?.kind === 'implementation_plan_revision' ?
      plan.deliverySequence.filter((task) => task.id === dependency.prerequisiteTaskId) : []),
    ...dependencyResults,
    ...dependencyResults.map((result) => result.assignment),
    ...(task?.kind === 'detailed_plan_task' ? [task.plan, task.design, ...(task.feature ? [task.feature] : []), ...task.criteria] : []),
    ...(design?.kind === 'design_revision' && design.workflow ? [design.workflow.understanding] : []),
    ...(plan?.kind === 'implementation_plan_revision' && plan.workflow?.readinessCheck ? [plan.workflow.readinessCheck] : []),
  ];
  // Keep checked reuse and task-retention provenance reachable without attaching
  // every unrelated task or execution attempt in the project.
  for (let index = 0; index < refs.length; index++) {
    const record = planningRecord(records, refs[index]!);
    const links = record?.kind === 'plan_readiness_revision' ? [record.plan, record.detailStage] :
      record?.kind === 'stage_revision' ? [record.artifact, ...(record.previousStage ? [record.previousStage] : [])] : [];
    for (const link of links) if (!refs.some((ref) => samePlanningRef(ref, link))) refs.push(link);
  }
  const selectedRecords: FactoryRecord[] = [];
  const sources: Source[] = unique(refs, samePlanningRef).map(recordSource);
  if (design?.kind === 'design_revision') sources.push(...design.sourceRefs);
  if (task?.kind === 'detailed_plan_task') sources.push(...task.designRefs ?? [], ...task.reuseTargets ?? []);
  const artifacts: Artifact[] = [...prerequisites];
  for (const result of dependencyResults) if (result.artifact) {
    prerequisites.push(result.artifact); artifacts.push(result.artifact);
  }
  for (const dependency of dependencies) if (dependency.needs.kind === 'criterion') {
    const criterion = dependency.needs.criterion;
    if (!dependencyResults.some((result) => {
      const owner = planningRecord(records, result.assignment);
      return result.criterion && samePlanningRef(result.criterion, criterion) && owner?.kind === 'assignment' &&
        owner.detailedPlanTask.id === dependency.prerequisiteTaskId;
    })) {
      sources.push({ uri: `factory:criterion-output/${encodeURIComponent(dependency.prerequisiteTaskId)}/${encodeURIComponent(criterion.id)}@${criterion.revision}` });
    }
  }
  // Collect source-linked record originals before finalizing sidecar coverage.
  // Follow source references at exact revisions, including reused designs that
  // are not a primary assignment/design/plan pointer.
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    const record = source.record && planningRecord(records, source.record);
    if (!record || selectedRecords.some((selected) => samePlanningRef(selected, record))) continue;
    selectedRecords.push(record);
    if (record.kind === 'request') { sources.push(record.source); artifacts.push(...record.attachments); }
    if (record.kind === 'criterion' || record.kind === 'decision_change' || record.kind === 'design_revision') sources.push(...record.sourceRefs);
    if (record.kind === 'detailed_plan_task') sources.push(...record.designRefs ?? [], ...record.reuseTargets ?? []);
  }
  sources.push(...artifacts.map((artifact) => ({ uri: artifact.uri })));
  return { requests, records: selectedRecords, sources: unique(sources, sameSource), prerequisites, artifacts, dependencies };
}

export type LoadedSource = { text: string; uri: string; start?: number; end?: number; identity?: Artifact };
export type SourceLoader = (source: Source, artifact?: Artifact) => LoadedSource | undefined;

/** Extracts are verbatim UTF-16 slices. A caller can select a task-relevant range;
 * otherwise the beginning is supplied with an explicit truncation flag. Full
 * record originals are bundled alongside the extracts in the sidecar. */
export function selectAssignmentContext(records: FactoryRecord[], assignment: Parameters<typeof requiredAssignmentContext>[1],
  load: SourceLoader, maxSourceChars = 16_000) {
  if (!Number.isSafeInteger(maxSourceChars) || maxSourceChars < 1) throw new Error('invalid_context_limit');
  const required = requiredAssignmentContext(records, assignment);
  const selectedContext: Context[] = [];
  const missing: MissingContext[] = [];
  for (const requirement of contextRequirements(required.sources, required.artifacts)) {
    const { source, artifact } = requirement;
    const record = source.record && planningRecord(records, source.record);
    if (source.record && !record) { missing.push(missingContext(requirement)); continue; }
    const loaded = record ? { text: record.kind === 'request' ? record.originalText : JSON.stringify(record, null, 2),
      uri: recordSource(record).uri } : load(source, artifact);
    const versions = unique(required.artifacts.filter((candidate) => candidate.uri === source.uri), sameArtifactIdentity);
    if (!loaded || (artifact && ((loaded.identity && !sameArtifactIdentity(loaded.identity, artifact)) ||
      (versions.length > 1 && !loaded.identity)))) { missing.push(missingContext(requirement)); continue; }
    const { text, uri } = loaded;
    const start = loaded.start ?? (source.excerpt ? text.indexOf(source.excerpt) : 0);
    const requestedEnd = loaded.end ?? (source.excerpt ? start + source.excerpt.length : text.length);
    const splitsPair = (offset: number) => offset > 0 && offset < text.length &&
      /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!);
    let end = Math.min(requestedEnd, start + maxSourceChars);
    if (splitsPair(end)) end--;
    if (start < 0 || requestedEnd > text.length || splitsPair(start) || splitsPair(requestedEnd) ||
      end <= start || !text.slice(start, end).trim()) {
      missing.push(missingContext(requirement)); continue;
    }
    if (artifact?.digest && artifact.digest !== digestText(text)) { missing.push(missingContext(requirement)); continue; }
    selectedContext.push({ source, extract: text.slice(start, end), truncated: start !== 0 || end !== text.length,
      artifact: { uri, digest: digestText(text), ...(artifact?.revision ? { revision: artifact.revision } : {}) } });
  }
  return { ...required, selectedContext, missing };
}

/** Existing assignment contracts also require the essential request/design/plan/
 * task context. Generated assignments additionally account for every selected
 * decision, criterion, original source and dependency artifact. */
export function missingAssignmentContext(records: FactoryRecord[], assignment: Assignment): MissingContext[] {
  const required = requiredAssignmentContext(records, assignment, assignment.selectedContext);
  const sources = assignment.brief ? required.sources : [assignment.design, assignment.plan, assignment.detailedPlanTask,
    ...required.requests].map(recordSource);
  return contextRequirements(sources, assignment.brief ? required.artifacts : []).filter(({ source, artifact }) => !assignment.selectedContext.some((context) => {
    const matches = assignment.brief ? sameSource(context.source, source) :
      context.source.record && source.record && samePlanningRef(context.source.record, source.record);
    return matches && (!assignment.brief || (context.extract !== undefined && context.artifact !== undefined &&
      (!artifact || (context.artifact.revision === artifact.revision && (!artifact.digest || context.artifact.digest === artifact.digest)))));
  })).map(missingContext);
}
