import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ArtifactSchema, EvidenceSchema, IdSchema, RefSchema, TextSchema, TimestampSchema, type Ref } from './primitives.js';
import { WorkflowAgentProfileSchema } from './agent-profiles.js';
import { parseStrictJson } from './strict-json.js';

export const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const FindingDispositionSchema = z.enum(['blocking', 'note']);
export const QualityReviewerSchema = z.enum(['code', 'scope']);
export const ClassifiedFindingSchema = z.strictObject({
  disposition: FindingDispositionSchema, message: TextSchema,
});
export const QualityReviewOutputSchema = z.strictObject({
  verdict: z.enum(['pass', 'fail', 'unable_to_review']), findings: z.array(ClassifiedFindingSchema),
}).refine((result) => result.verdict === 'unable_to_review' ||
  (result.verdict === 'fail') === result.findings.some((finding) => finding.disposition === 'blocking'));
export type QualityReviewer = z.infer<typeof QualityReviewerSchema>;
export type ClassifiedFinding = z.infer<typeof ClassifiedFindingSchema>;
export const findingDirections = 'Classify every finding as blocking or note. Block only on a concrete bug, a security problem, or a violated requirement from the confirmed definition of done. Explain which of those applies and cite the exact requirement for a definition-of-done blocker. Record other observations, including optional improvements and harmless extras, as notes.';
const TechnicalFindingSchema = z.strictObject({
  severity: TextSchema, location: TextSchema, problem: TextSchema, fix: TextSchema,
});
const TechnicalFindingsSchema = z.array(TechnicalFindingSchema).min(1);
const ScopeFindingsSchema = z.array(TextSchema).min(1);
export const QualityResultSchema = z.strictObject({
  tool: z.literal('roborev'), commit: CommitSchema, jobId: z.number().int().positive(),
  verdict: z.enum(['passed', 'failed', 'uncertain']), artifact: ArtifactSchema,
  observedAt: TimestampSchema, raw: TextSchema,
  scopeDigest: TextSchema.optional(),
  reviewer: QualityReviewerSchema.optional(),
  advisoryAcceptance: z.strictObject({
    approval: EvidenceSchema, findings: z.union([TechnicalFindingsSchema, ScopeFindingsSchema]),
  }).optional(),
});
export type QualityResult = z.infer<typeof QualityResultSchema>;

/** A failed tool verdict remains intact. An exact, recorded acceptance can
 * make all its findings advisory for the reviewed commit. */
export function technicalReviewSatisfied(result: QualityResult): boolean {
  if (result.verdict === 'passed') return true;
  const accepted = result.advisoryAcceptance;
  if (result.verdict !== 'failed' || !accepted || !accepted.approval.artifact.digest ||
    accepted.approval.artifact.revision !== result.commit ||
    result.artifact.digest !== `sha256:${createHash('sha256').update(result.raw).digest('hex')}`) return false;
  try {
    const receipt = parseStrictJson(result.raw);
    if (result.reviewer) return false;
    if (result.scopeDigest !== undefined) {
      const scope = z.object({ job_id: z.literal(result.jobId), prompt_digest: z.literal(result.scopeDigest), output: z.string(),
        job: z.object({ id: z.literal(result.jobId), git_ref: z.literal(`factory-scope-${result.scopeDigest.slice(-16)}`),
          status: z.literal('done'), job_type: z.literal('task') }) }).parse(receipt);
      const output = z.object({ verdict: z.literal('fail'), findings: ScopeFindingsSchema }).parse(parseStrictJson(scope.output));
      return result.artifact.revision === result.commit &&
        JSON.stringify(output.findings.sort()) === JSON.stringify(ScopeFindingsSchema.parse(accepted.findings).sort());
    }
    const raw = z.object({ job_id: z.number(), job: z.object({ id: z.number(), git_ref: CommitSchema,
      status: z.literal('done'), job_type: z.literal('review') }),
      structured_output: z.object({ verdict: z.literal('fail'), findings: TechnicalFindingsSchema }),
    }).parse(receipt);
    const findings = (items: z.infer<typeof TechnicalFindingsSchema>) => items.map(({ severity, location, problem, fix }) =>
      JSON.stringify([severity, location, problem, fix])).sort();
    return raw.job_id === result.jobId && raw.job.id === result.jobId && raw.job.git_ref === result.commit &&
      JSON.stringify(findings(raw.structured_output.findings)) === JSON.stringify(findings(TechnicalFindingsSchema.parse(accepted.findings)));
  } catch { return false; }
}
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
  })),
  findings: z.array(z.strictObject({
    check: z.enum(['sourceComparison', 'instructionFidelity', 'planConformance']),
    type: z.enum(['missing_behavior', 'wrong_implementation', 'original_request_omission', 'narrowed_generality', 'instruction_mismatch', 'unrequested_addition']),
    message: TextSchema, quotes: z.array(ReviewQuoteSchema).min(1), disposition: FindingDispositionSchema.optional(),
  })),
  suggestions: z.array(TextSchema), unresolvedQuestions: z.array(TextSchema),
}).refine((value) => value.findings.every((finding) => finding.disposition === 'note' || value[finding.check] !== 'passed'),
  'A blocking finding cannot accompany a passing comparison')
  .refine((value) => (['sourceComparison', 'instructionFidelity', 'planConformance'] as const).every((check) =>
    value[check] !== 'failed' || value.findings.some((finding) => finding.check === check && finding.disposition !== 'note')),
  'Failed comparisons need blocking findings');
export type ProductVerdict = z.infer<typeof ProductVerdictSchema>;
export const DeliveredFileSchema = z.strictObject({
  path: TextSchema, text: z.string(), artifact: ArtifactSchema, sizeBytes: z.number().int().positive().optional(),
}).refine((file) => file.sizeBytes === undefined || file.text === '', 'Binary snapshots carry no file text');
export const ProductConformanceSchema = z.strictObject({
  inputDigest: TextSchema, profile: WorkflowAgentProfileSchema, sessionId: TextSchema,
  currentTicket: ReviewTicketSchema.optional(),
  previousRound: RefSchema.optional(),
  verdict: ProductVerdictSchema.nullable(), error: TextSchema.optional(),
  reusedProductReview: RefSchema.optional(),
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
