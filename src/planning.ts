import { bundleUrl } from './ui-bundle.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DesignPlanFeatureCommandSchema } from './commands.js';
import { ref, stableId } from './intake.js';
import { planReadinessFindings, planningRecord, samePlanningRef, stageDependencies,
  stageSliceCriteria, withSliceCriterionProvenance } from './planning-checks.js';
import { IdSchema, RefSchema, TimestampSchema } from './primitives.js';
import {
  DesignRevisionSchema, DetailedPlanTaskSchema, ImplementationPlanRevisionSchema, DecisionChangeSchema,
  PlanReadinessRevisionSchema, StageRevisionSchema, UnderstandingRevisionSchema,
  type FactoryRecord, type StageRevision, type PlanReadinessRevision,
} from './records.js';
import { ProjectStore, StoreError } from './store.js';

export const RecordStageInputSchema = z.strictObject({
  idempotencyKey: IdSchema, expectedRevision: z.number().int().nonnegative(), issuedAt: TimestampSchema,
  stage: StageRevisionSchema,
  records: z.array(z.union([UnderstandingRevisionSchema, DesignRevisionSchema,
    ImplementationPlanRevisionSchema, DetailedPlanTaskSchema, DecisionChangeSchema])),
});

/** The same operation handles newly authored artifacts and existing revisions.
 * Stage history binds either choice to the exact current source and criteria. */
export function recordStage(store: ProjectStore, input: unknown) {
  const data = RecordStageInputSchema.parse(input);
  const { stage } = data;
  const command = DesignPlanFeatureCommandSchema.parse({
    schemaVersion: 1, id: randomUUID(), projectId: stage.projectId, issuedAt: data.issuedAt,
    idempotencyKey: data.idempotencyKey, targetId: stage.id, expectedRevision: data.expectedRevision,
    command: 'design_plan_feature', payload: { action: 'record_stage', stage, records: data.records },
  });
  return store.mutate(command, (history) => {
    if (data.records.some((record) => record.projectId !== stage.projectId)) {
      throw new StoreError('validation', 'project_mismatch');
    }
    const feature = history.filter((record) => record.id === stage.feature.id).at(-1);
    if (feature?.kind !== 'feature_revision' || !samePlanningRef(feature, stage.feature)) {
      throw new StoreError('conflict', 'stage_requires_current_feature_revision');
    }
    const previous = history.filter((record) => record.id === stage.id).at(-1);
    if (previous?.kind === 'stage_revision' && (previous.stage !== stage.stage || previous.feature.id !== stage.feature.id)) {
      throw new StoreError('validation', 'stage_identity_change');
    }
    const artifact = planningRecord([...history, ...data.records], stage.artifact);
    if (!artifact) throw new StoreError('not_found', 'stage_artifact_not_found');
    if (stage.reuse) {
      if (!['design', 'plan'].includes(stage.stage) || !planningRecord(history, stage.artifact) ||
        data.records.some((record) => samePlanningRef(record, stage.artifact))) {
        throw new StoreError('validation', 'reuse_requires_existing_design_or_plan_revision');
      }
    } else if (!data.records.some((record) => samePlanningRef(record, stage.artifact)) && stage.stage !== 'detail') {
      throw new StoreError('validation', 'existing_artifact_requires_recorded_reuse_check');
    }
    // Every supplied record must participate in the stage rather than smuggling
    // unrelated work into the otherwise trusted store transaction.
    const candidates = [...history, ...data.records];
    const connected = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('id' in value && 'revision' in value && Object.keys(value).length === 2) {
        const linked = planningRecord(candidates, value as { id: string; revision: number });
        if (linked) {
          const key = JSON.stringify(ref(linked));
          if (!connected.has(key)) { connected.add(key); visit(linked); }
        }
      } else for (const item of Object.values(value)) visit(item);
    };
    visit(stage);
    for (const record of data.records) if (!connected.has(JSON.stringify(ref(record)))) {
      throw new StoreError('validation', `unrelated_stage_record: ${record.id}`);
    }
    for (const record of data.records) {
      if ((record.kind === 'design_revision' || record.kind === 'implementation_plan_revision') && !record.workflow) {
        throw new StoreError('validation', 'staged_artifact_requires_workflow_content');
      }
      if (record.kind === 'implementation_plan_revision' && record.readiness.ready) {
        throw new StoreError('validation', 'use_readiness_check_to_record_ready_plan');
      }
    }
    const records = data.records.map((record) => record.kind === 'implementation_plan_revision' ?
      withSliceCriterionProvenance(history, record, stage.feature) : record);
    return [...records, stage];
  });
}

export const CheckReadinessInputSchema = z.strictObject({
  projectId: IdSchema, detailStage: RefSchema, idempotencyKey: IdSchema,
  issuedAt: TimestampSchema, expectedPlanRevision: z.number().int().positive(),
});
export function checkPlanReadiness(store: ProjectStore, input: unknown) {
  const data = CheckReadinessInputSchema.parse(input);
  const stage = store.get(data.projectId, data.detailStage.id, data.detailStage.revision);
  if (stage?.kind !== 'stage_revision' || stage.stage !== 'detail') throw new StoreError('not_found', 'detail_stage_not_found');
  const command = DesignPlanFeatureCommandSchema.parse({
    schemaVersion: 1, id: randomUUID(), projectId: data.projectId, issuedAt: data.issuedAt,
    idempotencyKey: data.idempotencyKey, targetId: stage.artifact.id, expectedRevision: data.expectedPlanRevision,
    command: 'design_plan_feature', payload: { action: 'check_readiness', detailStage: data.detailStage },
  });
  const checkId = stableId('readiness', data.projectId, data.idempotencyKey);
  const result = store.mutate(command, (history) => {
    const currentFeature = history.filter((record) => record.id === stage.feature.id).at(-1);
    if (!currentFeature || !samePlanningRef(currentFeature, stage.feature)) {
      throw new StoreError('conflict', 'readiness_requires_current_feature_revision');
    }
    const plan = planningRecord(history, stage.artifact);
    if (plan?.kind !== 'implementation_plan_revision' || plan.revision !== data.expectedPlanRevision) {
      throw new StoreError('conflict', 'detail_does_not_name_current_plan');
    }
    const findings = planReadinessFindings(history, stage);
    const check = PlanReadinessRevisionSchema.parse({
      kind: 'plan_readiness_revision', id: checkId, projectId: data.projectId, schemaVersion: 1,
      revision: 1, createdAt: data.issuedAt, updatedAt: data.issuedAt,
      feature: stage.feature, plan: stage.artifact, detailStage: ref(stage), findings, ready: findings.length === 0,
    });
    const writes: FactoryRecord[] = [check];
    if (check.ready && plan.workflow) {
      const feature = currentFeature;
      if (feature.kind !== 'feature_revision') throw new StoreError('validation', 'feature_not_found');
      const sourceRefs = [...feature.sourceRequests, plan.design].map((record) => ({
        uri: `factory:record/${encodeURIComponent(record.id)}@${record.revision}`, record,
      }));
      writes.push(ImplementationPlanRevisionSchema.parse({ ...plan, feature: stage.feature, revision: plan.revision + 1,
        updatedAt: data.issuedAt, dependencies: stageDependencies(history, stage, plan.dependencies), workflow: { ...plan.workflow,
          slices: plan.workflow.slices.map((slice) => {
            const { criteriaFeature: _legacy, ...content } = slice;
            const criteriaProvenance = stageSliceCriteria(history, stage, plan, slice);
            return { ...content, criteria: criteriaProvenance.criteria, criteriaProvenance };
          }),
          changeReason: 'Deterministic plan-readiness check passed', readinessCheck: ref(check),
          retainedTasks: plan.deliverySequence.map((task) => ({ task, reason: 'Unchanged detail verified by readiness check' })),
        }, readiness: { ready: true, comparison: { result: 'passed', sourceRefs, findings: [],
          reviewerSession: 'factory:deterministic-plan-readiness', comparedAt: data.issuedAt } },
      }));
    }
    return writes;
  });
  return { result, check: store.get(data.projectId, checkId),
    readyPlan: result.records.find((record) => record.id === stage.artifact.id) ?? null };
}

/** Read persisted findings; no implicit recheck, mutation, approval or model call. */
export function planReadinessHistory(store: ProjectStore, projectId: string, planId: string) {
  return store.history(projectId).filter((record): record is PlanReadinessRevision =>
    record.kind === 'plan_readiness_revision' && record.plan.id === planId);
}

export function stageHistory(store: ProjectStore, projectId: string, featureId: string): StageRevision[] {
  return store.history(projectId).filter((record): record is StageRevision =>
    record.kind === 'stage_revision' && record.feature.id === featureId);
}

/** Canonical envelope entry point shared by CLI and HTTP. The original combined
 * design/plan contract revises a coherent artifact set; staged authoring keeps
 * using recordStage/checkPlanReadiness and their stronger workflow checks. */
export function designPlanFeature(store: ProjectStore, input: unknown) {
  const command = DesignPlanFeatureCommandSchema.parse(input);
  const payload = command.payload;
  if ('action' in payload) {
    if (payload.action === 'record_stage') {
      if (command.targetId !== payload.stage.id) throw new StoreError('validation', 'stage_target_mismatch');
      if (command.projectId !== payload.stage.projectId) throw new StoreError('validation', 'project_mismatch');
      return recordStage(store, { idempotencyKey: command.idempotencyKey, expectedRevision: command.expectedRevision,
        issuedAt: command.issuedAt, stage: payload.stage, records: payload.records });
    }
    const stage = store.get(command.projectId, payload.detailStage.id, payload.detailStage.revision);
    if (stage?.kind !== 'stage_revision' || stage.artifact.id !== command.targetId) {
      throw new StoreError('validation', 'readiness_target_mismatch');
    }
    return checkPlanReadiness(store, { projectId: command.projectId, detailStage: payload.detailStage,
      idempotencyKey: command.idempotencyKey, issuedAt: command.issuedAt, expectedPlanRevision: command.expectedRevision });
  }
  const writes = [payload.design, payload.plan, ...payload.tasks];
  if (!writes.some((record) => record.id === command.targetId)) throw new StoreError('validation', 'command_must_target_written_record');
  const result = store.mutate(command, (history) => {
    if (payload.plan.readiness.ready) throw new StoreError('validation', 'use_readiness_check_to_record_ready_plan');
    if (payload.feature) {
      const current = history.filter((entry) => entry.id === payload.feature!.id).at(-1);
      if (current?.kind !== 'feature_revision' || !samePlanningRef(current, payload.feature)) {
        throw new StoreError('conflict', 'design_requires_current_feature_revision');
      }
    }
    for (const record of writes) {
      if (payload.feature === null ? record.feature !== null : !record.feature || !samePlanningRef(payload.feature, record.feature)) {
        throw new StoreError('validation', 'artifact_feature_mismatch');
      }
      const previous = history.filter((entry) => entry.id === record.id).at(-1);
      if (previous && !payload.expectedRevisions.some((entry) => samePlanningRef(entry, previous))) {
        throw new StoreError('validation', `missing_expected_revision: ${record.id}`);
      }
    }
    return writes.map((record) => record.kind === 'implementation_plan_revision' ?
      withSliceCriterionProvenance(history, record, payload.feature) : record);
  });
  const bundle = { design: ref(payload.design), plan: ref(payload.plan), tasks: payload.plan.deliverySequence };
  return { ...result, bundle, ...(payload.feature ? { resumeUrl: bundleUrl(command.projectId, payload.feature.id, bundle) } : {}) };
}
