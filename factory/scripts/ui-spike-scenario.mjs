import { readFileSync } from 'node:fs';
import { ProjectStore, RecordsSchema, UiSpikeApi, ref } from '../dist/src/index.js';

export function spikeRecords() {
  const records = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/workflow.json', import.meta.url), 'utf8')))
    .filter(r => ['project', 'request', 'feature_revision', 'criterion', 'design_revision', 'implementation_plan_revision',
      'detailed_plan_task', 'task_mapping', 'assignment', 'observation', 'decision_change'].includes(r.kind) || r.id === 'result-general');
  records.find(r => r.kind === 'task_mapping').dependencies = [];
  const plan = records.find(r => r.kind === 'implementation_plan_revision');
  const first = records.find(r => r.kind === 'detailed_plan_task');
  const second = { ...structuredClone(first), id: 'task-2', expectedBehavior: 'Verify the same feature for a second connected system.',
    criteria: [{ id: 'criterion-second-system', revision: 1 }], blockers: ['task-1'] };
  plan.deliverySequence.push(ref(second));
  plan.priorities.push({ taskId: second.id, priority: 1 });
  records.push(second);
  // This remains a synthetic fixture: no claim about an actual feature delivery.
  return RecordsSchema.parse(records);
}

export function seedSpike(database, adapter) {
  const store = new ProjectStore(database);
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history: spikeRecords(), receipts: [] });
  return { store, api: new UiSpikeApi(store, adapter) };
}

/** Same scenario for protocol tests and the later, explicitly unrun live demo. */
export function exerciseSpike(api, baseUrl = 'http://127.0.0.1:3185') {
  const transcript = [];
  let sequence = 0;
  const send = (body) => {
    const response = api.handle('POST', '/canonical', body);
    transcript.push({ command: body, response });
    if (response.status !== 200) throw new Error(JSON.stringify(response));
    return response.body;
  };
  const envelope = (command, targetId) => ({ schemaVersion: 1, id: `spike-command-${++sequence}`, projectId: 'project-1',
    issuedAt: new Date().toISOString(), idempotencyKey: `spike-key-${sequence}`, command, targetId,
    expectedRevision: api.store.get('project-1', targetId)?.revision ?? 0 });
  const manage = (id, action, extra = {}) => {
    const mappingId = id === 'pilot-build' ? 'mapping-1' : 'mapping-2';
    const detail = api.store.get('project-1', id === 'pilot-build' ? 'task-1' : 'task-2');
    return send({ ...envelope('map_manage_execution_task', mappingId), payload: {
      feature: { id: 'feature-1', revision: 1 }, criteria: detail.criteria, detailedPlanTask: ref(detail),
      task: action === 'create' ? { kind: 'new', firstMateTaskId: id,
        title: id === 'pilot-build' ? 'Common connected-system feature' : 'Second-system acceptance', repo: 'scratch-spike' } :
        { kind: 'existing', firstMateTaskId: id }, action,
      dependencies: id === 'pilot-build' ? [] : ['pilot-build'], reason: 'Synthetic UI routing spike', ...extra } });
  };
  manage('pilot-build', 'create');
  manage('pilot-verify', 'create');
  const recordUrl = id => `${baseUrl}/projects/project-1/records/${id}`;
  for (const id of ['pilot-build', 'pilot-verify']) manage(id, 'update', { update: { body: [
    `Software Factory mapping: ${id === 'pilot-build' ? 'mapping-1' : 'mapping-2'}`,
    'Synthetic spike. Product records below are read only; use the canonical operation for edits.',
    `Original request: ${recordUrl('request-1')}`,
    `Feature and criteria: ${recordUrl('feature-1')}`,
    `Criteria: ${recordUrl('criterion-general')} ${recordUrl('criterion-second-system')}`,
    `Correction: ${recordUrl('observation-1')}`,
    `Decision: ${recordUrl('decision-suggestion')}`,
    `Result (synthetic common-interface evidence only): ${recordUrl('result-general')}`,
    `Canonical edits: ${baseUrl}/canonical`,
  ].join('\n') } });
  manage('pilot-build', 'pause');
  manage('pilot-build', 'resume');
  manage('pilot-build', 'set_priority', { priority: 0 });
  manage('pilot-verify', 'edit_dependencies', { dependencies: [] });
  manage('pilot-verify', 'edit_dependencies');
  const decision = api.store.get('project-1', 'decision-suggestion');
  send({ ...envelope('record_decision_suggestion', decision.id), payload: { decision: {
    ...decision, revision: 2, updatedAt: new Date().toISOString(), disposition: 'selected',
    questionOrChange: 'Keep the general interface and verify the second system.',
    rationale: 'Preserve the original request; the example does not narrow its scope.',
  } } });
  const observation = api.store.get('project-1', 'observation-1');
  send({ ...envelope('capture_consolidate_learning', 'spike-note'), payload: { action: 'capture', observation: {
    ...observation, id: 'spike-note', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finding: 'The second-system criterion still needs evidence.',
    consolidationState: 'pending', correction: undefined,
  } } });
  const feature = api.store.get('project-1', 'feature-1');
  const criterion = api.store.get('project-1', 'criterion-second-system');
  send({ ...envelope('record_decision_suggestion', feature.id), payload: {
    decision: { ...decision, id: 'spike-feature-edit', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), disposition: 'selected',
      questionOrChange: 'Clarify the second-system verification without removing scope.',
      affectedRecords: [{ id: feature.id, revision: 2 }], rationale: 'Stub editor round trip; retain original request and history.' },
    intakeRecords: [{ ...criterion, revision: 2, updatedAt: new Date().toISOString(),
      verificationMethod: 'Run the representative second-system acceptance through the common interface and retain its evidence.' },
    { ...feature, revision: 2, previousRevision: 1, updatedAt: new Date().toISOString(),
      criteria: feature.criteria.map(r => r.id === criterion.id ? { ...r, revision: 2 } : r),
      decisions: [{ id: 'spike-feature-edit', revision: 1 }], changeReason: 'Clarified verification, preserving requested behavior.' }],
  } });
  return transcript;
}
