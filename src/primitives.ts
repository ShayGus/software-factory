import { z } from 'zod';

export const TextSchema = z.string().refine((value) => value.trim().length > 0, 'Must not be blank');
// IDs, including FirstMate IDs, are opaque. Never infer identity from a title or prefix.
export const IdSchema = TextSchema;
export const RevisionSchema = z.number().int().positive();
export const TimestampSchema = z.iso.datetime({ offset: true });
export const RefSchema = z.strictObject({ id: IdSchema, revision: RevisionSchema });
export const SourceRefSchema = z.strictObject({
  uri: TextSchema,
  record: RefSchema.optional(),
  excerpt: TextSchema.optional(),
});
export const ArtifactSchema = z.strictObject({
  uri: TextSchema,
  revision: TextSchema.optional(),
  digest: TextSchema.optional(),
}).refine((value) => value.revision !== undefined || value.digest !== undefined,
  'Artifact needs a stable revision or digest');
export const EvidenceSchema = z.strictObject({
  artifact: ArtifactSchema,
  description: TextSchema,
  observedAt: TimestampSchema,
});

export const FeatureStateSchema = z.enum(['requested', 'planned', 'in_progress', 'in_review', 'complete']);
export const MethodStageSchema = z.enum([
  'understanding', 'design', 'planning', 'ready_for_implementation', 'implementation', 'product_review',
]);
export const CriterionResultStateSchema = z.enum(['passed', 'failed', 'untested', 'blocked']);
export const OperationStateSchema = z.enum(['pending', 'succeeded', 'failed', 'unknown']);
export const CorrectionDeliveryFactSchema = z.enum(['recorded', 'delivered', 'acknowledged', 'incorporated']);
export const CorrectionActionSchema = z.enum([
  'clarification', 'amended_scope', 'rewind', 'resume', 'cancellation', 'new_work', 'status',
]);
export const DispositionStateSchema = z.enum(['active', 'deferred', 'cancelled']);
export const DispositionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('active') }),
  z.strictObject({ state: z.enum(['deferred', 'cancelled']), reason: TextSchema, decision: RefSchema }),
]);
export const RequestDispositionSchema = z.enum([
  'unclassified', 'work', 'clarification', 'deferral', 'duplication', 'non_work_conversation',
]);
export const ClaimStateSchema = z.enum(['checked', 'reported', 'contradicted', 'unknown']);
export const DecisionDispositionSchema = z.enum(['proposed', 'selected', 'rejected', 'deferred', 'cancelled']);
export const ExecutionStrategySchema = z.enum(['focused', 'parallel']);
export const ReviewOutcomeSchema = z.enum(['passed', 'failed', 'incomplete']);
export const ConsolidationStateSchema = z.enum(['pending', 'consolidated', 'no_general_rule', 'conflict']);

// Findings are supplied by source comparison, not inferred from prose by a schema.
export const FindingSchema = z.strictObject({
  criterionId: IdSchema.optional(),
  result: CriterionResultStateSchema,
  description: TextSchema,
  sourceRefs: z.array(SourceRefSchema).min(1),
  evidence: z.array(EvidenceSchema),
  resolvedBy: RefSchema.optional(),
});
export const ComparisonSchema = z.strictObject({
  result: CriterionResultStateSchema,
  sourceRefs: z.array(SourceRefSchema).min(1),
  findings: z.array(FindingSchema),
  reviewerSession: TextSchema,
  comparedAt: TimestampSchema,
}).refine((value) => value.result !== 'passed' || value.findings.every(
  (finding) => finding.result === 'passed' || finding.resolvedBy !== undefined),
  'A passed comparison cannot contain unresolved findings');

export const CommandNameSchema = z.enum([
  'capture_request', 'design_plan_feature', 'record_decision_suggestion', 'map_manage_execution_task',
  'prepare_assignment', 'deliver_correction', 'record_review_result', 'capture_consolidate_learning',
  'read_project_state_export',
]);

export type Ref = z.infer<typeof RefSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Comparison = z.infer<typeof ComparisonSchema>;
export type FeatureState = z.infer<typeof FeatureStateSchema>;
export type MethodStage = z.infer<typeof MethodStageSchema>;
export type CriterionResultState = z.infer<typeof CriterionResultStateSchema>;
export type OperationState = z.infer<typeof OperationStateSchema>;
export type CorrectionDeliveryFact = z.infer<typeof CorrectionDeliveryFactSchema>;
export type CorrectionAction = z.infer<typeof CorrectionActionSchema>;
export type DispositionState = z.infer<typeof DispositionStateSchema>;
export type ClaimState = z.infer<typeof ClaimStateSchema>;
export type DecisionDisposition = z.infer<typeof DecisionDispositionSchema>;
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;
export type CommandName = z.infer<typeof CommandNameSchema>;
