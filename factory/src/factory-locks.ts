import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ProjectStore } from './store.js';
import type { Assignment, FactoryRecord, TaskMapping } from './records.js';
import type { FleetSnapshot } from './runtime.js';
import { currentAssignmentAttempts, taskReadinessReasons } from './task-readiness.js';
import { validateAssignmentForDispatch, validateReviewForCompletion } from './rules.js';
import { assertNoOwnerQuestions } from './owner-questions.js';
import { parseStrictJson } from './strict-json.js';

const absolute = z.string().min(1).refine(isAbsolute, 'Absolute path required');
export const FactoryProjectsSchema = z.strictObject({
  version: z.literal(1), projects: z.array(z.strictObject({
    home: absolute, projectId: z.string().min(1), database: absolute, agentConfig: absolute,
  })),
});

/** Compare native repository context with stored project repositories. Git common
 * directories identify worktree aliases; forge identity also identifies clones. */
export function repositoryIdentity(input: string): string {
  let remote = input.startsWith('git:') && !input.startsWith('git://') ? input.slice(4) : input;
  if (remote.startsWith('file:')) remote = new URL(remote).pathname;
  if (isAbsolute(remote)) {
    const directory = realpathSync(remote);
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try { remote = git('remote', 'get-url', 'origin'); }
    catch { return `local:${realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'))}`; }
  }
  if (!remote.includes('://')) remote = remote.replace(/^(?:[^@]+@)?([^:]+):(.+)$/u, 'ssh://$1/$2');
  const url = new URL(remote);
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || url.password || url.search || url.hash) throw new Error('factory_repository_identity_unavailable');
  const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  if (!path) throw new Error('factory_repository_identity_unavailable');
  return `${url.host.toLowerCase()}/${url.hostname === 'github.com' ? path.toLowerCase() : path}`;
}
export function factoryProject(config: unknown, home: string, repository: string, mergeTaskId?: string) {
  const registry = FactoryProjectsSchema.parse(config);
  const target = repositoryIdentity(repository);
  const matches = [];
  for (const binding of registry.projects.filter(entry => realpathSync(entry.home) === realpathSync(home))) {
    if (!existsSync(binding.database)) throw new Error(`hook_database_unavailable: ${binding.database}`);
    const store = new ProjectStore(binding.database, { readOnly: true });
    try {
      const project = store.get(binding.projectId, binding.projectId);
      if (project?.kind !== 'project' || realpathSync(project.firstMateHomeRef) !== realpathSync(home)) throw new Error('hook_project_context_unavailable');
      const identities = project.repositories.map(source => repositoryIdentity(source.uri));
      if (!identities.length) throw new Error('hook_project_repository_unavailable');
      if (project.integration?.state === 'disabled') continue;
      // A trusted native task already mapped here cannot become unmanaged when
      // its repository changes. Unmapped factory targets still require mapping.
      if (mergeTaskId && store.records(binding.projectId).some(record => record.kind === 'task_mapping' &&
        (record.firstMateTaskId === mergeTaskId || record.featureTaskId === mergeTaskId)) && !identities.includes(target)) {
        throw new Error('factory_repository_context_mismatch');
      }
      if (!identities.includes(target)) continue;
      if (project.integration?.state === 'reconciling') throw new Error('hook_project_requires_reconciliation');
      matches.push(binding);
    } finally { store.close(); }
  }
  if (matches.length > 1) throw new Error('hook_project_context_ambiguous');
  return matches[0] ?? null;
}

/** Native backlog `order` is the owner's order, not ID/creation/array order.
 * The native spawn task-set lock covers this check through record publication.
 * Runtime done releases a builder even without a PR; endpoint loss does not. */
export function checkBuilderAdmission(records: FactoryRecord[], assignment: Assignment, snapshot: FleetSnapshot, repository: string, capacity?: number) {
  const target = repositoryIdentity(repository);
  const mappings = records.filter(record => record.kind === 'task_mapping');
  const rows = snapshot.backlog.records.filter(row => row.id !== null);
  const candidate = rows.find(row => row.id === assignment.firstMateTaskId);
  const mapping = mappings.find(record => record.firstMateTaskId === assignment.firstMateTaskId);
  if (!candidate || !mapping || typeof candidate.order !== 'number') throw new Error('factory_owner_order_unavailable');
  const done = new Set(snapshot.tasks.filter(task => task.spawn_gen && task.current_state.freshness === 'fresh' &&
    task.current_state.observed_at === snapshot.generated && task.current_state.state === 'done').map(task => task.id));
  if (snapshot.tasks.some(task => task.id !== assignment.firstMateTaskId && !task.project &&
    task.kind !== 'scout' && task.kind !== 'secondmate')) throw new Error('factory_builder_inventory_incomplete');
  const occupants = snapshot.tasks.filter(task => task.id !== assignment.firstMateTaskId && task.project &&
    repositoryIdentity(task.project) === target && task.kind !== 'scout' && task.kind !== 'secondmate' && !done.has(task.id));
  // An in-flight native builder without metadata is unknown, not a free place.
  if (rows.some(row => row.id !== assignment.firstMateTaskId && row.state === 'in_flight' && row.kind === 'ship' &&
    (row.repo === candidate.repo || mappings.some(mapping => mapping.firstMateTaskId === row.id)) &&
    !snapshot.tasks.some(task => task.id === row.id))) throw new Error('factory_builder_inventory_incomplete');
  if (capacity !== undefined && occupants.length >= capacity) throw new Error(`factory_deferred: project capacity ${capacity} builders running (${occupants.map(task => task.id).join(', ')})`);
  const blocked = (row: typeof candidate) => !!row.hold_reason ||
    Array.isArray(row.unresolved_blocker_ids) && row.unresolved_blocker_ids.length > 0 ||
    Array.isArray(row.blocked_by_ids) && row.blocked_by_ids.some(id => !done.has(String(id)) && !rows.some(row => row.id === id && row.state === 'done'));
  if (blocked(candidate)) throw new Error('factory_deferred: native ticket is held or blocked');
  const order = (taskId: string, parent?: string) => {
    const row = rows.find(row => row.id === (parent ?? taskId));
    if (typeof row?.order !== 'number') throw new Error('factory_owner_order_unavailable');
    return row.order;
  };
  const candidateOrder = order(mapping.firstMateTaskId, mapping.featureTaskId);
  for (const earlier of mappings) {
    if (earlier.firstMateTaskId === assignment.firstMateTaskId || done.has(earlier.firstMateTaskId) ||
      snapshot.tasks.some(task => task.id === earlier.firstMateTaskId && !done.has(task.id))) continue;
    const row = rows.find(row => row.id === earlier.firstMateTaskId);
    if (!row || row.state === 'done' || row.kind === 'scout' || row.kind === 'feature' || blocked(row) ||
      taskReadinessReasons(records, earlier).length) continue;
    const attempts = currentAssignmentAttempts(records, record => record.firstMateTaskId === earlier.firstMateTaskId);
    if (attempts.length !== 1 || !validateAssignmentForDispatch(records, attempts[0]!).ok) continue;
    const earlierOrder = order(earlier.firstMateTaskId, earlier.featureTaskId);
    if (earlierOrder < candidateOrder || earlierOrder === candidateOrder && Number(row.order) < Number(candidate.order)) {
      throw new Error(`factory_deferred: earlier eligible ticket ${earlier.firstMateTaskId}`);
    }
  }
  return { builders: occupants.length, order: candidateOrder };
}

/** Eligibility only. Existing forge checks, owner holds and head pin still apply. */
export function checkFactoryMerge(config: unknown, home: string, repository: string, taskId: string, head: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) throw new Error('factory_merge_requires_exact_head');
  const project = factoryProject(config, home, repository, taskId);
  if (!project) return { ok: true, managed: false };
  const store = new ProjectStore(project.database, { readOnly: true });
  try {
    const records = store.history(project.projectId);
    const current = store.records(project.projectId);
    const mappings = current.filter((record): record is TaskMapping => record.kind === 'task_mapping' && !record.legacy &&
      (record.firstMateTaskId === taskId || record.featureTaskId === taskId));
    const features = [...new Set(mappings.flatMap(mapping => mapping.feature ? [mapping.feature.id] : []))];
    if (features.length !== 1) throw new Error('factory_merge_ticket_missing_or_ambiguous');
    assertNoOwnerQuestions(records, features[0]!);
    const target = repositoryIdentity(repository);
    const review = current.find(record => record.kind === 'product_review' && record.feature?.id === features[0] &&
      record.outcome === 'passed' && record.conformance?.deliveries?.length &&
      record.conformance.deliveries.every(delivery => delivery.artifact.revision === head &&
        repositoryIdentity(delivery.repository ?? delivery.artifact.uri) === target) &&
      record.reviewedArtifacts.some(artifact => artifact.revision === head && repositoryIdentity(artifact.uri) === target) &&
      validateReviewForCompletion(records, record).ok);
    if (!review) throw new Error(`factory_merge_requires_passing_product_review_for_head: ${head}`);
    return { ok: true, managed: true, review: { id: review.id, revision: review.revision } };
  } finally { store.close(); }
}

export function requireFactoryStartHook(config: unknown, registryPath: string, home: string, repository: string, executable: string) {
  if (!factoryProject(config, home, repository)) return;
  const settings = z.object({ version: z.literal(1), hooks: z.array(z.object({ event: z.string(), argv: z.array(z.string()) })) })
    .parse(parseStrictJson(readFileSync(join(home, 'config/hooks.json'), 'utf8')));
  if (!settings.hooks.some(hook => hook.event === 'worker.start.before' &&
    JSON.stringify(hook.argv) === JSON.stringify([executable, registryPath]))) throw new Error('required_worker_start_hook_not_configured');
}
