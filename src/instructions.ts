import type { Assignment, FactoryRecord } from './records.js';
import { planningRecord } from './planning-checks.js';
import { missingAssignmentContext, narrowedInstruction, requiredAssignmentContext } from './instruction-context.js';

export interface InstructionFinding { code: string; path: string; message: string }
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
const label = (record: { id: string; revision: number }) => `${record.id}@${record.revision}`;
function extraLines(actual: string, expected: string): string[] {
  const counts = new Map<string, number>();
  for (const line of expected.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return actual.split('\n').filter((line) => {
    const count = counts.get(line) ?? 0;
    if (count) { counts.set(line, count - 1); return false; }
    return true;
  });
}

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
  const blocks = [
    ['Traceability', lines([`Assignment: ${label(assignment)}; attempt: ${assignment.attemptId}`,
      `Design: ${label(design)}; plan: ${label(plan)}; detailed task: ${label(task)}`,
      `Feature: ${assignment.feature ? label(assignment.feature) : 'explicit maintenance objective'}`,
      `Coverage and complete record originals: ${assignment.brief?.sidecarPath ?? ''}`])],
    ['Goal and task behavior', `${feature?.kind === 'feature_revision' ? `${feature.outcome}\n\n` : ''}${task.expectedBehavior ?? ''}`],
    ['Design to preserve', [design.productBehavior, design.technicalDesign, design.dataFlow,
      lines(design.interfaces), lines(design.reuseFindings), lines(design.examples)].join('\n\n')],
    ['Decisions to keep', lines(required.records.filter((record) => record.kind === 'decision_change').map((decision) =>
      `${label(decision)} [${decision.disposition}]: ${decision.questionOrChange}\n  Rationale: ${decision.rationale}`))],
    ['Boundaries and exclusions', lines([...(task.boundaries ?? []), ...design.exclusions,
      ...(feature?.kind === 'feature_revision' ? feature.exclusions : []),
      ...(task.maintenanceObjective ? [`Maintenance objective: ${task.maintenanceObjective}`] : [])])],
    ['Inputs', lines(task.inputs ?? [])], ['Outputs', lines(task.outputs ?? [])],
    ['Reuse targets', lines((task.reuseTargets ?? []).map((source) => JSON.stringify(source)))],
    ['Criteria and acceptance cases', lines([...assignment.criteria.map((ref) => {
      const criterion = planningRecord(records, ref);
      return criterion?.kind === 'criterion' ? `${label(criterion)}: ${criterion.expectedBehavior}\n  Verify: ${criterion.verificationMethod}` :
        `${label(ref)}: MISSING CRITERION CONTEXT`;
    }), ...task.verificationCases ?? []])],
    ['Verification and integration', [task.verificationMethod ?? design.testingApproach, plan.integrationApproach,
      lines(plan.workflow?.integrationSteps ?? []), lines(plan.workflow?.finalVerification ?? []),
      `Execution: ${plan.strategy}; ${plan.strategyReason}`].join('\n\n')],
    ['Dependency outputs and blockers', lines([...(task.blockers ?? []), ...required.dependencies.map((dependency) => JSON.stringify(dependency))])],
    ['Worker return', `${lines(task.returnRequirements ?? [])}\n\nReturn location: ${assignment.returnLocation}`],
    ['Required context', assignment.selectedContext.map((context) => [
      JSON.stringify({ source: context.source, artifact: context.artifact, truncated: context.truncated }),
      ...(context.extract ?? '').split('\n').map((line) => `> ${line}`),
    ].join('\n')).join('\n\n')],
    ['Missing required context', lines(missingAssignmentContext(records, assignment).map((source) => JSON.stringify(source)))],
  ];
  return { intent, spec: blocks.map(([title, body]) => `### ${title}\n\n${body}`).join('\n\n') };
}
export function renderWorkerBrief(records: FactoryRecord[], assignment: Assignment, scaffold: string): string {
  const parts = scaffoldParts(scaffold);
  const bodies = instructionBodies(records, assignment);
  return parts.prefix + bodies.intent + parts.newline.repeat(2) + parts.middle + bodies.spec + parts.newline.repeat(2) + parts.suffix;
}

/** Exact derivation is intentionally conservative: an unplanned prose edit is a
 * finding, even if it might be a harmless paraphrase. Amend the plan and regenerate
 * instead of allowing changed prose to approve itself. */
export function instructionFidelityFindings(records: FactoryRecord[], assignment: Assignment, brief: string): InstructionFinding[] {
  const findings: InstructionFinding[] = [];
  const add = (code: string, path: string, message: string) => findings.push({ code, path, message });
  for (const source of missingAssignmentContext(records, assignment)) {
    add('missing_required_context', 'selectedContext', `Missing required context: ${JSON.stringify(source)}`);
  }
  if (!assignment.brief) {
    add('missing_scaffold', 'brief', 'Assignment has no captured FirstMate scaffold');
    if (narrowedInstruction(records, assignment, assignment.instructionText)) add('narrowed_generality', 'instructionText', 'An example became the full scope');
    return findings;
  }
  const parts = scaffoldParts(assignment.brief.scaffold);
  const expected = instructionBodies(records, assignment);
  if (assignment.instructionText !== expected.spec) {
    add('altered_instructions', 'instructionText', 'Assignment instruction text differs from its source-derived task content');
    if (narrowedInstruction(records, assignment, assignment.instructionText)) add('narrowed_generality', 'instructionText',
      'Assignment instructions restrict an original example to the full implementation scope');
  }
  if (brief === renderWorkerBrief(records, assignment, assignment.brief.scaffold)) return findings;
  const middle = brief.indexOf(parts.middle, parts.prefix.length);
  const intact = brief.startsWith(parts.prefix) && brief.endsWith(parts.suffix) && middle >= parts.prefix.length;
  if (!intact) {
    add('damaged_scaffold', 'brief', 'Content outside Captain’s intent and Firstmate spec differs from the saved scaffold');
    return findings;
  }
  const actualIntent = brief.slice(parts.prefix.length, middle);
  const actualSpec = brief.slice(middle + parts.middle.length, parts.suffix ? -parts.suffix.length : undefined);
  if (actualIntent !== expected.intent + parts.newline.repeat(2)) add('changed_captains_intent', 'brief.intent', 'Captain’s intent differs from the exact original request text');
  const expectedSpec = expected.spec + parts.newline.repeat(2);
  const added = extraLines(actualSpec, expectedSpec);
  if (actualSpec !== expectedSpec) {
    if (extraLines(expectedSpec, actualSpec).some((line) => line.trim())) {
      add('omitted_behavior', 'brief.spec', 'Detailed-task behavior, design, verification or required context was omitted or changed');
    }
    if (added.some((line) => line.trim())) add('invented_scope', 'brief.spec', 'Instructions contain content not derived from the task/design/source revisions');
    if (!findings.some((finding) => finding.path === 'brief.spec')) add('altered_instructions', 'brief.spec', 'Generated content order or formatting changed; regenerate the brief');
  }
  if (narrowedInstruction(records, assignment, added.join('\n'))) {
    add('narrowed_generality', 'brief.spec', 'Instructions restrict an original example to the entire implementation scope');
  }
  return findings;
}
