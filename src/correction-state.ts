import type { Assignment, FactoryRecord, Observation } from './records.js';

export type TrackedCorrection = Observation & { correction: NonNullable<Observation['correction']> };
export function currentCorrections(records: FactoryRecord[]): TrackedCorrection[] {
  const byId = new Map<string, FactoryRecord>();
  for (const record of records) if (record.revision > (byId.get(record.id)?.revision ?? 0)) byId.set(record.id, record);
  return [...byId.values()].filter((record): record is TrackedCorrection => record.kind === 'observation' && !!record.correction);
}
export function intendedCorrectionRecipient(records: FactoryRecord[], record: TrackedCorrection) {
  const captured = record.correction.addressedRecipient ?? record.correction.intendedRecipient ?? record.correction.deliveryRecipient;
  if (captured) return captured;
  const assignment = records.find((item) => item.kind === 'assignment' && item.id === record.correction.assignment.id &&
    item.revision === record.correction.assignment.revision);
  if (assignment?.kind === 'assignment') return { assignment: record.correction.assignment,
    attemptId: assignment.attemptId, firstMateTaskId: assignment.firstMateTaskId };
  const current = records.find((item) => item.kind === 'assignment' && item.id === record.correction.assignment.id);
  return current?.kind === 'assignment' ? { assignment: record.correction.assignment,
    attemptId: '', firstMateTaskId: current.firstMateTaskId } : undefined;
}
export function correctionTargetsAttempt(records: FactoryRecord[], record: TrackedCorrection, assignment: Assignment): boolean {
  const target = intendedCorrectionRecipient(records, record);
  return target?.assignment.id === assignment.id && target.attemptId === assignment.attemptId && target.firstMateTaskId === assignment.firstMateTaskId;
}
export const hasCorrectionFact = (record: TrackedCorrection, fact: string) => record.correction.facts.some((item) => item.fact === fact);
export const correctionOrder = (record: TrackedCorrection) => record.correction.taskOrder ?? record.correction.sequence;
export function outstandingTaskCorrections(records: FactoryRecord[], taskId: string): TrackedCorrection[] {
  return currentCorrections(records).filter((record) => !record.correction.supersededBy &&
    ['clarification', 'amended_scope', 'rewind', 'cancellation'].includes(record.correction.action) &&
    intendedCorrectionRecipient(records, record)?.firstMateTaskId === taskId && !hasCorrectionFact(record, 'incorporated'))
    .sort((a, b) => correctionOrder(a) - correctionOrder(b));
}
export function unresolvedTaskCorrections(records: FactoryRecord[], replacement: Assignment) {
  return outstandingTaskCorrections(records, replacement.firstMateTaskId).filter((record) =>
    !correctionTargetsAttempt(records, record, replacement) ||
    (!!record.correction.deliveryHistory?.length && !hasCorrectionFact(record, 'delivered'))).map((record) => ({
      correction: { id: record.id, revision: record.revision }, earlier: correctionTargetsAttempt(records, record, replacement) ?
        record.correction.deliveryHistory?.at(-1)?.recipient ?? intendedCorrectionRecipient(records, record)! : intendedCorrectionRecipient(records, record)!,
      replacement: { assignment: { id: replacement.id, revision: replacement.revision }, attemptId: replacement.attemptId, firstMateTaskId: replacement.firstMateTaskId },
      reason: correctionTargetsAttempt(records, record, replacement) ? 'Re-addressed delivery awaits confirmation' : 'Correction is still addressed to an earlier attempt',
    }));
}
export function correctionDeliverySnapshot(records: FactoryRecord[], record: TrackedCorrection) {
  const recipient = intendedCorrectionRecipient(records, record);
  if (!recipient) throw new Error('correction_recipient_unknown');
  return { assignment: record.correction.assignment, recipient, facts: record.correction.facts,
    ...(record.correction.operationId ? { operationId: record.correction.operationId } : {}),
    ...(record.correction.deliveryRecipient ? { deliveryRecipient: record.correction.deliveryRecipient } : {}),
    ...(record.correction.incorporationAssignment ? { incorporationAssignment: record.correction.incorporationAssignment } : {}) };
}
export function earlierCorrectionPending(records: FactoryRecord[], record: TrackedCorrection): boolean {
  const target = intendedCorrectionRecipient(records, record);
  return currentCorrections(records).some((prior) => prior.id !== record.id &&
    intendedCorrectionRecipient(records, prior)?.firstMateTaskId === target?.firstMateTaskId &&
    correctionOrder(prior) < correctionOrder(record) && !prior.correction.supersededBy && !hasCorrectionFact(prior, 'incorporated') &&
    !(hasCorrectionFact(prior, 'delivered') && intendedCorrectionRecipient(records, prior)?.assignment.id === target?.assignment.id &&
      intendedCorrectionRecipient(records, prior)?.attemptId === target?.attemptId));
}
