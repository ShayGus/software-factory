import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PrepareAssignmentCommandSchema } from './commands.js';
import { ref } from './intake.js';
import { ArtifactSchema, IdSchema, RefSchema, SourceRefSchema, TextSchema, TimestampSchema } from './primitives.js';
import { AssignmentSchema, DetailedPlanTaskSchema, type Assignment, type FactoryRecord } from './records.js';
import { planningRecord } from './planning-checks.js';
import { assignmentCriteria, digestText, missingAssignmentContext, recordSource, requiredAssignmentContext,
  sameSource, sameArtifactIdentity, selectAssignmentContext } from './instruction-context.js';
import { instructionBodies, instructionFidelityFindings, renderWorkerBrief, scaffoldParts, type InstructionFinding } from './instructions.js';
import { validateAssignmentForDispatch } from './rules.js';
import { ProjectStore, StoreError } from './store.js';

const SourceFileSchema = z.strictObject({ source: SourceRefSchema, path: TextSchema,
  artifact: ArtifactSchema.optional(),
  start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional(),
}).refine((value) => !value.artifact || value.artifact.uri === value.source.uri, 'Snapshot artifact URI must match its source');
export const PrepareWorkerBriefInputSchema = z.strictObject({
  projectId: IdSchema, assignmentId: IdSchema, attemptId: IdSchema,
  expectedRevision: z.number().int().nonnegative(), idempotencyKey: IdSchema, issuedAt: TimestampSchema,
  detailedPlanTask: RefSchema, plan: RefSchema, firstMateTaskId: IdSchema,
  returnLocation: TextSchema, briefPath: TextSchema, sidecarPath: TextSchema.optional(),
  maxSourceChars: z.number().int().positive().default(16_000),
  // Local snapshots of sources whose original URI cannot be read offline. Range
  // offsets select an exact task-relevant extract; no summarization/model call.
  sourceFiles: z.array(SourceFileSchema).default([]),
});

function localText(uri: string): string | undefined {
  try {
    const path = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    if (!isAbsolute(path)) return undefined;
    const bytes = readFileSync(path);
    return isUtf8(bytes) ? bytes.toString('utf8') : undefined;
  } catch { return undefined; }
}
function sidecar(records: FactoryRecord[], assignment: Assignment) {
  const required = requiredAssignmentContext(records, assignment, assignment.selectedContext);
  return JSON.stringify({ schemaVersion: 1, assignment: ref(assignment),
    revisions: required.records.map(ref), records: required.records, sourceRefs: assignment.sourceRefs,
    selectedContext: assignment.selectedContext, criteria: assignment.criteria,
    prerequisiteArtifacts: assignment.prerequisiteArtifacts,
    missingRequiredContext: missingAssignmentContext(records, assignment),
  }, null, 2) + '\n';
}
function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { flag: 'wx' }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}
function fileFindings(records: FactoryRecord[], assignment: Assignment): InstructionFinding[] {
  const findings: InstructionFinding[] = [];
  for (const context of assignment.selectedContext) {
    const record = context.source.record && planningRecord(records, context.source.record);
    const text = record ? record.kind === 'request' ? record.originalText : JSON.stringify(record, null, 2) :
      context.artifact && localText(context.artifact.uri);
    if (!text || !context.artifact || context.artifact.digest !== digestText(text) || !context.extract ||
      !text.includes(context.extract) || context.truncated !== (context.extract !== text)) {
      findings.push({ code: 'missing_required_context', path: 'selectedContext',
        message: `Context missing, changed, or unfaithful: ${JSON.stringify(context.source)}` });
    }
  }
  return findings;
}

/** No execution call. Commit immutable preparation intent first, then materialize
 * files. The same key repairs an interrupted write of either file on retry. */
export function prepareWorkerBrief(store: ProjectStore, input: unknown) {
  const data = PrepareWorkerBriefInputSchema.parse(input);
  const records = store.history(data.projectId);
  const task = planningRecord(records, data.detailedPlanTask);
  const plan = planningRecord(records, data.plan);
  if (task?.kind !== 'detailed_plan_task' || plan?.kind !== 'implementation_plan_revision') {
    throw new StoreError('not_found', 'detailed_task_or_plan_not_found');
  }
  if (!plan.readiness.ready || plan.readiness.comparison.result !== 'passed') throw new StoreError('validation', 'plan_not_ready');
  DetailedPlanTaskSchema.parse({ ...task, draft: false });
  if (task.draft) throw new StoreError('validation', 'task_not_ready');
  const briefPath = resolve(data.briefPath);
  const sidecarPath = resolve(data.sidecarPath ?? `${dirname(briefPath)}/${parse(briefPath).name}.sf.json`);
  if (briefPath === sidecarPath) throw new StoreError('validation', 'brief_and_sidecar_paths_must_differ');
  const previous = store.get(data.projectId, data.assignmentId);
  if (previous && previous.kind !== 'assignment') throw new StoreError('validation', 'assignment_identity_conflict');
  if (existsSync(sidecarPath) && previous?.brief?.sidecarPath !== sidecarPath) {
    throw new StoreError('conflict', 'sidecar_path_already_exists');
  }
  if (store.records(data.projectId).some((record) => record.kind === 'assignment' && record.id !== data.assignmentId &&
    record.brief && [record.brief.path, record.brief.sidecarPath].some((path) => [briefPath, sidecarPath].includes(path)))) {
    throw new StoreError('conflict', 'brief_path_owned_by_another_assignment');
  }
  const scaffold = previous?.brief?.path === briefPath ? previous.brief.scaffold : readFileSync(briefPath, 'utf8');
  scaffoldParts(scaffold); // Reject ambiguous templates before persisting anything.
  const sourceFiles = data.sourceFiles.map((entry) => ({ ...entry, path: resolve(entry.path) }));
  let assignment = AssignmentSchema.parse({ kind: 'assignment', id: data.assignmentId, projectId: data.projectId,
    schemaVersion: 1, revision: data.expectedRevision + 1, createdAt: previous?.createdAt ?? data.issuedAt, updatedAt: data.issuedAt,
    attemptId: data.attemptId, feature: plan.feature, design: plan.design, plan: ref(plan), detailedPlanTask: ref(task),
    firstMateTaskId: data.firstMateTaskId, sourceRefs: [recordSource(task)],
    selectedContext: [{ source: recordSource(task), truncated: false }],
    criteria: assignmentCriteria(records, plan, task), prerequisiteArtifacts: [], returnLocation: data.returnLocation,
    instructionText: 'Preparation in progress', instructionFidelity: { result: 'untested', sourceRefs: [recordSource(task)],
      findings: [], reviewerSession: 'factory:deterministic-instruction-fidelity', comparedAt: data.issuedAt },
    brief: { path: briefPath, sidecarPath, scaffold, sidecarDigest: 'pending' },
  });
  const selection = selectAssignmentContext(records, assignment, (source, artifact) => {
    const file = sourceFiles.find((entry) => sameSource(entry.source, source) && entry.artifact &&
      artifact && sameArtifactIdentity(entry.artifact, artifact)) ??
      sourceFiles.find((entry) => sameSource(entry.source, source) && !entry.artifact);
    const uri = file?.path ?? source.uri;
    // Record refs must resolve locally; never substitute an unrelated file for a
    // missing record revision. External sources require a readable local copy.
    if (source.record) return undefined;
    const text = localText(uri);
    return text === undefined ? undefined : { text, uri,
      ...(file?.artifact ? { identity: file.artifact } : {}),
      ...(file?.start !== undefined ? { start: file.start } : {}), ...(file?.end !== undefined ? { end: file.end } : {}) };
  }, data.maxSourceChars);
  if (selection.selectedContext.some((context) => context.artifact &&
    [briefPath, sidecarPath].includes(context.artifact.uri))) throw new StoreError('validation', 'output_overwrites_context_source');
  assignment.selectedContext = selection.selectedContext;
  assignment.sourceRefs = selection.sources;
  assignment.prerequisiteArtifacts = selection.prerequisites;
  assignment.instructionFidelity.sourceRefs = [plan.design, ref(plan), ref(task), ...selection.requests].map(recordSource);
  // Normalize schema field ordering before rendering/hashing. Store boundaries
  // parse again, and that must not change the materialized coverage identity.
  assignment = AssignmentSchema.parse(assignment);
  assignment.instructionText = instructionBodies(records, assignment).spec;
  const text = renderWorkerBrief(records, assignment, scaffold);
  const findings = [...instructionFidelityFindings(records, assignment, text), ...fileFindings(records, assignment)];
  assignment.instructionFidelity.result = findings.length ? 'failed' : 'passed';
  assignment.instructionFidelity.findings = findings.map((finding) => ({ result: 'failed', description: `${finding.code}: ${finding.message}`,
    sourceRefs: assignment.instructionFidelity.sourceRefs, evidence: [] }));
  const coverage = sidecar(records, assignment);
  assignment.brief!.sidecarDigest = digestText(coverage);
  const command = PrepareAssignmentCommandSchema.parse({ schemaVersion: 1, id: randomUUID(), projectId: data.projectId,
    issuedAt: data.issuedAt, idempotencyKey: data.idempotencyKey, command: 'prepare_assignment', targetId: assignment.id,
    expectedRevision: data.expectedRevision, payload: { detailedPlanTask: ref(task), feature: assignment.feature,
      design: assignment.design, plan: assignment.plan, firstMateTaskId: assignment.firstMateTaskId,
      selectedContext: assignment.selectedContext, returnLocation: assignment.returnLocation,
      generation: { attemptId: assignment.attemptId, briefPath, sidecarPath, scaffold,
        maxSourceChars: data.maxSourceChars, sourceFiles } },
  });
  const result = store.mutate(command, () => [assignment]);
  const savedRef = result.records.find((record) => record.id === assignment.id)!;
  const saved = store.get(data.projectId, savedRef.id, savedRef.revision);
  if (saved?.kind !== 'assignment' || !saved.brief) throw new StoreError('validation', 'assignment_preparation_not_saved');
  if (store.get(data.projectId, saved.id)?.revision !== saved.revision) {
    throw new StoreError('conflict', 'superseded_assignment_cannot_materialize_brief');
  }
  // Use the committed record on replay, including its original comparison time.
  atomicWrite(sidecarPath, sidecar(records, saved));
  atomicWrite(briefPath, renderWorkerBrief(records, saved, saved.brief.scaffold));
  return { assignment: ref(saved), briefPath, sidecarPath, ...checkWorkerBrief(store, data.projectId, ref(saved), briefPath) };
}

/** Read-only gate for a future worker-start hook. Exit eligibility is based on
 * current files and dispatch rules, never a sidecar's self-reported pass flag. */
export function checkWorkerBrief(store: ProjectStore, projectId: string, assignmentRef: { id: string; revision: number }, briefPath: string) {
  const records = store.history(projectId);
  const assignment = planningRecord(records, assignmentRef);
  if (assignment?.kind !== 'assignment') throw new StoreError('not_found', 'assignment_not_found');
  const findings: InstructionFinding[] = [];
  const path = resolve(briefPath);
  if (assignment.brief?.path !== path) findings.push({ code: 'brief_path_mismatch', path: 'brief', message: 'Brief path differs from the prepared assignment' });
  try { findings.push(...instructionFidelityFindings(records, assignment, readFileSync(path, 'utf8'))); }
  catch (error) { findings.push({ code: 'damaged_scaffold', path: 'brief', message: String(error) }); }
  if (assignment.brief) {
    try {
      const coverage = readFileSync(assignment.brief.sidecarPath, 'utf8');
      if (digestText(coverage) !== assignment.brief.sidecarDigest || coverage !== sidecar(records, assignment)) {
        findings.push({ code: 'sidecar_mismatch', path: 'sidecar', message: 'Coverage differs from the committed assignment and source revisions' });
      }
    } catch { findings.push({ code: 'missing_required_context', path: 'sidecar', message: 'Coverage sidecar is missing or unreadable' }); }
    findings.push(...fileFindings(records, assignment));
  }
  const dispatch = validateAssignmentForDispatch(records, assignmentRef);
  if (!dispatch.ok) findings.push(...dispatch.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })));
  return { ok: findings.length === 0, findings };
}

export type PrepareWorkerBriefInput = z.input<typeof PrepareWorkerBriefInputSchema>;
