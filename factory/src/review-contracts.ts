import { z } from 'zod';
import { ArtifactSchema, IdSchema, RefSchema, TextSchema, TimestampSchema, type Ref } from './primitives.js';
import { WorkflowAgentProfileSchema } from './agent-profiles.js';

export const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const QualityResultSchema = z.strictObject({
  tool: z.literal('roborev'), commit: CommitSchema, jobId: z.number().int().positive(),
  verdict: z.enum(['passed', 'failed', 'uncertain']), artifact: ArtifactSchema,
  observedAt: TimestampSchema, raw: TextSchema,
  scopeDigest: TextSchema.optional(),
});
export type QualityResult = z.infer<typeof QualityResultSchema>;
export const ReviewQuoteSchema = z.strictObject({
  source: z.enum(['original_request', 'design', 'plan', 'task', 'instructions', 'delivery', 'worker_return']),
  text: TextSchema,
});
export const ReviewTicketSchema = z.strictObject({
  id: IdSchema, text: z.string().refine((text) => text.trim().length > 0),
});
export type ReviewTicket = z.infer<typeof ReviewTicketSchema>;
const checkState = z.enum(['passed', 'failed', 'uncertain']);
export const ProductVerdictSchema = z.strictObject({
  sourceComparison: checkState, instructionFidelity: checkState, planConformance: checkState,
  criteria: z.array(z.strictObject({
    criterion: RefSchema.nullable(), state: z.enum(['accomplished', 'failed', 'uncertain', 'out_of_scope']),
    behavior: TextSchema, quotes: z.array(ReviewQuoteSchema).min(1), limitations: z.array(TextSchema),
  })).min(1),
  findings: z.array(z.strictObject({
    check: z.enum(['sourceComparison', 'instructionFidelity', 'planConformance']),
    type: z.enum(['missing_behavior', 'wrong_implementation', 'original_request_omission', 'narrowed_generality', 'instruction_mismatch', 'unrequested_addition']),
    message: TextSchema, quotes: z.array(ReviewQuoteSchema).min(1),
  })),
  suggestions: z.array(TextSchema), unresolvedQuestions: z.array(TextSchema),
}).refine((value) => value.findings.every((finding) => value[finding.check] !== 'passed'),
  'A finding cannot accompany a passing comparison')
  .refine((value) => (['sourceComparison', 'instructionFidelity', 'planConformance'] as const).every((check) =>
    value[check] !== 'failed' || value.findings.some((finding) => finding.check === check)), 'Failed comparisons need findings');
export type ProductVerdict = z.infer<typeof ProductVerdictSchema>;
export const DeliveredFileSchema = z.strictObject({
  path: TextSchema, text: z.string(), artifact: ArtifactSchema, sizeBytes: z.number().int().positive().optional(),
}).refine((file) => file.sizeBytes === undefined || file.text === '', 'Binary snapshots carry no file text');
export const ProductConformanceSchema = z.strictObject({
  inputDigest: TextSchema, profile: WorkflowAgentProfileSchema, sessionId: TextSchema,
  currentTicket: ReviewTicketSchema.optional(),
  verdict: ProductVerdictSchema.nullable(), error: TextSchema.optional(),
  deliveredFiles: z.array(DeliveredFileSchema).min(1), technicalReviews: z.array(QualityResultSchema),
  qualityError: TextSchema.optional(),
  deliveries: z.array(z.strictObject({
    assignment: RefSchema, detailedPlanTask: RefSchema, artifact: ArtifactSchema,
    repository: TextSchema.optional(), technicalReviewIndexes: z.array(z.number().int().nonnegative()).optional(),
    results: z.array(RefSchema), fileArtifacts: z.array(ArtifactSchema).min(1),
  })).optional(),
});

/** Maintenance contributes a null outcome even when other assignments name criteria. */
export function expectedReviewCriteria(groups: readonly (readonly Ref[])[]): (Ref | null)[] {
  const expected: (Ref | null)[] = [];
  for (const group of groups) for (const criterion of group.length ? group : [null]) {
    if (!expected.some((existing) => existing === null || criterion === null ? existing === criterion :
      existing.id === criterion.id && existing.revision === criterion.revision)) expected.push(criterion);
  }
  return expected;
}
