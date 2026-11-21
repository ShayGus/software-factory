import type { FactoryRecord, DecisionChange } from './records.js';

/** Ticket-wide questions include questions omitted from a design's decision list.
 * Read current revisions so an answer/reopened question changes the same gate. */
export function unansweredOwnerQuestions(history: FactoryRecord[], featureId: string) {
  const current = new Map<string, FactoryRecord>();
  for (const record of history) if (record.revision > (current.get(record.id)?.revision ?? 0)) current.set(record.id, record);
  const records = [...current.values()];
  const feature = records.find(record => record.id === featureId);
  const related = new Set([featureId, ...(feature?.kind === 'feature_revision' ?
    [...feature.sourceRequests, ...feature.criteria].map(ref => ref.id) : [])]);
  for (const record of records) if ('feature' in record && record.feature?.id === featureId) related.add(record.id);
  return records.filter((record): record is DecisionChange => record.kind === 'decision_change' && record.choice?.kind === 'product' &&
    record.choice.state === 'open' && (record.affectedRecords.some(ref => related.has(ref.id)) ||
      feature?.kind === 'feature_revision' && feature.decisions.some(ref => ref.id === record.id)));
}
export function assertNoOwnerQuestions(records: FactoryRecord[], featureId: string) {
  const open = unansweredOwnerQuestions(records, featureId);
  if (open.length) throw new Error(`ticket_awaiting_owner: ${open.map(record => `${record.id}@${record.revision}`).join(', ')}`);
}
