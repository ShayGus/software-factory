import { z } from 'zod';
import { IdSchema, TextSchema, TimestampSchema } from './primitives.js';

// BUILD-01 mutation samples, extended using installed tasks-axi 0.2.6's
// confirm/taskToJson and crud/state mutation contracts. `show` remains text.
export const FirstMateTaskSchema = z.strictObject({
  id: IdSchema, title: TextSchema, state: z.enum(['queued', 'in_flight', 'done']),
  kind: TextSchema.nullable(), repo: TextSchema.nullable(), priority: z.number().int().min(0).max(4).nullable(),
  created: z.iso.date().nullable(), closed: z.iso.date().nullable(),
  deps: z.array(z.strictObject({ type: z.enum(['blocked-by', 'parent', 'discovered-from']), id: IdSchema,
    reason: TextSchema.optional() })),
  hold: z.strictObject({ reason: TextSchema, kind: TextSchema.nullable(), until: z.iso.date().nullable() }).nullable(),
  links: z.array(z.strictObject({ kind: TextSchema, url: TextSchema })),
  body: z.string().nullable(), blocked: z.boolean(), blocked_by: z.array(IdSchema), held: z.boolean(),
});
export const FirstMateTaskMutationSchema = z.strictObject({
  ok: z.literal(true), action: z.enum(['add', 'update', 'hold', 'unhold', 'block', 'unblock', 'start', 'done']), task: FirstMateTaskSchema,
  already: z.literal(true).optional(), changed: z.array(TextSchema).optional(), blocked_by: IdSchema.optional(),
  pruned: z.number().int().nonnegative().optional(),
});
export type FirstMateTask = z.infer<typeof FirstMateTaskSchema>;

/** tasks-axi 0.2.6 `show --full` is TOON, not JSON. Decode only its flat
 * detail contract. Unknown layouts fail closed rather than imply absence. */
export function parseFirstMateTaskDetail(raw: string): FirstMateTask {
  const lines = raw.trimEnd().split('\n');
  if (lines.shift() !== 'task:') throw new Error('Unsupported tasks-axi show layout');
  const fields: Record<string, string | number> = {};
  for (const line of lines) {
    if (!line.startsWith('  ') || line.startsWith('  - ')) break;
    const match = /^  ([a-z_]+): (.*)$/u.exec(line);
    if (!match || match[1]! in fields) throw new Error('Invalid task detail field');
    const value: unknown = match[2]!.startsWith('"') ? JSON.parse(match[2]!) : match[2]!;
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid task detail scalar');
    fields[match[1]!] = value;
  }
  const required = ['id', 'title', 'state', 'blocked', 'blocked_by', 'held', 'hold_reason', 'hold_kind',
    'hold_until', 'kind', 'repo', 'priority', 'created', 'closed', 'deps', 'links', 'body'];
  if (Object.keys(fields).length !== required.length || required.some((key) => !(key in fields))) {
    throw new Error('Incomplete task detail');
  }
  const flag = (key: string) => {
    if (!['yes', 'no'].includes(String(fields[key]))) throw new Error('Invalid task detail boolean');
    return fields[key] === 'yes';
  };
  const nullable = (key: string) => fields[key] === '-' ? null : fields[key];
  const deps = fields.deps === 'none' ? [] : String(fields.deps).split(',').map((edge) => {
    const split = edge.indexOf(':');
    if (split < 0) throw new Error('Invalid dependency detail');
    return { type: edge.slice(0, split), id: edge.slice(split + 1) };
  });
  return FirstMateTaskSchema.parse({ id: fields.id, title: fields.title, state: fields.state,
    kind: fields.kind, repo: nullable('repo'), priority: fields.priority === '-' ? null : Number(fields.priority),
    created: nullable('created'), closed: nullable('closed'), deps,
    // Links are irrelevant to task mutations; retain their typed projection.
    links: fields.links === 'none' ? [] : String(fields.links).split(',').map((link) => {
      const split = link.indexOf(':'); return { kind: link.slice(0, split), url: link.slice(split + 1) };
    }),
    hold: fields.hold_reason === '-' && !flag('held') && nullable('hold_kind') === null && nullable('hold_until') === null ?
      null : { reason: fields.hold_reason, kind: nullable('hold_kind'), until: nullable('hold_until') },
    body: fields.body === '' ? null : fields.body, blocked: flag('blocked'), held: flag('held'),
    blocked_by: fields.blocked_by === 'none' ? [] : String(fields.blocked_by).split(','),
  });
}
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

/** Installed fm-task-inbox.v1 record contract. A synthetic terminator removes
 * exactly one newline; legacy unterminated records retain every message byte. */
export function parseFirstMateInboxBody(raw: string): string {
  const separator = raw.indexOf('\n--\n');
  if (separator < 0) throw new Error('unsupported_inbox_record');
  const headers = raw.slice(0, separator).split('\n');
  if (headers[0] !== 'schema=fm-task-inbox.v1') throw new Error('unsupported_inbox_schema');
  const terminators = headers.filter((line) => line.startsWith('body-terminator='));
  if (terminators.length > 1 || terminators.some((line) => line !== 'body-terminator=1')) throw new Error('invalid_inbox_terminator');
  let body = raw.slice(separator + '\n--\n'.length);
  if (terminators.length) {
    if (!body.endsWith('\n')) throw new Error('inbox_terminator_missing');
    body = body.slice(0, -1);
  }
  return body;
}
