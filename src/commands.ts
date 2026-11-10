import { z } from 'zod';
import {
  ArtifactSchema, CorrectionActionSchema, IdSchema, RefSchema, SourceRefSchema, TextSchema, TimestampSchema,
} from './primitives.js';
import {
  CriterionResultSchema, DecisionChangeSchema, DesignRevisionSchema, DetailedPlanTaskSchema,
  ImplementationPlanRevisionSchema, ObservationSchema, ProductReviewSchema, SelectedContextSchema,
  FeatureRevisionSchema, CriterionSchema, UnderstandingRevisionSchema, StageRevisionSchema,
  ProjectSchema,
} from './records.js';

const envelope = {
  schemaVersion: z.literal(1), id: IdSchema, projectId: IdSchema,
  issuedAt: TimestampSchema, idempotencyKey: IdSchema,
};
const mutation = { ...envelope, targetId: IdSchema, expectedRevision: z.number().int().nonnegative() };

export const CaptureRequestCommandSchema = z.strictObject({
  ...mutation, command: z.literal('capture_request'),
  payload: z.strictObject({
    clientRequestId: IdSchema, originalText: TextSchema, source: SourceRefSchema,
    channel: TextSchema, capturedAt: TimestampSchema, attachments: z.array(ArtifactSchema),
  }),
});
export const DesignPlanFeatureCommandSchema = z.strictObject({
  ...mutation, command: z.literal('design_plan_feature'),
  payload: z.union([z.strictObject({
    feature: RefSchema.nullable(), sourceRefs: z.array(SourceRefSchema).min(1),
    existingDesignRefs: z.array(SourceRefSchema), expectedRevisions: z.array(RefSchema),
    design: DesignRevisionSchema, plan: ImplementationPlanRevisionSchema,
    tasks: z.array(DetailedPlanTaskSchema).min(1),
  }), z.strictObject({
    action: z.literal('record_stage'), stage: StageRevisionSchema,
    records: z.array(z.union([UnderstandingRevisionSchema, DesignRevisionSchema,
      ImplementationPlanRevisionSchema, DetailedPlanTaskSchema, DecisionChangeSchema])),
  }), z.strictObject({ action: z.literal('check_readiness'), detailStage: RefSchema })]),
});
export const RecordDecisionSuggestionCommandSchema = z.strictObject({
  ...mutation, command: z.literal('record_decision_suggestion'),
  payload: z.strictObject({ decision: DecisionChangeSchema, project: ProjectSchema.optional(),
    // Intake can create an initial feature and its criteria alongside its mapping.
    // All content participates in the command digest and the same store transaction.
    intakeRecords: z.array(z.union([FeatureRevisionSchema, CriterionSchema])).optional(),
  }),
});
export const MapManageExecutionTaskCommandSchema = z.strictObject({
  ...mutation, command: z.literal('map_manage_execution_task'),
  payload: z.strictObject({
    feature: RefSchema.nullable(), criteria: z.array(RefSchema), detailedPlanTask: RefSchema.nullable(),
    task: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('existing'), firstMateTaskId: IdSchema }),
      z.strictObject({ kind: z.literal('new'), firstMateTaskId: IdSchema, title: TextSchema, repo: TextSchema }),
    ]),
    // Toolkit intent, not a claim that tasks-axi has matching verbs/states.
    action: z.enum(['map', 'create', 'set_priority', 'pause', 'resume', 'cancel', 'edit_dependencies']),
    priority: z.number().int().optional(), dependencies: z.array(IdSchema), reason: TextSchema,
  }).refine((value) => value.action !== 'set_priority' || value.priority !== undefined,
    'Priority change requires a priority')
    .refine((value) => value.action !== 'create' || value.task.kind === 'new',
      'Create requires a new task description')
    .refine((value) => value.feature !== null || value.criteria.length === 0,
      'Mapping product criteria requires a feature'),
});
export const PrepareAssignmentCommandSchema = z.strictObject({
  ...mutation, command: z.literal('prepare_assignment'),
  payload: z.strictObject({
    detailedPlanTask: RefSchema, feature: RefSchema.nullable(), design: RefSchema, plan: RefSchema,
    firstMateTaskId: IdSchema, selectedContext: z.array(SelectedContextSchema).min(1),
    returnLocation: TextSchema,
  }),
});
export const DeliverCorrectionCommandSchema = z.strictObject({
  ...mutation, command: z.literal('deliver_correction'),
  payload: z.strictObject({
    affectedRevision: RefSchema, assignment: RefSchema, originalCorrection: TextSchema,
    action: CorrectionActionSchema, sequence: z.number().int().positive(), supersedes: z.array(RefSchema),
  }),
});
export const RecordReviewResultCommandSchema = z.strictObject({
  ...mutation, command: z.literal('record_review_result'),
  payload: z.strictObject({
    originalRequests: z.array(RefSchema).min(1), feature: RefSchema, design: RefSchema, plan: RefSchema,
    assignment: RefSchema, deliveredArtifact: ArtifactSchema,
    results: z.array(CriterionResultSchema), review: ProductReviewSchema.optional(),
  }),
});
export const CaptureConsolidateLearningCommandSchema = z.strictObject({
  ...mutation, command: z.literal('capture_consolidate_learning'),
  payload: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('capture'), observation: ObservationSchema }),
    z.strictObject({ action: z.literal('consolidate'), scheduledWindowId: IdSchema,
      observationRefs: z.array(RefSchema), guidanceRefs: z.array(RefSchema), timezone: TextSchema }),
  ]),
});
export const ReadProjectStateExportCommandSchema = z.strictObject({
  ...envelope, command: z.literal('read_project_state_export'),
  payload: z.strictObject({ cursor: TextSchema.optional(), revision: z.number().int().positive().optional(),
    export: z.boolean() }),
});

export const CommandEnvelopeSchema = z.discriminatedUnion('command', [
  CaptureRequestCommandSchema, DesignPlanFeatureCommandSchema, RecordDecisionSuggestionCommandSchema,
  MapManageExecutionTaskCommandSchema, PrepareAssignmentCommandSchema, DeliverCorrectionCommandSchema,
  RecordReviewResultCommandSchema, CaptureConsolidateLearningCommandSchema, ReadProjectStateExportCommandSchema,
]);

export const BoundaryErrorSchema = z.strictObject({
  code: z.enum(['validation', 'conflict', 'not_found', 'external_failure', 'unknown_outcome']),
  message: TextSchema, paths: z.array(TextSchema), externalReferences: z.array(SourceRefSchema),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type BoundaryError = z.infer<typeof BoundaryErrorSchema>;
