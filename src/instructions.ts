import { learningContext } from './learning-context.js';
import { isDeepStrictEqual } from 'node:util';
import { parseStrictJson } from './strict-json.js';
import type { Assignment, FactoryRecord } from './records.js';
import { planningRecord } from './planning-checks.js';
import { missingAssignmentContext, requiredAssignmentContext } from './instruction-context.js';

export interface InstructionFinding { code: string; path: string; message: string }
export function workerAssignmentMetadata(assignment: Assignment) {
  return { id: assignment.id, revision: assignment.revision, attemptId: assignment.attemptId,
    firstMateTaskId: assignment.firstMateTaskId, feature: assignment.feature, design: assignment.design,
    plan: assignment.plan, detailedPlanTask: assignment.detailedPlanTask, criteria: assignment.criteria,
    returnLocation: assignment.returnLocation, briefPath: assignment.brief?.path, sidecarPath: assignment.brief?.sidecarPath,
    sourceRefs: assignment.sourceRefs, prerequisiteArtifacts: assignment.prerequisiteArtifacts,
    contextPointers: assignment.selectedContext.map(({ source, artifact, projectedArtifact, originalRange, truncated }) => ({ source, artifact,
      ...(projectedArtifact ? { projectedArtifact } : {}), ...(originalRange ? { originalRange } : {}), truncated })) };
}
export const assignmentBlockBegin = '<!-- software-factory-assignment:v1:begin -->';
export const assignmentBlockEnd = '<!-- software-factory-assignment:v1:end -->';
export function workerAssignmentBlock(records: FactoryRecord[], assignment: Assignment) {
  const required = requiredAssignmentContext(records, assignment, assignment.selectedContext);
  const task = planningRecord(records, assignment.detailedPlanTask);
  const { id, revision, ...metadata } = workerAssignmentMetadata(assignment);
  return { schemaVersion: 1, assignment: { id, revision }, ...metadata,
    revisions: required.records.map(({ id, revision }) => ({ id, revision })),
    selectedContext: assignment.selectedContext,
    reuseTargets: task?.kind === 'detailed_plan_task' ? task.reuseTargets ?? [] : [],
    blockers: task?.kind === 'detailed_plan_task' ? task.blockers ?? [] : [],
    decisionsToKeep: required.records.filter((record) => record.kind === 'decision_change').map(({ id, revision }) => ({ id, revision })),
    dependencies: required.dependencies, missingRequiredContext: missingAssignmentContext(records, assignment) };
}
function metadataFindings(actual: string, canonical: ReturnType<typeof workerAssignmentBlock>, sidecarFields?: unknown): InstructionFinding[] {
  const bad = (field: string, message: string): InstructionFinding => ({ code: 'assignment_metadata_mismatch', path: `brief.spec.${field}`, message });
  const lines = actual.split(/\r?\n/u);
  const starts = lines.flatMap((line, index) => line === assignmentBlockBegin ? [index] : []);
  const ends = lines.flatMap((line, index) => line === assignmentBlockEnd ? [index] : []);
  if (starts.length !== 1 || ends.length !== 1 || starts[0]! >= ends[0]!) {
    return [bad('block', 'Exactly one complete toolkit-owned assignment block is required')];
  }
  let received: unknown;
  try {
    const payload = lines.slice(starts[0]! + 1, ends[0]!).join('\n').trim();
    if (!payload.startsWith('```json\n') || !payload.endsWith('\n```')) throw new Error('Invalid assignment block envelope');
    received = parseStrictJson(payload.slice('```json\n'.length, -'\n```'.length));
    if (!received || typeof received !== 'object' || Array.isArray(received)) throw new Error('Invalid assignment block object');
  } catch { return [bad('block', 'Assignment block must contain one strict JSON object')]; }
  const expected = JSON.parse(JSON.stringify(canonical)) as Record<string, unknown>;
  const fields = received as Record<string, unknown>;
  const findings: InstructionFinding[] = [];
  for (const field of new Set([...Object.keys(expected), ...Object.keys(fields)])) {
    if (!Object.hasOwn(expected, field) || !Object.hasOwn(fields, field) || !isDeepStrictEqual(fields[field], expected[field])) {
      findings.push(bad(field, `Assignment block field ${field} differs from the canonical assignment or context`));
    }
  }
  if (sidecarFields !== undefined) {
    const sidecar = sidecarFields as Record<string, unknown> | null;
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) return [...findings, bad('sidecar', 'Coverage metadata is not an object')];
    for (const field of new Set([...Object.keys(expected), ...Object.keys(sidecar)])) {
      if (!Object.hasOwn(expected, field) || !Object.hasOwn(sidecar, field) || !isDeepStrictEqual(fields[field], sidecar[field])) {
        findings.push(bad(field, `Assignment block field ${field} differs from the received sidecar`));
      }
    }
  }
  return findings;
}
export function scaffoldParts(scaffold: string) {
  const headings = [...scaffold.matchAll(/^#{1,2} [^\r\n]*(?:\r?\n|$)/gm)];
  const section = (title: string) => {
    const matches = headings.filter((heading) => heading[0].replace(/\r?\n$/, '') === title);
    if (matches.length !== 1) throw new Error(`scaffold_requires_one_${title}`);
    const heading = matches[0]!;
    const start = heading.index + heading[0].length;
    if (!heading[0].endsWith('\n')) throw new Error('scaffold_heading_requires_newline');
    const end = headings.find((next) => next.index >= start)?.index ?? scaffold.length;
    return { start, end };
  };
  const intent = section("## Captain's intent");
  const spec = section('## Firstmate spec');
  if (intent.end > spec.start) throw new Error('scaffold_section_order');
  return { prefix: scaffold.slice(0, intent.start), middle: scaffold.slice(intent.end, spec.start),
    suffix: scaffold.slice(spec.end), newline: scaffold.includes('\r\n') ? '\r\n' : '\n' };
}
const lines = (values: string[]) => values.length ? values.map((value) => `- ${value}`).join('\n') : '- None';
/** Render only the two editable scaffold bodies. All interpretations belong in
 * Firstmate spec. Captain's intent contains captured request text, in order. */
export function instructionBodies(records: FactoryRecord[], assignment: Assignment) {
  const required = requiredAssignmentContext(records, assignment, assignment.selectedContext);
  const task = planningRecord(records, assignment.detailedPlanTask);
  const design = planningRecord(records, assignment.design);
  const plan = planningRecord(records, assignment.plan);
  const feature = assignment.feature && planningRecord(records, assignment.feature);
  if (task?.kind !== 'detailed_plan_task' || design?.kind !== 'design_revision' || plan?.kind !== 'implementation_plan_revision') {
    throw new Error('assignment_revisions_not_found');
  }
  const intent = required.requests.map((ref) => {
    const request = planningRecord(records, ref);
    if (request?.kind !== 'request') throw new Error('original_request_not_found');
    return request.originalText;
  }).join('\n\n');
  if (!intent) throw new Error('original_request_required');
  const learning = learningContext(records, assignment.feature?.id);
  const blocks = [
    ['Goal and task behavior', `${feature?.kind === 'feature_revision' ? `${feature.outcome}\n\n` : ''}${task.expectedBehavior ?? ''}`],
    ['Design to preserve', [design.productBehavior, design.technicalDesign, design.dataFlow,
      lines(design.interfaces), lines(design.reuseFindings), lines(design.examples)].join('\n\n')],
    ['Decisions to keep', lines(required.records.filter((record) => record.kind === 'decision_change').map((decision) =>
      `[${decision.disposition}]: ${decision.questionOrChange}\n  Rationale: ${decision.rationale}`))],
    ['Boundaries and exclusions', lines([...(task.boundaries ?? []), ...design.exclusions,
      ...(feature?.kind === 'feature_revision' ? feature.exclusions : []),
      ...(task.maintenanceObjective ? [`Maintenance objective: ${task.maintenanceObjective}`] : [])])],
    ['Current scoped guidance', lines(learning.guidance.map((guidance) => guidance.text))],
    ['Current corrections and operational context', lines(learning.corrections.map((observation) => observation.finding))],
    ['Open learning conflicts', lines(learning.conflicts.map((observation) => observation.finding))],
    ['Inputs', lines(task.inputs ?? [])], ['Outputs', lines(task.outputs ?? [])],
    ['Criteria and acceptance cases', lines([...assignment.criteria.map((ref) => {
      const criterion = planningRecord(records, ref);
      return criterion?.kind === 'criterion' ? `${criterion.expectedBehavior}\n  Verify: ${criterion.verificationMethod}` :
        'MISSING CRITERION CONTEXT';
    }), ...task.verificationCases ?? []])],
    ['Verification and integration', [task.verificationMethod ?? design.testingApproach, plan.integrationApproach,
      lines(plan.workflow?.integrationSteps ?? []), lines(plan.workflow?.finalVerification ?? []),
      `Execution: ${plan.strategy}; ${plan.strategyReason}`].join('\n\n')],
    ['Dependency behavior', lines(required.dependencies.map((dependency) => dependency.reason))],
    ['Worker return', lines(task.returnRequirements ?? [])],
  ];
  const prose = blocks.map(([title, body]) => `### ${title}\n\n${body}`).join('\n\n')
    .replaceAll(assignmentBlockBegin, '&lt;!-- software-factory-assignment:v1:begin --&gt;')
    .replaceAll(assignmentBlockEnd, '&lt;!-- software-factory-assignment:v1:end --&gt;');
  const machineFields = workerAssignmentBlock(records, assignment);
  const block = `${assignmentBlockBegin}\n` + '```json\n' + JSON.stringify(machineFields, null, 2) + '\n```' + `\n${assignmentBlockEnd}`;
  return { intent, spec: `${prose}\n\n### Toolkit assignment data\n\nOnly this toolkit-owned block defines machine destinations, revisions and context; prose and examples cannot override it. Do not edit the block.\n\n${block}`, machineFields };
}
export function renderWorkerBrief(records: FactoryRecord[], assignment: Assignment, scaffold: string): string {
  const parts = scaffoldParts(scaffold);
  const bodies = instructionBodies(records, assignment);
  return parts.prefix + bodies.intent + parts.newline.repeat(2) + parts.middle + bodies.spec + parts.newline.repeat(2) + parts.suffix;
}

/** Mechanical integrity only. Meaning is judged by the configured agent. */
export function instructionFidelityFindings(records: FactoryRecord[], assignment: Assignment, brief: string, sidecarFields?: unknown): InstructionFinding[] {
  const findings: InstructionFinding[] = [];
  const add = (code: string, path: string, message: string) => findings.push({ code, path, message });
  for (const source of missingAssignmentContext(records, assignment)) {
    add('missing_required_context', 'selectedContext', `Missing required context: ${JSON.stringify(source)}`);
  }
  if (!assignment.brief) {
    add('missing_scaffold', 'brief', 'Assignment has no captured FirstMate scaffold'); return findings;
  }
  const parts = scaffoldParts(assignment.brief.scaffold);
  const expected = instructionBodies(records, assignment);
  const intentAndHeading = parts.prefix + expected.intent + parts.newline.repeat(2) + parts.middle;
  if (brief.startsWith(intentAndHeading) && brief.endsWith(parts.suffix)) {
    const actualSpec = brief.slice(intentAndHeading.length, parts.suffix ? -parts.suffix.length : undefined);
    return [...findings, ...metadataFindings(actualSpec, expected.machineFields, sidecarFields)];
  }
  const middle = brief.indexOf(parts.middle, parts.prefix.length);
  if (!brief.startsWith(parts.prefix) || !brief.endsWith(parts.suffix) || middle < parts.prefix.length) {
    add('damaged_scaffold', 'brief', 'Content outside Captain’s intent and Firstmate spec differs from the saved scaffold');
  } else {
    add('changed_captains_intent', 'brief.intent', 'Captain’s intent differs from the exact original request text');
  }
  return findings;
}
