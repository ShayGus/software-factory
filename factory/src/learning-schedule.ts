import { isAbsolute } from 'node:path';
import { LearningScheduleSchema } from './learning-contracts.js';
import { consolidateLearning } from './learning.js';
import { learningDigest } from './learning-context.js';
import { TimestampSchema } from './primitives.js';
import { ProjectStore, StoreError } from './store.js';

/** Latest wall-clock slot in the configured zone. Using the local date/hour as
 * identity coalesces the repeated DST hour; a skipped hour catches up at the next
 * configured slot. No per-missed-window replay loop or resident scheduler. */
export function latestLearningWindow(scheduleInput: unknown, now: string) {
  const schedule = LearningScheduleSchema.parse(scheduleInput);
  const end = Date.parse(TimestampSchema.parse(now));
  const start = Date.parse(schedule.startsAt);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // At least one slot each local day: 72 hours covers timezone/DST transitions.
  for (let instant = Math.floor(end / 60_000) * 60_000; instant >= Math.max(start, end - 72 * 3600_000); instant -= 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    if (parts.minute === '00' && schedule.hours.includes(Number(parts.hour))) return {
      id: `${schedule.id}:${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00[${schedule.timezone}]`,
      scheduledFor: new Date(instant).toISOString(),
    };
  }
  return null;
}

/** Read-only preview using the same local-hour/DST window rules as the runner. */
export function nextLearningWindow(scheduleInput: unknown, now: string) {
  const schedule = LearningScheduleSchema.parse(scheduleInput);
  const end = Date.parse(TimestampSchema.parse(now));
  const start = Math.max(Math.floor(end / 60_000) * 60_000 + 60_000, Math.ceil(Date.parse(schedule.startsAt) / 60_000) * 60_000);
  const previous = latestLearningWindow(schedule, now);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let instant = start; instant <= start + 72 * 3600_000; instant += 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    const id = `${schedule.id}:${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00[${schedule.timezone}]`;
    if (parts.minute === '00' && schedule.hours.includes(Number(parts.hour)) && id !== previous?.id) return { id, scheduledFor: new Date(instant).toISOString() };
  }
  return null;
}

export function runScheduledLearning(store: ProjectStore, scheduleInput: unknown, now: string, agentConfig: unknown) {
  const schedule = LearningScheduleSchema.parse(scheduleInput);
  const project = store.get(schedule.projectId, schedule.projectId);
  if (project?.kind !== 'project' || project.timezone !== schedule.timezone) throw new StoreError('validation', 'learning_schedule_project_timezone_mismatch');
  const window = latestLearningWindow(schedule, now);
  if (!window) return { state: 'not_due' as const };
  const scheduleDigest = learningDigest(JSON.stringify(schedule));
  const runs = store.records(schedule.projectId).filter((record) => record.kind === 'learning_run' && record.scheduleDigest === scheduleDigest);
  if (runs.some((record) => record.kind === 'learning_run' && (record.scheduledWindowId === window.id || Date.parse(record.scheduledFor) >= Date.parse(window.scheduledFor)))) return { state: 'already_succeeded' as const, window };
  const key = learningDigest(JSON.stringify([schedule.projectId, scheduleDigest, window.id]));
  const result = consolidateLearning(store, { projectId: schedule.projectId, id: `learning-run:${key}`,
    idempotencyKey: `learning-window:${key}`, issuedAt: now, scheduledWindowId: window.id, scheduledFor: window.scheduledFor,
    scheduleDigest, timezone: schedule.timezone }, agentConfig);
  return { state: 'succeeded' as const, window, result };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Cronie cron entry only. Caller reviews/installs it through their existing
 * cron mechanism; preparing it never enables or modifies any scheduler. */
export function prepareLearningSchedule(scheduleInput: unknown, paths: {
  node: string; cli: string; db: string; schedule: string; agentConfig: string;
}) {
  const schedule = LearningScheduleSchema.parse(scheduleInput);
  if (!Object.values(paths).every((value) => isAbsolute(value) && !/[\r\n]/u.test(value))) throw new StoreError('validation', 'schedule_paths_must_be_absolute_single_line');
  const command = [paths.node, paths.cli, 'learning-tick', '--db', paths.db, '--schedule', paths.schedule, '--agent-config', paths.agentConfig];
  // Cron interprets percent even inside shell quotes.
  const shellCommand = command.map(quote).join(' ').replaceAll('%', '\\%');
  return { mechanism: 'cron', enabled: false, command,
    entry: `CRON_TZ=${schedule.timezone}\n0 ${[...schedule.hours].sort((a, b) => a - b).join(',')} * * * ${shellCommand}\n` };
}
