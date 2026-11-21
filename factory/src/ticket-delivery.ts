import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { TicketDeliverySchema } from './review-contracts.js';
import { digestText, requiredAssignmentContext } from './instruction-context.js';
import { planningRecord, samePlanningRef } from './planning-checks.js';
import { deliveryReviewFindings } from './product-review.js';
import type { FactoryRecord, ProductReview } from './records.js';
import { parseStrictJson } from './strict-json.js';

const absolute = z.string().refine(isAbsolute);
const ValidationHandoffSchema = TicketDeliverySchema.partial({ review: true }).extend({
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), mode: z.literal('no-mistakes'), repository: absolute,
  intentFile: absolute, intentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});

export function readTicketDelivery(path: string, expectedIntentFile?: string) {
  const delivery = ValidationHandoffSchema.parse(parseStrictJson(readFileSync(path, 'utf8')));
  if (delivery.branch !== `fm/ticket/${delivery.taskId}`) throw new Error('Factory ticket branch does not match its ticket ID.');
  if (expectedIntentFile && realpathSync(delivery.intentFile) !== expectedIntentFile) throw new Error('Factory ticket intent is outside the reviewed run.');
  const intent = readFileSync(delivery.intentFile, 'utf8');
  if (!intent.trim() || digestText(intent) !== delivery.intentDigest) throw new Error('Factory ticket intent is empty or changed. Read back the reviewed handoff.');
  return { delivery, intent };
}

export function verifyTicketBranch(delivery: ReturnType<typeof readTicketDelivery>['delivery']) {
  const head = execFileSync('git', ['-C', delivery.repository, 'rev-parse', '--verify', `refs/heads/${delivery.branch}`],
    { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (head !== delivery.commit) throw new Error('Factory ticket branch moved after review.');
}

export function reviewedTicketIntent(records: FactoryRecord[], review: ProductReview, requestId: string): string {
  const requestRef = review.originalRequests.find((request) => request.id === requestId);
  const request = requestRef && planningRecord(records, requestRef);
  if (request?.kind !== 'request') throw new Error('ticket_intent_requires_reviewed_request');
  const ticketText = review.conformance?.currentTicket?.text ?? request.originalText;
  const ownerAnswers = new Set<string>();
  // A revised backlog ticket supersedes answers carried by the original plan.
  const answerSources = ticketText.trim() === request.originalText.trim() ? review.assignments : [];
  for (const assignmentRef of answerSources) {
    const assignment = planningRecord(records, assignmentRef);
    if (assignment?.kind !== 'assignment') throw new Error('ticket_intent_requires_reviewed_assignment');
    const context = requiredAssignmentContext(records, assignment, assignment.selectedContext);
    for (const decision of context.records) {
      if (decision.kind !== 'decision_change' || decision.choice?.kind !== 'product' || decision.choice.state !== 'resolved') continue;
      if (decision.answer) ownerAnswers.add(`${decision.questionOrChange}\n\n${decision.answer.text}`);
      for (const source of decision.sourceRefs) {
        const captured = source.record && planningRecord(records, source.record);
        if (captured?.kind !== 'request' || captured.id === request.id) continue;
        if (source.excerpt && !captured.originalText.includes(source.excerpt)) throw new Error('ticket_intent_requires_exact_owner_answer');
        ownerAnswers.add(source.excerpt ?? captured.originalText);
      }
    }
  }
  const additional = [...ownerAnswers].filter((answer) => !ticketText.includes(answer.trim()));
  return additional.length ? `${ticketText}\n\n## Recorded owner answers\n\n${additional.join('\n\n')}` : ticketText;
}

export function reviewedTicketNotes(records: FactoryRecord[], review: ProductReview): string {
  const notes = new Set<string>();
  const slices = records.filter((record): record is ProductReview => record.kind === 'product_review' &&
    record.id !== review.id && record.conformance?.deliveries?.length === 1 &&
    isDeepStrictEqual(record.conformance.currentTicket, review.conformance?.currentTicket) &&
    review.conformance?.deliveries?.some((delivery) => {
      const slice = record.conformance!.deliveries![0]!;
      return samePlanningRef(delivery.assignment, slice.assignment) && isDeepStrictEqual(delivery.artifact, slice.artifact);
    }) === true);
  for (const last of [review, ...slices]) {
    let round: ProductReview | undefined = last;
    while (round) {
      for (const { reviewer, message, disposition } of deliveryReviewFindings(round)) {
        if (disposition !== 'note') continue;
        const text = message.replace(/\s+/gu, ' ').trim().replace(/[&<>@]/gu, (char) => `&#${char.charCodeAt(0)};`);
        notes.add(`- **${reviewer}** ${text}`);
      }
      const previous: FactoryRecord | undefined = round.conformance?.previousRound && planningRecord(records, round.conformance.previousRound);
      round = previous?.kind === 'product_review' && previous.id === round.id && previous.revision < round.revision ? previous : undefined;
    }
  }
  return notes.size ? `## Factory review notes\n\n${[...notes].join('\n')}` : '';
}

export const ticketDeliveryMarker = 'Factory ticket delivery: ';

export function ticketDeliveryStartCommand(executable: string, path: string, delivery: ReturnType<typeof readTicketDelivery>['delivery']) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `node ${quote(executable)} start ${quote(path)} ${delivery.commit} ${delivery.intentDigest}`;
}
