import { FactoryProjectsSchema, factoryProject, checkBuilderAdmission, repositoryIdentity } from './factory-locks.js';
import { readFleetSnapshot, type FleetSnapshot } from './runtime.js';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { checkWorkerBrief } from './briefs.js';
import { ProjectStore } from './store.js';
import { currentAssignmentAttempts, currentTaskMappings } from './task-readiness.js';
import { parseStrictJson } from './strict-json.js';
import { validateReviewForCompletion } from './rules.js';
import { readTicketDelivery, reviewedTicketIntent, reviewedTicketNotes, ticketDeliveryMarker, ticketDeliveryStartCommand, verifyTicketBranch } from './ticket-delivery.js';

const absolute = z.string().min(1).refine(isAbsolute, 'Absolute path required');
export const WorkerHookConfigSchema = FactoryProjectsSchema;
const EventSchema = z.object({ version: z.literal(1), event: z.literal('worker.start.before'),
  home: absolute, task_id: z.string().min(1), project: absolute, kind: z.string().optional(),
  mode: z.string().nullish(), branch: z.string().nullish(), base_branch: z.string().nullish(), raw_command: z.string().nullish(),
  project_capacity: z.string().regex(/^[1-9][0-9]{0,5}$/u).transform(Number).nullable().optional(),
  source_brief_path: absolute.nullable(), brief_path: absolute.nullable(),
  brief_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
});

function checkTicketDeliveryWorker(store: ProjectStore, projectId: string, event: z.infer<typeof EventSchema>) {
  if (event.kind !== 'ship' || event.mode !== 'no-mistakes' || !event.source_brief_path || !event.brief_path || !event.brief_sha256) return false;
  const source = readFileSync(event.source_brief_path, 'utf8');
  const markers = source.split('\n').filter((line) => line.startsWith(ticketDeliveryMarker));
  if (!markers.length) return false;
  const fail = () => new Error('hook_factory_ticket_delivery_not_verified');
  const path = markers[0]!.slice(ticketDeliveryMarker.length);
  if (markers.length !== 1 || !isAbsolute(path) || basename(path) !== 'ticket-delivery.json') throw fail();
  const data = realpathSync(join(event.home, 'data'));
  const runDirectory = realpathSync(dirname(path));
  const local = relative(data, runDirectory);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) ||
    realpathSync(path) !== join(runDirectory, 'ticket-delivery.json')) throw fail();
  const run = z.object({ taskId: z.string(), featureTaskId: z.string().optional(), database: absolute, runDirectory: absolute })
    .parse(parseStrictJson(readFileSync(join(runDirectory, 'run.json'), 'utf8')));
  if ((run.featureTaskId && run.featureTaskId !== event.task_id) || realpathSync(run.database) !== store.databasePath ||
    realpathSync(run.runDirectory) !== runDirectory) throw fail();
  const { delivery, intent } = readTicketDelivery(path, join(runDirectory, 'ticket-intent.md'));
  const target = repositoryIdentity(event.project);
  if (delivery.taskId !== event.task_id || event.branch !== delivery.branch || event.base_branch || event.raw_command ||
    repositoryIdentity(delivery.repository) !== target) throw fail();
  const rows = store.records(projectId);
  const history = store.history(projectId);
  const mappings = currentTaskMappings(rows).filter((mapping) => mapping.featureTaskId === event.task_id);
  const review = store.get(projectId, `${run.taskId}-aggregate-review`);
  if (review?.kind !== 'product_review' || review.outcome !== 'passed' || !review.conformance ||
    (delivery.review && (delivery.review.id !== review.id || delivery.review.revision !== review.revision)) ||
    !mappings.length || mappings.some((mapping) => mapping.feature?.id !== review.feature?.id) ||
    !review.reviewedArtifacts.some((artifact) => artifact.revision === delivery.commit && repositoryIdentity(artifact.uri) === target) ||
    !validateReviewForCompletion(history, review).ok) throw fail();
  const ticket = review.conformance.currentTicket;
  const manifest = z.object({ requestId: z.string() }).parse(parseStrictJson(readFileSync(join(runDirectory, 'planned.json'), 'utf8')));
  if ((ticket && ticket.id !== event.task_id) || intent !== reviewedTicketIntent(history, review, manifest.requestId) ||
    (delivery.reviewNotes ?? '') !== reviewedTicketNotes(history, review)) throw fail();
  for (const reference of review.assignments) {
    const assignment = store.get(projectId, reference.id, reference.revision);
    if (assignment?.kind !== 'assignment' || !mappings.some((mapping) => mapping.firstMateTaskId === assignment.firstMateTaskId) ||
      assignment.returnLocation !== join(runDirectory, 'tasks', assignment.firstMateTaskId, 'worker-return.json')) throw fail();
  }
  const helper = fileURLToPath(new URL('../../scripts/ticket-validation.mjs', import.meta.url));
  const candidate = readFileSync(event.brief_path, 'utf8');
  if (createHash('sha256').update(candidate).digest('hex') !== event.brief_sha256 || candidate.split(source).length !== 2 ||
    !source.includes(ticketDeliveryStartCommand(helper, path, delivery))) throw fail();
  verifyTicketBranch(delivery);
  return true;
}

/** Lookup is operator-configured home + canonical task mapping, never metadata
 * from a worker-supplied brief. Missing managed context fails closed. */
function startingAssignment(config: z.infer<typeof WorkerHookConfigSchema>, event: z.infer<typeof EventSchema>) {
  const project = factoryProject(config, event.home, event.project);
  if (!project) return null;
  const store = new ProjectStore(project.database, { readOnly: true });
  try {
    const records = store.records(project.projectId);
    const mapping = records.filter(record => record.kind === 'task_mapping' && record.firstMateTaskId === event.task_id && !record.legacy);
    if (mapping.length !== 1) {
      if (!mapping.length && checkTicketDeliveryWorker(store, project.projectId, event)) return { project, ticketDelivery: true as const };
      throw new Error('hook_factory_task_requires_mapping');
    }
    const assignments = currentAssignmentAttempts(records, record => record.firstMateTaskId === event.task_id);
    if (assignments.length !== 1) throw new Error('hook_managed_assignment_missing_or_ambiguous');
    return { project, assignment: assignments[0]! };
  } finally { store.close(); }
}

export function checkStartingWorker(configInput: unknown, eventInput: unknown, admission?: { snapshot?: FleetSnapshot; snapshotExecutable?: string }) {
  const config = WorkerHookConfigSchema.parse(configInput);
  const event = EventSchema.parse(eventInput); // Additive FirstMate fields allowed.
  const match = startingAssignment(config, event);
  if (!match) return { ok: true, managed: false };
  if (match.ticketDelivery) return { ok: true, managed: true };
  const { project, assignment } = match;
  if (!event.brief_path || !event.source_brief_path || !event.brief_sha256) throw new Error('hook_candidate_missing');
  const store = new ProjectStore(project.database, { readOnly: true });
  try {
    const report = checkWorkerBrief(store, project.projectId, assignment, event.brief_path,
      parseStrictJson(readFileSync(project.agentConfig, 'utf8')),
      { sourceBriefPath: event.source_brief_path, sha256: event.brief_sha256 });
    if (report.ok && admission && event.kind !== 'scout') checkBuilderAdmission(store.records(project.projectId), assignment,
      admission.snapshot ?? readFleetSnapshot({ fmHome: event.home, snapshotExecutable: admission.snapshotExecutable }), event.project, event.project_capacity ?? undefined);
    const current = startingAssignment(config, event);
    if (!current || current.ticketDelivery || current.project.database !== project.database || current.project.projectId !== project.projectId ||
      current.assignment.id !== assignment.id || current.assignment.revision !== assignment.revision) {
      throw new Error('hook_managed_assignment_changed');
    }
    return { ...report, managed: true };
  } finally { store.close(); }
}


/** Preflight the configured native hook through the same checker used at dispatch.
 * This does not replace the native hook's check of FirstMate's final overlay. */
export function checkConfiguredWorkerStart(store: ProjectStore, projectId: string, taskId: string, home: string, registryPath: string,
  briefPath: string, repository?: string) {
  const registryBytes = readFileSync(registryPath, 'utf8');
  const registry = WorkerHookConfigSchema.parse(parseStrictJson(registryBytes));
  if (!registry.projects.some((entry) => entry.projectId === projectId && realpathSync(entry.home) === realpathSync(home) &&
    realpathSync(entry.database) === store.databasePath)) throw new Error('worker_start_registry_context_mismatch');
  const executable = fileURLToPath(new URL('../../scripts/worker-start-before.mjs', import.meta.url));
  const settingsPath = join(home, 'config', 'hooks.json');
  const settingsBytes = readFileSync(settingsPath, 'utf8');
  const settings = z.object({ version: z.literal(1), hooks: z.array(z.object({ event: z.string(), argv: z.array(z.string()) })) })
    .parse(parseStrictJson(settingsBytes));
  if (!settings.hooks.some((hook) => hook.event === 'worker.start.before' &&
    JSON.stringify(hook.argv) === JSON.stringify([executable, registryPath]))) throw new Error('required_worker_start_hook_not_configured');
  const checked = checkStartingWorker(registry, { version: 1, event: 'worker.start.before', home, task_id: taskId, project: repository ?? (() => {
      const project = store.get(projectId, projectId);
      if (project?.kind !== 'project' || !project.repositories[0]) throw new Error('hook_project_repository_unavailable');
      return project.repositories[0].uri;
    })(),
    source_brief_path: briefPath, brief_path: briefPath, brief_sha256: createHash('sha256').update(readFileSync(briefPath)).digest('hex') });
  if (readFileSync(registryPath, 'utf8') !== registryBytes || readFileSync(settingsPath, 'utf8') !== settingsBytes) {
    throw new Error('worker_start_configuration_changed_during_judgment');
  }
  return checked;
}
