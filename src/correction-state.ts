import type { Assignment, FactoryRecord, Observation } from './records.js';

export type TrackedCorrection = Observation & { correction: NonNullable<Observation['correction']> };
export function currentCorrections(records: FactoryRecord[]): TrackedCorrection[] {
  const byId = new Map<string, FactoryRecord>();
  for (const record of records) if (record.revision > (byId.get(record.id)?.revision ?? 0)) byId.set(record.id, record);
  return [...byId.values()].filter((record): record is TrackedCorrection => record.kind === 'observation' && !!record.correction);
}
export function intendedCorrectionRecipient(records: FactoryRecord[], record: TrackedCorrection) {
  const captured = record.correction.intendedRecipient ?? record.correction.deliveryRecipient;
  if (captured) return captured;
  const assignment = records.find((item) => item.kind === 'assignment' && item.id === record.correction.assignment.id &&
    item.revision === record.correction.assignment.revision);
  if (assignment?.kind === 'assignment') return { assignment: record.correction.assignment,
    attemptId: assignment.attemptId, firstMateTaskId: assignment.firstMateTaskId };
  // Legacy current-only snapshots may omit the pinned assignment revision.
  // Preserve task identity when possible; never infer an attempt from that absence.
  const current = records.find((item) => item.kind === 'assignment' && item.id === record.correction.assignment.id);
  return current?.kind === 'assignment' ? { assignment: record.correction.assignment,
    attemptId: '', firstMateTaskId: current.firstMateTaskId } : undefined;
}
export function correctionTargetsAttempt(records: FactoryRecord[], record: TrackedCorrection, assignment: Assignment): boolean {
  const target = intendedCorrectionRecipient(records, record);
  return target?.assignment.id === assignment.id && target.attemptId === assignment.attemptId && target.firstMateTaskId === assignment.firstMateTaskId;
}
export function carriesCorrection(records: FactoryRecord[], record: TrackedCorrection, sourceId: string): boolean {
  const all = new Map(currentCorrections(records).map((item) => [item.id, item]));
  const visited = new Set<string>(); let parent = record.correction.carriedFrom;
  while (parent && !visited.has(parent.id)) {
    if (parent.id === sourceId) return true;
    visited.add(parent.id); parent = all.get(parent.id)?.correction.carriedFrom;
  }
  return false;
}
export const hasCorrectionFact = (record: TrackedCorrection, fact: string) => record.correction.facts.some((item) => item.fact === fact);
const needsIncorporation = (record: TrackedCorrection) => ['clarification', 'amended_scope', 'rewind', 'cancellation'].includes(record.correction.action);

/** Incorporation on a replacement is its own correction record and proof. The
 * original delivery/acknowledgement facts remain historical and immutable. */
export function outstandingTaskCorrections(records: FactoryRecord[], taskId: string): TrackedCorrection[] {
  const all = currentCorrections(records);
  return all.filter((record) => !record.correction.supersededBy && needsIncorporation(record) &&
    intendedCorrectionRecipient(records, record)?.firstMateTaskId === taskId && !hasCorrectionFact(record, 'incorporated') &&
    !all.some((carrier) => hasCorrectionFact(carrier, 'incorporated') && carriesCorrection(records, carrier, record.id)))
    .sort((a, b) => a.correction.assignment.id.localeCompare(b.correction.assignment.id) || a.correction.sequence - b.correction.sequence);
}

export function earlierCorrectionPending(records: FactoryRecord[], record: TrackedCorrection): boolean {
  const all = currentCorrections(records); const target = intendedCorrectionRecipient(records, record);
  return all.some((prior) => prior.correction.assignment.id === record.correction.assignment.id &&
    prior.correction.sequence < record.correction.sequence && !prior.correction.supersededBy &&
    !carriesCorrection(records, record, prior.id) && !hasCorrectionFact(prior, 'delivered') &&
    !all.some((carrier) => hasCorrectionFact(carrier, 'delivered') && carriesCorrection(records, carrier, prior.id) &&
      intendedCorrectionRecipient(records, carrier)?.assignment.id === target?.assignment.id &&
      intendedCorrectionRecipient(records, carrier)?.attemptId === target?.attemptId));
}
