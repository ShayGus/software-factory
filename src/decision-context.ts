import type { DecisionChange } from './records.js';

/** Exact wording and immutable affected revisions only; no semantic inference. */
export function reusableAnswer(question: DecisionChange, candidate: DecisionChange) {
  const context = (decision: DecisionChange) => decision.affectedRecords.map(({ id, revision }) => JSON.stringify([id, revision])).sort();
  return candidate.id !== question.id && candidate.choice?.kind === 'product' && candidate.choice.state === 'resolved' &&
    candidate.disposition === 'selected' && candidate.questionOrChange === question.questionOrChange &&
    JSON.stringify(context(candidate)) === JSON.stringify(context(question));
}
