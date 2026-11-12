import type { GuidanceRevision } from './records.js';
import type { ProjectStore } from './store.js';
import type { LearningIdentity } from './learning-contracts.js';
import { LearningScheduleSchema } from './learning-contracts.js';
import { guidanceForContext } from './learning-context.js';
import { nextLearningWindow } from './learning-schedule.js';

export function learningView(store: ProjectStore, projectId: string, schedule: unknown, now: string) {
  const history = store.history(projectId);
  const records = store.records(projectId);
  const selections = [{ label: 'Project/default context', featureId: undefined },
    ...records.filter((record) => record.kind === 'feature_revision').map((feature) => ({ label: `Feature ${feature.id}`, featureId: feature.id }))]
    .map((context) => ({ ...context, guidance: guidanceForContext(history, context.featureId) }));
  const active = [...new Map(selections.flatMap((context) => context.guidance).map((record) => [record.id, record])).values()];
  const observations = records.filter((record) => record.kind === 'observation');
  const guidance = history.filter((record) => record.kind === 'guidance_revision').map((record) => ({ record,
    replacements: history.filter((candidate) => candidate.kind === 'guidance_revision' && (
      candidate.id === record.id && candidate.revision === record.revision + 1 ||
      candidate.supersededGuidance.some((target) => target.id === record.id && target.revision === record.revision))),
    active: active.some((candidate) => candidate.id === record.id && candidate.revision === record.revision),
    contexts: selections.filter((context) => context.guidance.some((candidate) => candidate.id === record.id && candidate.revision === record.revision)).map((context) => context.label),
  }));
  const runs = records.filter((record) => record.kind === 'learning_run').sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id));
  const lastRun = runs.at(-1);
  const receipt = lastRun && store.exportProject(projectId).receipts.find((entry) => entry.result.records.some((target) => target.id === lastRun.id && target.revision === lastRun.revision));
  const after = receipt?.result.records.flatMap((target) => {
    const record = history.find((candidate) => candidate.id === target.id && candidate.revision === target.revision);
    return record?.kind === 'guidance_revision' ? [record] : [];
  });
  const parsed = schedule === undefined ? undefined : LearningScheduleSchema.parse(schedule);
  const project = records.find((record) => record.kind === 'project');
  const scheduleMatches = parsed && parsed.projectId === projectId && project?.kind === 'project' && parsed.timezone === project.timezone;
  const identities: LearningIdentity[] = records.flatMap((record) =>
    (record.kind === 'guidance_revision' || record.kind === 'observation') && record.learning ?
      [{ scope: record.learning.scope, topic: record.learning.topic }] : []);
  return { pending: observations.filter((record) => record.consolidationState === 'pending'),
    conflicts: observations.filter((record) => record.consolidationState === 'conflict'),
    guidanceConflicts: records.filter((record): record is GuidanceRevision => record.kind === 'guidance_revision' && record.unresolvedConflicts.length > 0),
    active, guidance, lastRun, after,
    before: lastRun?.guidance.flatMap((target) => {
      const record = history.find((candidate) => candidate.id === target.id && candidate.revision === target.revision);
      return record?.kind === 'guidance_revision' ? [record] : [];
    }),
    nextWindow: scheduleMatches ? nextLearningWindow(parsed, now) : null,
    scheduleState: parsed ? scheduleMatches ? 'Configured windows (schedule installation is external)' : 'Unknown — schedule does not match this project and timezone' : 'Unknown — no consolidation schedule supplied',
    identities: [...new Map(identities.map((identity) => [JSON.stringify(identity), identity])).values()],
  };
}
