import { z } from 'zod';
import { IdSchema, TextSchema, TimestampSchema } from './primitives.js';

// Only the JSON mutation shapes exercised by BUILD-01 02a/02b/02c/02g/02h are claimed here.
// In particular, tasks-axi `show` and fm-crew-state are text, not these JSON objects.
export const FirstMateTaskSchema = z.strictObject({
  id: IdSchema, title: TextSchema, state: z.enum(['queued', 'in_flight', 'done']),
  kind: TextSchema, repo: TextSchema.nullable(), priority: z.null(),
  created: z.iso.date(), closed: z.iso.date().nullable(),
  deps: z.array(z.strictObject({ type: z.literal('blocked-by'), id: IdSchema })),
  hold: z.strictObject({ reason: TextSchema, kind: TextSchema, until: z.null() }).nullable(),
  links: z.array(z.strictObject({ kind: TextSchema, url: TextSchema })),
  body: z.string().nullable(), blocked: z.boolean(), blocked_by: z.array(IdSchema), held: z.boolean(),
});
export const FirstMateTaskMutationSchema = z.strictObject({
  ok: z.literal(true), action: z.enum(['add', 'hold', 'start', 'done']), task: FirstMateTaskSchema,
  pruned: z.number().int().nonnegative().optional(),
});
export const FirstMateInboxNoteSchema = z.strictObject({
  schema: z.literal('fm-inbox-note.v1'), outcome: z.enum(['created', 'replay']),
  id: IdSchema, request_id: IdSchema, saved: z.boolean(), announced: z.boolean(),
  acknowledged: z.boolean(), path: TextSchema,
});

// A lossless observation envelope owned by the toolkit, NOT a fabricated FirstMate result.
export const ExecutionObservationSchema = z.strictObject({
  firstMateTaskId: IdSchema, raw: TextSchema, observedAt: TimestampSchema,
  sampleRef: TextSchema,
}).refine((value) => /^state: [^\r\n]+$/u.test(value.raw), 'Expected one FirstMate state line');

export type ExecutionObservation = z.infer<typeof ExecutionObservationSchema>;

/** Unknown/failed state text never implies successful execution or product completion. */
export function executionStateToken(input: unknown): string {
  const observation = ExecutionObservationSchema.parse(input);
  return observation.raw.slice('state: '.length).split(' · ')[0]!.trim();
}
