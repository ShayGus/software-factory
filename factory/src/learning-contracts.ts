import { z } from 'zod';
import { IdSchema, RefSchema, TextSchema, TimestampSchema } from './primitives.js';

export const LearningInputKindSchema = z.enum(['inferred', 'standing_instruction', 'local_correction', 'operational']);
export const LearningCaptureReasonSchema = z.enum(['stow', 'compaction', 'correction', 'direct']);
export const LearningScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('feature'), featureId: IdSchema }),
]);
export const LearningIdentitySchema = z.strictObject({ scope: LearningScopeSchema, topic: IdSchema });
export const LegacySectionSchema = z.strictObject({
  uri: TextSchema, heading: TextSchema, before: TextSchema, digest: TextSchema,
});
export const LegacyReplacementSchema = LegacySectionSchema.omit({ before: true }).extend({ observation: RefSchema });
export const LearningDecisionSchema = z.strictObject({
  groupId: IdSchema, outcome: z.enum(['update', 'supersede', 'add', 'conflict', 'no_rule']),
  text: TextSchema.nullable(), rationale: TextSchema,
  observationRefs: z.array(RefSchema).min(1), guidanceRefs: z.array(RefSchema),
});
export const LearningVerdictSchema = z.strictObject({ decisions: z.array(LearningDecisionSchema) });
export const LearningScheduleSchema = z.strictObject({
  id: IdSchema, projectId: IdSchema, timezone: TextSchema.refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Unknown timezone'),
  hours: z.array(z.number().int().min(0).max(23)).min(1).max(2)
    .refine((hours) => new Set(hours).size === hours.length, 'Hours must be distinct'),
  startsAt: TimestampSchema,
});
export type LearningIdentity = z.infer<typeof LearningIdentitySchema>;
