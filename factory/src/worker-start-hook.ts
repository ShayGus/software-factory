import { FactoryProjectsSchema, factoryProject, checkBuilderAdmission } from './factory-locks.js';
import { readFleetSnapshot, type FleetSnapshot } from './runtime.js';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { checkWorkerBrief } from './briefs.js';
import { ProjectStore } from './store.js';
import { currentAssignmentAttempts } from './task-readiness.js';
import { parseStrictJson } from './strict-json.js';

const absolute = z.string().min(1).refine(isAbsolute, 'Absolute path required');
export const WorkerHookConfigSchema = FactoryProjectsSchema;
const EventSchema = z.object({ version: z.literal(1), event: z.literal('worker.start.before'),
  home: absolute, task_id: z.string().min(1), project: absolute, kind: z.string().optional(),
  project_capacity: z.string().regex(/^[1-9][0-9]{0,5}$/u).transform(Number).nullable().optional(),
  source_brief_path: absolute.nullable(), brief_path: absolute.nullable(),
  brief_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
});

/** Lookup is operator-configured home + canonical task mapping, never metadata
 * from a worker-supplied brief. Missing managed context fails closed. */
function startingAssignment(config: z.infer<typeof WorkerHookConfigSchema>, event: z.infer<typeof EventSchema>) {
  const project = factoryProject(config, event.home, event.project);
  if (!project) return null;
  const store = new ProjectStore(project.database, { readOnly: true });
  try {
    const records = store.records(project.projectId);
    const mapping = records.filter(record => record.kind === 'task_mapping' && record.firstMateTaskId === event.task_id && !record.legacy);
    if (mapping.length !== 1) throw new Error('hook_factory_task_requires_mapping');
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
    if (!current || current.project.database !== project.database || current.project.projectId !== project.projectId ||
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
