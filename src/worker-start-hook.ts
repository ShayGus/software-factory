import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { checkWorkerBrief } from './briefs.js';
import { ProjectStore } from './store.js';
import { currentAssignmentAttempts } from './task-readiness.js';
import { parseStrictJson } from './strict-json.js';

const absolute = z.string().min(1).refine(isAbsolute, 'Absolute path required');
export const WorkerHookConfigSchema = z.strictObject({
  version: z.literal(1), projects: z.array(z.strictObject({
    home: absolute, projectId: z.string().min(1), database: absolute, agentConfig: absolute,
  })),
});
const EventSchema = z.object({ version: z.literal(1), event: z.literal('worker.start.before'),
  home: absolute, task_id: z.string().min(1),
  source_brief_path: absolute.nullable(), brief_path: absolute.nullable(),
  brief_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
});

/** Lookup is operator-configured home + canonical task mapping, never metadata
 * from a worker-supplied brief. Missing managed context fails closed. */
export function checkStartingWorker(configInput: unknown, eventInput: unknown) {
  const config = WorkerHookConfigSchema.parse(configInput);
  const event = EventSchema.parse(eventInput); // Additive FirstMate fields allowed.
  const matches = [];
  const home = realpathSync(event.home);
  for (const project of config.projects.filter((entry) => realpathSync(entry.home) === home)) {
    if (!existsSync(project.database)) throw new Error(`hook_database_unavailable: ${project.database}`);
    const store = new ProjectStore(project.database, { readOnly: true });
    try {
      const identity = store.get(project.projectId, project.projectId);
      if (identity?.kind !== 'project' || identity.id !== project.projectId || identity.projectId !== project.projectId) {
        throw new Error(`hook_project_context_unavailable: ${project.projectId}`);
      }
      if (identity.integration?.state === 'disabled') continue;
      const records = store.records(project.projectId);
      const mapping = records.filter((record) => record.kind === 'task_mapping' && record.firstMateTaskId === event.task_id);
      // Resolve task-wide attempt currency before checking the selected attempt
      // against its managed mapping. Do not fall back to a historical match if
      // the current attempt conflicts with that mapping; dispatch rules reject it.
      const assignments = currentAssignmentAttempts(records, (record) => record.firstMateTaskId === event.task_id);
      if (mapping.length || assignments.length) {
        if (identity.integration?.state === 'reconciling') throw new Error('hook_project_requires_reconciliation');
        matches.push({ project, assignments });
      }
    } finally { store.close(); }
  }
  if (!matches.length) return { ok: true, managed: false };
  if (matches.length !== 1 || matches[0]!.assignments.length !== 1) throw new Error('hook_managed_assignment_missing_or_ambiguous');
  const { project, assignments } = matches[0]!;
  const assignment = assignments[0]!;
  if (!event.brief_path || !event.source_brief_path || !event.brief_sha256) throw new Error('hook_candidate_missing');
  const store = new ProjectStore(project.database, { readOnly: true });
  try {
    return { ...checkWorkerBrief(store, project.projectId, assignment, event.brief_path,
      parseStrictJson(readFileSync(project.agentConfig, 'utf8')),
      { sourceBriefPath: event.source_brief_path, sha256: event.brief_sha256 }), managed: true };
  } finally { store.close(); }
}


/** Preflight the configured native hook through the same checker used at dispatch.
 * This does not replace the native hook's check of FirstMate's final overlay. */
export function checkConfiguredWorkerStart(store: ProjectStore, projectId: string, taskId: string, home: string, registryPath: string,
  briefPath: string) {
  const registry = WorkerHookConfigSchema.parse(parseStrictJson(readFileSync(registryPath, 'utf8')));
  if (!registry.projects.some((entry) => entry.projectId === projectId && realpathSync(entry.home) === realpathSync(home) &&
    realpathSync(entry.database) === store.databasePath)) throw new Error('worker_start_registry_context_mismatch');
  const executable = fileURLToPath(new URL('../../scripts/worker-start-before.mjs', import.meta.url));
  const settings = z.object({ version: z.literal(1), hooks: z.array(z.object({ event: z.string(), argv: z.array(z.string()) })) })
    .parse(parseStrictJson(readFileSync(join(home, 'config', 'hooks.json'), 'utf8')));
  if (!settings.hooks.some((hook) => hook.event === 'worker.start.before' &&
    JSON.stringify(hook.argv) === JSON.stringify([executable, registryPath]))) throw new Error('required_worker_start_hook_not_configured');
  return checkStartingWorker(registry, { version: 1, event: 'worker.start.before', home, task_id: taskId,
    source_brief_path: briefPath, brief_path: briefPath, brief_sha256: createHash('sha256').update(readFileSync(briefPath)).digest('hex') });
}
