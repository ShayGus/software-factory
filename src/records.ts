import { LearningIdentitySchema, LearningInputKindSchema, LearningCaptureReasonSchema, LegacySectionSchema, LegacyReplacementSchema, LearningVerdictSchema } from './learning-contracts.js';
import { z } from 'zod';
import { ProductConformanceSchema } from './review-contracts.js';
import {
  ArtifactSchema, ClaimStateSchema, CommandNameSchema, ComparisonSchema, ConsolidationStateSchema,
  CorrectionActionSchema, CorrectionDeliveryFactSchema, CriterionResultStateSchema,
  DecisionDispositionSchema, DispositionSchema, EvidenceSchema, ExecutionStrategySchema,
  FeatureStateSchema, IdSchema, MethodStageSchema, OperationStateSchema, RefSchema,
  RequestDispositionSchema, ReviewOutcomeSchema, RevisionSchema, SourceRefSchema,
  TextSchema, TimestampSchema,
} from './primitives.js';

function record<K extends string, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.strictObject({
    kind: z.literal(kind), id: IdSchema, projectId: IdSchema, schemaVersion: z.literal(1),
    revision: RevisionSchema, createdAt: TimestampSchema, updatedAt: TimestampSchema, ...shape,
  }).refine((value) => {
    const times = z.object({ createdAt: TimestampSchema, updatedAt: TimestampSchema }).parse(value);
    return Date.parse(times.updatedAt) >= Date.parse(times.createdAt);
  }, 'updatedAt precedes createdAt');
}

export const ProjectSchema = record('project', {
  goal: TextSchema, intendedUser: TextSchema, priorities: z.array(TextSchema),
  exclusions: z.array(TextSchema), vocabulary: z.record(TextSchema, TextSchema),
  repositories: z.array(SourceRefSchema), designRefs: z.array(SourceRefSchema),
  firstMateHomeRef: TextSchema,
  integration: z.strictObject({
    state: z.enum(['enabled', 'disabled', 'reconciling']),
    restoreBackupDigest: TextSchema.optional(),
    resumeAfterRestore: z.enum(['enabled', 'disabled']).optional(),
    disableMode: z.enum(['pause', 'hand_back']).optional(),
    outstandingConditions: z.array(TextSchema),
    observation: z.string().optional(),
    artifactBase: TextSchema.optional(),
    restoredUnresolvedReferences: z.array(TextSchema).optional(),
    restoredArtifacts: z.array(z.strictObject({ path: TextSchema, digest: TextSchema.nullable() })).optional(),
  }).optional(),
  timezone: TextSchema.refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Unknown local timezone'),
});

export const RequestSchema = record('request', {
  originalText: TextSchema, source: SourceRefSchema, channel: TextSchema,
  capturedAt: TimestampSchema, clientRequestId: IdSchema, attachments: z.array(ArtifactSchema),
  interpretationRefs: z.array(RefSchema), disposition: RequestDispositionSchema,
  dispositionRefs: z.array(RefSchema),
});

export const FeatureRevisionSchema = record('feature_revision', {
  outcome: TextSchema, sourceRequests: z.array(RefSchema).min(1), criteria: z.array(RefSchema),
  exclusions: z.array(TextSchema), priority: z.number().int(), decisions: z.array(RefSchema),
  changeReason: TextSchema, previousRevision: RevisionSchema.optional(),
  state: FeatureStateSchema, methodStage: MethodStageSchema, disposition: DispositionSchema,
  completionEvidence: z.strictObject({ review: RefSchema, reason: TextSchema }).optional(),
});

export const CriterionSchema = record('criterion', {
  featureId: IdSchema, expectedBehavior: TextSchema, verificationMethod: TextSchema,
  requirement: z.enum(['required', 'optional']).default('required'),
  sourceRefs: z.array(SourceRefSchema).min(1), disposition: DispositionSchema,
});

// Scope roles are recorded during source comparison; deterministic checks do not
// pretend to infer all intent from natural-language prose.
export const RequestScopeSchema = z.strictObject({
  request: RefSchema, term: TextSchema, role: z.enum(['example', 'required', 'entire_scope']),
});
export const PlannedScopeSchema = z.strictObject({
  request: RefSchema, term: TextSchema, coverage: z.enum(['general', 'example_only', 'required', 'entire_scope']),
});
export const UnderstandingRevisionSchema = record('understanding_revision', {
  feature: RefSchema, sourceRequests: z.array(RefSchema).min(1), criteria: z.array(RefSchema),
  goal: TextSchema, userBehavior: TextSchema, terms: z.record(TextSchema, TextSchema),
  priorities: z.array(TextSchema), examples: z.array(TextSchema), exclusions: z.array(TextSchema),
  existingWork: z.array(z.strictObject({ source: SourceRefSchema, finding: TextSchema })).min(1),
  openUnknowns: z.array(TextSchema), scope: z.array(RequestScopeSchema), changeReason: TextSchema,
});
export const StageRevisionSchema = record('stage_revision', {
  stage: z.enum(['understand', 'design', 'plan', 'detail']), feature: RefSchema,
  sourceRequests: z.array(RefSchema).min(1), criteria: z.array(RefSchema), artifact: RefSchema,
  previousStage: RefSchema.optional(), changeReason: TextSchema,
  reuse: z.strictObject({
    check: ComparisonSchema,
    criterionMap: z.array(z.strictObject({ current: RefSchema, existing: RefSchema })),
  }).optional(),
});
export const ReadinessFindingSchema = z.strictObject({
  code: z.enum(['dropped_behavior', 'example_driven_narrowing', 'invented_scope', 'missing_integration',
    'unresolved_product_decision', 'detail_gap', 'stage_gap', 'source_gap', 'dependency_gap']),
  record: RefSchema, path: TextSchema, message: TextSchema,
});
export const PlanReadinessRevisionSchema = record('plan_readiness_revision', {
  feature: RefSchema, plan: RefSchema, detailStage: RefSchema,
  findings: z.array(ReadinessFindingSchema), ready: z.boolean(),
}).refine((value) => value.ready === (value.findings.length === 0), 'Readiness must agree with findings');

export const DesignRevisionSchema = record('design_revision', {
  sourceRefs: z.array(SourceRefSchema).min(1), feature: RefSchema.nullable(),
  productBehavior: TextSchema, examples: z.array(TextSchema), technicalDesign: TextSchema,
  reuseFindings: z.array(TextSchema).min(1), interfaces: z.array(TextSchema), dataFlow: TextSchema,
  decisions: z.array(RefSchema), alternatives: z.array(TextSchema), testingApproach: TextSchema,
  exclusions: z.array(TextSchema), unresolvedQuestions: z.array(TextSchema),
  sourceComparison: ComparisonSchema,
  workflow: z.strictObject({
    understanding: RefSchema,
    reuse: z.strictObject({ alreadyWorks: TextSchema, gap: TextSchema, change: TextSchema }),
    scope: z.array(PlannedScopeSchema), changeReason: TextSchema,
  }).optional(),
});

export const DependencySchema = z.strictObject({
  prerequisiteTaskId: IdSchema, consumerTaskId: IdSchema, reason: TextSchema,
  needs: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('artifact'), artifact: ArtifactSchema }),
    z.strictObject({ kind: z.literal('criterion'), criterion: RefSchema }),
  ]),
});
export const ImplementationPlanRevisionSchema = record('implementation_plan_revision', {
  feature: RefSchema.nullable(), design: RefSchema, deliverySequence: z.array(RefSchema).min(1),
  strategy: ExecutionStrategySchema, strategyReason: TextSchema, integrationApproach: TextSchema,
  dependencies: z.array(DependencySchema), priorities: z.array(z.strictObject({
    taskId: IdSchema, priority: z.number().int(),
  })),
  readiness: z.strictObject({ ready: z.boolean(), comparison: ComparisonSchema }),
  workflow: z.strictObject({
    slices: z.array(z.strictObject({
      id: IdSchema, behavior: TextSchema, criteria: z.array(RefSchema), tasks: z.array(RefSchema),
      // Feature against which these slice criteria were authored, independently
      // of task retention. Absent on historical plan revisions.
      criteriaFeature: RefSchema.optional(),
    })).min(1),
    scope: z.array(PlannedScopeSchema), integrationSteps: z.array(TextSchema),
    finalVerification: z.array(TextSchema), changeReason: TextSchema,
    retainedTasks: z.array(z.strictObject({ task: RefSchema, reason: TextSchema })),
    readinessCheck: RefSchema.optional(),
  }).optional(),
});

export const DetailedPlanTaskSchema = record('detailed_plan_task', {
  plan: RefSchema, design: RefSchema, feature: RefSchema.nullable(),
  // Drafts retain traceability while their actionable detail is being prepared.
  draft: z.boolean().optional(),
  expectedBehavior: TextSchema.optional(), criteria: z.array(RefSchema),
  maintenanceObjective: TextSchema.optional(), designRefs: z.array(SourceRefSchema).min(1).optional(),
  boundaries: z.array(TextSchema).min(1).optional(), reuseTargets: z.array(SourceRefSchema).optional(),
  inputs: z.array(TextSchema).optional(), outputs: z.array(TextSchema).min(1).optional(),
  blockers: z.array(IdSchema).optional(), verificationCases: z.array(TextSchema).min(1).optional(),
  returnRequirements: z.array(TextSchema).min(1).optional(),
  decisionsToKeep: z.array(RefSchema).optional(), verificationMethod: TextSchema.optional(),
}).refine((value) => value.draft || (value.criteria.length > 0 || value.maintenanceObjective !== undefined),
  'Task needs criteria or an explicit maintenance objective')
  .refine((value) => value.feature !== null || (value.maintenanceObjective !== undefined && value.criteria.length === 0),
    'Standalone maintenance requires an objective and no product criteria')
  .refine((value) => value.draft || ['expectedBehavior', 'designRefs', 'boundaries', 'reuseTargets',
    'inputs', 'outputs', 'blockers', 'verificationCases', 'returnRequirements'].every(
    (field) => value[field as keyof typeof value] !== undefined), 'Non-draft task requires complete legacy detail');

export const TaskMappingSchema = record('task_mapping', {
  firstMateTaskId: IdSchema, feature: RefSchema.nullable(), criteria: z.array(RefSchema),
  detailedPlanTask: RefSchema.nullable(), dependencies: z.array(IdSchema), legacy: z.boolean(),
  disposition: DispositionSchema,
  importedExecution: z.strictObject({ observedAt: TimestampSchema, state: TextSchema,
    verification: z.literal('unverified') }).optional(),
  management: z.strictObject({
    operationId: IdSchema, requirements: z.array(DependencySchema),
    explicitRequirements: z.array(DependencySchema).optional(),
    managedDependencies: z.array(IdSchema),
    readiness: z.array(z.strictObject({ id: IdSchema, reason: TextSchema, evidence: z.array(EvidenceSchema) })),
    paused: z.boolean(),
    // The exact marker is our ownership token. Never clear an unrelated hold.
    holdReason: TextSchema,
  }).optional(),
}).refine((value) => value.legacy || (value.detailedPlanTask !== null &&
  (value.feature !== null || value.criteria.length === 0)),
  'Managed mapping requires a detailed task and a feature for product criteria');

export const SelectedContextSchema = z.strictObject({
  source: SourceRefSchema, artifact: ArtifactSchema.optional(), projectedArtifact: ArtifactSchema.optional(), extract: TextSchema.optional(),
  originalRange: z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
    .refine((range) => range.end > range.start, 'Source range end must follow its start').optional(),
  truncated: z.boolean(),
}).refine((value) => !value.truncated || value.extract !== undefined,
  'Truncated context must retain the supplied extract and reachable source');

export const CorrectionRecipientSchema = z.strictObject({ assignment: RefSchema, attemptId: IdSchema, firstMateTaskId: IdSchema });
export const UnresolvedCorrectionSchema = z.strictObject({ correction: RefSchema,
  earlier: CorrectionRecipientSchema, replacement: CorrectionRecipientSchema, reason: TextSchema });

export const AssignmentSchema = record('assignment', {
  attemptId: IdSchema, feature: RefSchema.nullable(), design: RefSchema, plan: RefSchema,
  detailedPlanTask: RefSchema, firstMateTaskId: IdSchema,
  sourceRefs: z.array(SourceRefSchema).min(1), selectedContext: z.array(SelectedContextSchema).min(1),
  criteria: z.array(RefSchema), prerequisiteArtifacts: z.array(ArtifactSchema), returnLocation: TextSchema,
  instructionText: TextSchema, instructionFidelity: ComparisonSchema,
  correctionContext: z.strictObject({
    feature: RefSchema.nullable(), corrections: z.array(RefSchema).min(1), requiresReplan: z.boolean(),
  }).optional(),
  // Absent on historical assignments. New generated briefs retain the original
  // lifecycle template and identities so a later gate can detect file damage.
  brief: z.strictObject({
    path: TextSchema, sidecarPath: TextSchema, scaffold: TextSchema,
    sidecarDigest: TextSchema,
    materialized: z.strictObject({ brief: TextSchema, sidecar: TextSchema }).optional(),
    preparationFindings: z.array(z.strictObject({ code: TextSchema, path: TextSchema, message: TextSchema })).optional(),
    unresolvedCorrections: z.array(UnresolvedCorrectionSchema).optional(),
  }).optional(),
}).refine((value) => value.feature !== null || value.criteria.length === 0,
  'Standalone maintenance assignments cannot name product criteria');

export const CriterionResultSchema = record('criterion_result', {
  assignment: RefSchema, criterion: RefSchema.nullable(), result: CriterionResultStateSchema,
  accomplishedBehavior: TextSchema, artifact: ArtifactSchema.nullable(),
  evidence: z.array(EvidenceSchema), limitations: z.array(TextSchema), suggestions: z.array(TextSchema),
}).refine((value) => value.result !== 'passed' || (value.artifact !== null && value.evidence.length > 0),
  'Passed result requires a versioned artifact and verification evidence');

export const ProductReviewSchema = record('product_review', {
  originalRequests: z.array(RefSchema).min(1), sourceRefs: z.array(SourceRefSchema).min(1),
  feature: RefSchema.nullable(), design: RefSchema, plan: RefSchema, detailedPlanTasks: z.array(RefSchema).min(1),
  assignments: z.array(RefSchema).min(1), results: z.array(RefSchema),
  reviewedArtifacts: z.array(ArtifactSchema).min(1), technicalReviewRefs: z.array(SourceRefSchema),
  sourceComparison: ComparisonSchema, instructionFidelity: ComparisonSchema, planConformance: ComparisonSchema,
  baselineEvidence: z.array(EvidenceSchema), improvementEvidence: z.array(EvidenceSchema),
  unresolvedQuestions: z.array(TextSchema), outcome: ReviewOutcomeSchema,
  reviewerSession: TextSchema, reviewedAt: TimestampSchema,
  conformance: ProductConformanceSchema.optional(),
});

export const MeasurementClaimSchema = record('measurement_claim', {
  claim: TextSchema, definition: TextSchema, unit: TextSchema, population: TextSchema,
  filters: z.array(TextSchema), inputs: z.array(ArtifactSchema).min(1),
  computationRef: SourceRefSchema, numerator: z.number().finite().optional(),
  denominator: z.number().finite().positive().optional(), observedAt: TimestampSchema,
  state: ClaimStateSchema, correctionOf: RefSchema.optional(), evidence: z.array(EvidenceSchema.extend({
    measurement: z.strictObject({
      method: SourceRefSchema, definition: TextSchema, unit: TextSchema, population: TextSchema,
      filters: z.array(TextSchema), inputs: z.array(ArtifactSchema).min(1),
    }).optional(),
  })),
}).refine((value) => (value.numerator === undefined) === (value.denominator === undefined),
  'Ratio needs both numerator and non-zero denominator')
  .refine((value) => value.state !== 'checked' || value.evidence.some(({ measurement }) => {
    if (!measurement) return false;
    const artifacts = (inputs: typeof value.inputs) => inputs.map(input =>
      JSON.stringify([input.uri, input.revision ?? null, input.digest ?? null])).sort();
    return measurement.method.uri === value.computationRef.uri &&
      measurement.method.excerpt === value.computationRef.excerpt &&
      measurement.method.record?.id === value.computationRef.record?.id &&
      measurement.method.record?.revision === value.computationRef.record?.revision &&
      measurement.definition === value.definition && measurement.unit === value.unit && measurement.population === value.population &&
      JSON.stringify([...measurement.filters].sort()) === JSON.stringify([...value.filters].sort()) &&
      JSON.stringify(artifacts(measurement.inputs)) === JSON.stringify(artifacts(value.inputs));
  }), 'Checked claim requires evidence naming the method, inputs and matching measurement scope');

export const ScopeChangeSchema = z.strictObject({
  featureId: IdSchema, fromRevision: RevisionSchema, toRevision: RevisionSchema,
  criterionId: IdSchema, action: z.enum(['remove', 'demote', 'defer', 'amend']),
});
// Half-open UTF-16 offsets into the immutable captured request. Mapping corrections
// replace links on the current request; the old decisions remain in history.
export const RequestMappingSchema = z.strictObject({
  request: RefSchema, start: z.number().int().nonnegative(), end: z.number().int().positive(),
  disposition: RequestDispositionSchema.exclude(['unclassified']),
  feature: RefSchema.nullable(), criteria: z.array(RefSchema), replaces: z.array(RefSchema),
}).refine((value) => value.end > value.start, 'Mapping range must be nonempty')
  .refine((value) => value.disposition === 'work' ? value.feature !== null :
    value.feature === null && value.criteria.length === 0, 'Only work mappings name a feature and criteria');
export const DecisionChangeSchema = record('decision_change', {
  questionOrChange: TextSchema, affectedRecords: z.array(RefSchema).min(1), rationale: TextSchema,
  disposition: DecisionDispositionSchema, originalInstruction: TextSchema.optional(),
  sourceRefs: z.array(SourceRefSchema).min(1), scopeChanges: z.array(ScopeChangeSchema),
  requestMapping: RequestMappingSchema.optional(),
  choice: z.strictObject({ kind: z.enum(['product', 'technical']), state: z.enum(['resolved', 'open']) }).optional(),
  answer: z.strictObject({ text: TextSchema, reusedFrom: RefSchema.optional() }).optional(),
});

export const CorrectionFactsSchema = z.array(z.strictObject({
  fact: CorrectionDeliveryFactSchema, at: TimestampSchema, evidence: z.array(EvidenceSchema).min(1),
})).min(1).refine((value) => new Set(value.map((fact) => fact.fact)).size === value.length, 'Delivery facts must be distinct')
  .refine((value) => value.some((fact) => fact.fact === 'recorded'), 'Correction must have its recorded fact')
  .refine((value) => value.every((fact) => fact.fact === 'recorded' ||
    (Date.parse(fact.at) >= Date.parse(value.find((item) => item.fact === 'recorded')?.at ?? '') &&
      (!['acknowledged', 'incorporated'].includes(fact.fact) || value.some((item) => item.fact === 'delivered' &&
        Date.parse(item.at) <= Date.parse(fact.at))))), 'Acknowledgement and incorporation require an earlier delivered fact');
export const CorrectionDeliverySnapshotSchema = z.strictObject({
  assignment: RefSchema, recipient: CorrectionRecipientSchema, operationId: IdSchema.optional(),
  suspendedOperation: RefSchema.optional(),
  facts: CorrectionFactsSchema, deliveryRecipient: CorrectionRecipientSchema.optional(), incorporationAssignment: RefSchema.optional(),
});
export const CorrectionSchema = z.strictObject({
  action: CorrectionActionSchema, originalText: TextSchema, assignment: RefSchema,
  affectedRevision: RefSchema, sequence: z.number().int().positive(), taskOrder: z.number().int().positive().optional(),
  supersedes: z.array(RefSchema), sourceRefs: z.array(SourceRefSchema).optional(),
  urgentStop: z.boolean().optional(), compatibilityKey: TextSchema.optional(),
  supersededBy: RefSchema.optional(), operationId: IdSchema.optional(),
  intendedRecipient: CorrectionRecipientSchema.optional(), addressedRecipient: CorrectionRecipientSchema.optional(),
  deliveryRecipient: CorrectionRecipientSchema.optional(), incorporationAssignment: RefSchema.optional(),
  deliveryHistory: z.array(CorrectionDeliverySnapshotSchema).optional(),
  impact: z.strictObject({ assignments: z.array(RefSchema), dependencies: z.array(RefSchema),
    completedEvidence: z.array(RefSchema), requiresReplan: z.boolean() }).optional(),
  facts: CorrectionFactsSchema,
});

export const ObservationSchema = record('observation', {
  finding: TextSchema, affectedScope: z.array(SourceRefSchema).min(1), evidence: z.array(EvidenceSchema),
  proposedGeneralization: TextSchema.nullable(), consolidationState: ConsolidationStateSchema,
  correction: CorrectionSchema.optional(),
  learning: LearningIdentitySchema.extend({
    inputKind: LearningInputKindSchema,
    captureReason: LearningCaptureReasonSchema,
  }).optional(),
  legacySections: z.array(LegacySectionSchema).optional(),
});

export const GuidanceRevisionSchema = record('guidance_revision', {
  scope: z.array(SourceRefSchema).min(1), text: TextSchema, supportingObservations: z.array(RefSchema).min(1),
  supersededGuidance: z.array(RefSchema), applicability: TextSchema, unresolvedConflicts: z.array(TextSchema),
  learning: LearningIdentitySchema.extend({ authority: z.enum(['inferred', 'explicit', 'legacy']) }).optional(),
  legacyReplacements: z.array(LegacyReplacementSchema).optional(),
});

export const LearningRunSchema = record('learning_run', {
  scheduledWindowId: IdSchema, scheduledFor: TimestampSchema, scheduleDigest: TextSchema,
  timezone: TextSchema, agentConfigDigest: TextSchema, snapshotDigest: TextSchema,
  observations: z.array(RefSchema), guidance: z.array(RefSchema), verdict: LearningVerdictSchema,
  sectionDiffs: z.array(z.strictObject({ source: LegacySectionSchema, replacement: TextSchema, diff: TextSchema })),
});
export type LearningRun = z.infer<typeof LearningRunSchema>;

export const PayloadDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const OperationSchema = record('operation', {
  idempotencyKey: IdSchema, command: CommandNameSchema, payloadDigest: PayloadDigestSchema,
  state: OperationStateSchema, externalReferences: z.array(SourceRefSchema),
  suspended: z.strictObject({ at: TimestampSchema, reason: TextSchema }).optional(),
  externalAttempt: z.strictObject({ action: TextSchema, firstMateTaskId: IdSchema,
    assignment: RefSchema.optional(), attemptId: IdSchema.optional(),
    payload: z.string().optional(), repository: TextSchema.optional(),
    baselineGeneration: TextSchema.nullable().optional(), baselineEndpointAlive: z.boolean().optional(), startedAt: TimestampSchema,
  }).optional(),
  taskRejection: z.strictObject({ beforeMutation: z.literal(true), reason: TextSchema }).optional(),
  reconciliation: z.strictObject({
    observedAt: TimestampSchema, evidence: z.array(EvidenceSchema).min(1),
    observedState: OperationStateSchema, note: TextSchema,
  }).nullable(),
});

export const RecordSchema = z.discriminatedUnion('kind', [
  ProjectSchema, RequestSchema, FeatureRevisionSchema, CriterionSchema, DesignRevisionSchema,
  ImplementationPlanRevisionSchema, DetailedPlanTaskSchema, TaskMappingSchema, AssignmentSchema,
  CriterionResultSchema, ProductReviewSchema, MeasurementClaimSchema, DecisionChangeSchema,
  ObservationSchema, GuidanceRevisionSchema, OperationSchema, UnderstandingRevisionSchema,
  StageRevisionSchema, PlanReadinessRevisionSchema, LearningRunSchema,
]);
export const RecordsSchema = z.array(RecordSchema);

export type Project = z.infer<typeof ProjectSchema>;
export type Request = z.infer<typeof RequestSchema>;
export type FeatureRevision = z.infer<typeof FeatureRevisionSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
export type DesignRevision = z.infer<typeof DesignRevisionSchema>;
export type ImplementationPlanRevision = z.infer<typeof ImplementationPlanRevisionSchema>;
export type DetailedPlanTask = z.infer<typeof DetailedPlanTaskSchema>;
export type TaskMapping = z.infer<typeof TaskMappingSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type CriterionResult = z.infer<typeof CriterionResultSchema>;
export type ProductReview = z.infer<typeof ProductReviewSchema>;
export type MeasurementClaim = z.infer<typeof MeasurementClaimSchema>;
export type DecisionChange = z.infer<typeof DecisionChangeSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type GuidanceRevision = z.infer<typeof GuidanceRevisionSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type FactoryRecord = z.infer<typeof RecordSchema>;

export type UnderstandingRevision = z.infer<typeof UnderstandingRevisionSchema>;
export type StageRevision = z.infer<typeof StageRevisionSchema>;
export type PlanReadinessRevision = z.infer<typeof PlanReadinessRevisionSchema>;
export type ReadinessFinding = z.infer<typeof ReadinessFindingSchema>;
