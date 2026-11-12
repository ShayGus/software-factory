import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EvidenceSchema } from './primitives.js';
import { ref, stableId } from './intake.js';
import { type FactoryRecord, type Project, TaskMappingSchema } from './records.js';
import { readFleetSnapshot, RuntimeAdapterSchema, type RuntimeAdapter } from './runtime.js';
import { ProjectExportSchema, ProjectStore, StoreError } from './store.js';
import { TaskWrapper, TaskAdapterOptionsSchema, type TaskAdapterOptions } from './tasks.js';
import { taskReadinessReasons } from './task-readiness.js';

const sha = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function projectRecord(store: ProjectStore, projectId: string): Project {
  const project = store.get(projectId, projectId);
  if (project?.kind !== 'project') throw new StoreError('not_found', 'project_not_found');
  return project;
}
function saveProject(store: ProjectStore, project: Project, integration: NonNullable<Project['integration']>, extra: FactoryRecord[] = []) {
  const at = new Date().toISOString(); const id = randomUUID();
  const decision = { kind: 'decision_change' as const, id, projectId: project.id, schemaVersion: 1 as const,
    revision: 1, createdAt: at, updatedAt: at, questionOrChange: 'Project integration recovery', affectedRecords: [ref(project)],
    rationale: JSON.stringify(integration), disposition: 'selected' as const,
    sourceRefs: [{ uri: 'factory:project-integration' }], scopeChanges: [] };
  const next = { ...project, revision: project.revision + 1, updatedAt: at, integration };
  store.mutate({ schemaVersion: 1, id, projectId: project.id, issuedAt: at, idempotencyKey: id,
    command: 'record_decision_suggestion', targetId: project.id, expectedRevision: project.revision, payload: { decision } }, () => [decision, next, ...extra]);
  return next;
}

/** Disable intent is committed before any handback writes. Repeating handback
 * converges by exact ownership markers, even after a lost unhold result. */
export function disableProject(store: ProjectStore, projectId: string, mode: 'pause' | 'hand_back', input?: TaskAdapterOptions) {
  if (!['pause', 'hand_back'].includes(mode)) throw new Error('disable_mode_required');
  const options = input && TaskAdapterOptionsSchema.parse(input);
  if (mode === 'hand_back' && !options) throw new Error('handback_requires_task_adapter');
  return store.withTaskLock(projectId, () => {
    const project = projectRecord(store, projectId);
    const records = store.records(projectId);
    const mappings = records.filter((record) => record.kind === 'task_mapping');
    const conditions = [...new Set(mappings.flatMap((mapping) => taskReadinessReasons(records, mapping)
      .map((reason) => `${mapping.firstMateTaskId}: ${reason}`)))];
    const at = new Date().toISOString();
    saveProject(store, project, { ...project.integration, state: 'disabled', disableMode: mode,
      outstandingConditions: conditions }, store.operations(projectId).filter((operation) => operation.state !== 'succeeded' && !operation.suspended)
      .map((operation) => ({ ...operation, revision: operation.revision + 1, updatedAt: at,
        suspended: { at, reason: `Project disabled (${mode}); requires a new explicit intent` } })));
    const errors: { taskId: string; error: string }[] = [];
    if (mode === 'hand_back') {
      const wrapper = new TaskWrapper(options!);
      for (const mapping of mappings) {
        if (!mapping.management) continue;
        try {
          const task = wrapper.read(mapping.firstMateTaskId);
          if (!task) continue;
          if (task.hold?.reason === mapping.management.holdReason && task.hold.until === null) {
            wrapper.write(['unhold', task.id], (value) => value.hold === null);
          }
          const guard = options!.guardTaskId;
          if (guard && mapping.management.managedDependencies.includes(guard) && task.deps.some((edge) => edge.type === 'blocked-by' && edge.id === guard)) {
            wrapper.write(['unblock', task.id, '--by', guard], (value) => !value.deps.some((edge) => edge.type === 'blocked-by' && edge.id === guard));
          }
        } catch (error) { errors.push({ taskId: mapping.firstMateTaskId, error: String(error) }); }
      }
    }
    return { state: 'disabled' as const, mode, outstandingConditions: conditions, errors };
  });
}

/** Read both supported observational interfaces before lifting a restore/disable
 * gate. Retired operations remain retired; only fresh explicit intents can run. */
export function reconcileProject(store: ProjectStore, projectId: string, input: TaskAdapterOptions & RuntimeAdapter, enable = true) {
  const runtime = RuntimeAdapterSchema.parse({ fmHome: input.fmHome,
    ...(input.snapshotExecutable ? { snapshotExecutable: input.snapshotExecutable } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxObservationAgeMs ? { maxObservationAgeMs: input.maxObservationAgeMs } : {}) });
  const options = TaskAdapterOptionsSchema.parse(input);
  return store.withTaskLock(projectId, () => {
    let project = projectRecord(store, projectId);
    project = saveProject(store, project, { ...project.integration, state: 'reconciling',
      outstandingConditions: project.integration?.outstandingConditions ?? [] });
    const artifacts = project.integration?.restoredArtifacts ?? [];
    const issues = [...inspectArtifacts(artifacts), ...(project.integration?.restoredUnresolvedReferences ?? []).map((path) => ({ path, issue: 'unresolved_reference' as const }))];
    if (issues.length) return { state: 'reconciling' as const, artifacts: issues };
    const snapshot = readFleetSnapshot(runtime);
    const wrapper = new TaskWrapper(options);
    const ids = new Set(store.records(projectId).filter((record) => record.kind === 'task_mapping' || record.kind === 'assignment')
      .map((record) => record.kind === 'task_mapping' || record.kind === 'assignment' ? record.firstMateTaskId : ''));
    for (const operation of store.operations(projectId)) if (operation.externalAttempt) ids.add(operation.externalAttempt.firstMateTaskId);
    const tasks = [...ids].map((id) => ({ id, task: wrapper.read(id) ?? null }));
    const state = enable ? 'enabled' : project.integration?.resumeAfterRestore ?? 'enabled';
    const { restoredArtifacts: _retiredGate, restoredUnresolvedReferences: _retiredUnresolved, ...integration } = project.integration!;
    saveProject(store, project, { ...integration, state,
      outstandingConditions: project.integration?.outstandingConditions ?? [], observation: JSON.stringify({ snapshot, tasks, verifiedRestoreArtifacts: artifacts }) });
    return { state, snapshot, tasks, suspended: store.operations(projectId).filter((operation) => operation.suspended).map(ref) };
  });
}

/** Existing tasks remain an unverified projection. Linking only changes references,
 * never creates criterion results, assignments or reviews for historical work. */
export function importLegacyTasks(store: ProjectStore, projectId: string, input: RuntimeAdapter) {
  return store.withTaskLock(projectId, () => {
    const snapshot = readFleetSnapshot(input);
    const records = store.records(projectId);
    const at = new Date().toISOString();
    const mappings = snapshot.backlog.records.filter((task) => task.id !== null && !records.some((record) => record.kind === 'task_mapping' && record.firstMateTaskId === task.id))
      .map((task) => TaskMappingSchema.parse({ kind: 'task_mapping', id: stableId('legacy-task', projectId, task.id!), projectId,
        schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at, firstMateTaskId: task.id,
        feature: null, criteria: [], detailedPlanTask: null, dependencies: [], legacy: true, disposition: { state: 'active' },
        importedExecution: { observedAt: snapshot.generated, state: typeof task.state === 'string' ? task.state : 'unknown', verification: 'unverified' } }));
    const project = projectRecord(store, projectId);
    if (mappings.length || snapshot.backlog.records.some((task) => task.structured === false)) saveProject(store, project,
      { ...(project.integration ?? { state: 'enabled', outstandingConditions: [] }), observation: JSON.stringify({ snapshot }) }, mappings);
    return { mappings, omissions: snapshot.backlog.records.filter((task) => task.structured === false) };
  });
}

const localPath = (uri: string, base?: string, unresolved?: Set<string>) => {
  if (isAbsolute(uri)) return resolve(uri);
  if (uri.startsWith('file:')) return fileURLToPath(uri);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri)) return undefined;
  if (base) return resolve(base, uri);
  unresolved?.add(uri); return undefined;
};
function referencedArtifacts(value: unknown, found = new Map<string, string[]>(), base?: string, unresolved?: Set<string>) {
  if (Array.isArray(value)) for (const item of value) referencedArtifacts(item, found, base, unresolved);
  else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.uri === 'string') {
      const path = localPath(object.uri, base, unresolved);
      if (path) {
        const digest = typeof object.digest === 'string' ? object.digest : undefined;
        const prior = found.get(path) ?? [];
        found.set(path, [...new Set([...prior, ...(digest ? [digest] : [])])]);
      }
    }
    // Saved brief and return locations are local artifacts too.
    for (const [key, item] of Object.entries(object)) {
      if (['path', 'briefPath', 'sidecarPath'].includes(key) && typeof item === 'string' && isAbsolute(item)) {
        const expected = key === 'sidecarPath' && typeof object.sidecarDigest === 'string' && object.sidecarDigest.startsWith('sha256:') ? [object.sidecarDigest] : [];
        found.set(item, [...new Set([...(found.get(item) ?? []), ...expected])]);
      }
      referencedArtifacts(item, found, base, unresolved);
    }
  }
  return found;
}
const BackupArtifactSchema = z.strictObject({ path: z.string().refine(isAbsolute), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
  expectedDigests: z.array(z.string()).optional(), content: z.string().nullable(), issue: z.enum(['missing', 'changed']).optional() });
export const ProjectBackupSchema = z.strictObject({ schema: z.literal('software-factory-backup.v1'),
  exportedAt: z.iso.datetime(), project: ProjectExportSchema, projectDigest: z.string(), artifactBase: z.string().refine(isAbsolute).optional(), unresolvedReferences: z.array(z.string()).default([]), excludedDirectories: z.array(z.string().refine(isAbsolute)), artifacts: z.array(BackupArtifactSchema) });
export type ProjectBackup = z.infer<typeof ProjectBackupSchema>;
/** A self-contained export with bytes and digests. No live SQLite file copying. */
export function backupProject(store: ProjectStore, projectId: string, artifactBase?: string): ProjectBackup {
  return store.withTaskLock(projectId, () => {
    const project = store.exportProject(projectId);
    const base = artifactBase ?? projectRecord(store, projectId).integration?.artifactBase;
    if (base && !isAbsolute(base)) throw new Error('absolute_artifact_base_required');
    const unresolved = new Set<string>();
    const excludedDirectories: string[] = [];
    const artifacts = [...referencedArtifacts(project, undefined, base, unresolved)].filter(([path, expectedDigests]) => {
      try {
        if (statSync(path).isDirectory() && !expectedDigests.length) { excludedDirectories.push(path); return false; }
        return true;
      }
      catch { return true; }
    }).map(([path, expectedDigests]) => {
      try {
        const content = readFileSync(path); const digest = sha(content);
        return { path, digest, content: content.toString('base64'), ...(expectedDigests.length ? { expectedDigests } : {}),
          ...(expectedDigests.some((expected) => expected !== digest) ? { issue: 'changed' as const } : {}) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { path, digest: null, content: null, ...(expectedDigests.length ? { expectedDigests } : {}), issue: 'missing' as const };
      }
    });
    if (sha(JSON.stringify(project)) !== sha(JSON.stringify(store.exportProject(projectId)))) throw new Error('project_changed_during_backup_retry');
    return ProjectBackupSchema.parse({ schema: 'software-factory-backup.v1', exportedAt: new Date().toISOString(), project,
      projectDigest: sha(JSON.stringify(project)), ...(base ? { artifactBase: base } : {}), unresolvedReferences: [...unresolved], excludedDirectories, artifacts });
  });
}
function inspectArtifacts(artifacts: { path: string; digest: string | null }[]) {
  return artifacts.flatMap<{ path: string; issue: 'missing' | 'changed' | 'verification_required' }>(({ path, digest }) => {
    try {
      const actual = sha(readFileSync(path));
      return digest === null ? [{ path, issue: 'verification_required' as const }] : actual === digest ? [] : [{ path, issue: 'changed' as const }];
    }
    catch { return [{ path, issue: 'missing' as const }]; }
  });
}
export function verifyRestoredArtifact(store: ProjectStore, input: unknown) {
  const data = z.strictObject({ projectId: z.string().min(1), path: z.string().refine(isAbsolute),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), evidence: z.array(EvidenceSchema).min(1) }).parse(input);
  return store.withTaskLock(data.projectId, () => {
    const project = projectRecord(store, data.projectId);
    const artifact = project.integration?.restoredArtifacts?.find((entry) => entry.path === data.path);
    if (project.integration?.state !== 'reconciling' || !artifact || artifact.digest !== null) throw new Error('artifact_not_awaiting_verification');
    if (sha(readFileSync(data.path)) !== data.digest) throw new Error('supplied_artifact_digest_mismatch');
    const next = saveProject(store, project, { ...project.integration,
      restoredArtifacts: project.integration.restoredArtifacts!.map((entry) => entry.path === data.path ? { ...entry, digest: data.digest } : entry),
      observation: JSON.stringify({ verifiedSuppliedArtifact: data }) });
    return { project: ref(next), path: data.path, digest: data.digest };
  });
}

/** Explicitly verify one imported relative source and record its source base.
 * Neither history nor the original source URI is rewritten. */
export function resolveRestoredReference(store: ProjectStore, input: unknown) {
  const data = z.strictObject({ projectId: z.string().min(1), reference: z.string().min(1),
    base: z.string().refine(isAbsolute), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    evidence: z.array(EvidenceSchema).min(1) }).parse(input);
  return store.withTaskLock(data.projectId, () => {
    const project = projectRecord(store, data.projectId); const integration = project.integration;
    if (integration?.state !== 'reconciling' || !integration.restoredUnresolvedReferences?.includes(data.reference)) {
      throw new Error('reference_not_awaiting_resolution');
    }
    if (integration.artifactBase && resolve(integration.artifactBase) !== resolve(data.base)) throw new Error('recorded_artifact_base_conflict');
    const path = localPath(data.reference, data.base);
    if (!path || sha(readFileSync(path)) !== data.digest) throw new Error('resolved_reference_digest_mismatch');
    const artifacts = integration.restoredArtifacts ?? [];
    const existing = artifacts.find((entry) => entry.path === path);
    if (existing?.digest && existing.digest !== data.digest) throw new Error('resolved_reference_identity_conflict');
    const next = saveProject(store, project, { ...integration, artifactBase: resolve(data.base),
      restoredUnresolvedReferences: integration.restoredUnresolvedReferences.filter((reference) => reference !== data.reference),
      restoredArtifacts: [...artifacts.filter((entry) => entry.path !== path), { path, digest: data.digest }],
      observation: JSON.stringify({ resolvedReference: { ...data, path } }) });
    return { project: ref(next), reference: data.reference, path, digest: data.digest };
  });
}

function contained(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Restore references at their original paths within an explicit artifact root.
 * Existing changed files are reported, never overwritten. Live replay stays gated. */
export function restoreProjectBackup(store: ProjectStore, input: unknown, artifactRoot: string) {
  const backup = ProjectBackupSchema.parse(input);
  if (!isAbsolute(artifactRoot)) throw new Error('absolute_artifact_root_required');
  const root = realpathSync(artifactRoot);
  if (backup.projectDigest !== sha(JSON.stringify(backup.project))) throw new Error('backup_project_digest_mismatch');
  const paths = new Set<string>();
  for (const artifact of backup.artifacts) {
    if (paths.has(artifact.path)) throw new Error('duplicate_backup_artifact');
    paths.add(artifact.path);
    if (artifact.content !== null && (artifact.digest === null || sha(Buffer.from(artifact.content, 'base64')) !== artifact.digest)) {
      throw new Error(`backup_artifact_digest_mismatch: ${artifact.path}`);
    }
  }
  const unresolved = new Set<string>();
  const required = referencedArtifacts(backup.project, undefined, backup.artifactBase, unresolved);
  for (const [path, digests] of required) {
    const artifact = backup.artifacts.find((entry) => entry.path === path);
    if (!artifact) {
      if (!digests.length && backup.excludedDirectories.includes(path)) continue;
      throw new Error(`backup_manifest_missing_artifact: ${path}`);
    }
    if (JSON.stringify(artifact.expectedDigests ?? []) !== JSON.stringify(digests)) throw new Error(`backup_artifact_reference_mismatch: ${path}`);
  }
  // Import first validates the whole closed history and receipts. Gate is atomic
  // with the imported records, so a crash before file restoration cannot replay.
  store.importProject(backup.project, { requireReconciliation: true, unresolvedReferences: [...unresolved],
    ...(backup.artifactBase ? { artifactBase: backup.artifactBase } : {}),
    restoredArtifacts: backup.artifacts.map(({ path, digest, expectedDigests }) => ({ path, digest: expectedDigests?.at(-1) ?? digest })) });
  const issues: { path: string; issue: string }[] = [...unresolved].map((path) => ({ path, issue: 'unresolved_reference' }));
  for (const artifact of backup.artifacts) {
    if (artifact.issue) issues.push({ path: artifact.path, issue: artifact.issue });
    if (!contained(root, artifact.path)) { issues.push({ path: artifact.path, issue: 'outside_artifact_root' }); continue; }
    try {
      // Reject symlink parents which would write outside the authorized root.
      let parent = dirname(artifact.path);
      while (!existsSync(parent)) parent = dirname(parent);
      if (realpathSync(parent) !== root && !contained(root, realpathSync(parent))) throw new Error('symlink_outside_artifact_root');
      if (existsSync(artifact.path)) {
        if (artifact.digest !== sha(readFileSync(artifact.path))) issues.push({ path: artifact.path, issue: 'changed' });
      } else if (artifact.content !== null) {
        mkdirSync(dirname(artifact.path), { recursive: true });
        writeFileSync(artifact.path, Buffer.from(artifact.content, 'base64'), { flag: 'wx' });
      } else issues.push({ path: artifact.path, issue: 'missing' });
    } catch (error) { issues.push({ path: artifact.path, issue: String(error) }); }
  }
  return { state: 'reconciling' as const, artifacts: issues };
}
