import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fakeJudge } from './judge-helper.js';
import {
  ProjectStore, RecordsSchema, UnderstandingRevisionSchema, DesignRevisionSchema,
  ImplementationPlanRevisionSchema, DetailedPlanTaskSchema, StageRevisionSchema, DecisionChangeSchema,
  recordStage, checkPlanReadiness, planReadinessHistory, ref, validateRecords, validateAssignmentForDispatch, planReadinessFindings,
  type FactoryRecord, type StageRevision, type ImplementationPlanRevision, type Ref,
  prepareWorkerBrief, checkWorkerBrief, requiredAssignmentContext, recordSource,
  projectView, workView, renderFeature, buildEditCommand, applyCommand, type EditContext,
} from '../src/index.js';

const time = '2026-11-10T10:36:43Z';
const base = { projectId: 'project-1', schemaVersion: 1 as const, revision: 1, createdAt: time, updatedAt: time };
const feature = { id: 'feature-1', revision: 1 };
const request = { id: 'request-1', revision: 1 };
const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const source = (record: { id: string; revision: number }) => ({ uri: `fixture://${record.id}`, record: ref(record) });
const comparison = (refs: { id: string; revision: number }[]) => ({ result: 'passed' as const,
  sourceRefs: refs.map(source), findings: [], reviewerSession: 'source-analyst', comparedAt: time });
const originalScenario = JSON.parse(readFileSync(new URL('../../fixtures/scenarios/erpnext-narrowed-assignment.json', import.meta.url), 'utf8'));

function setup(narrow = false, path = ':memory:') {
  const records = structuredClone(baseline.filter((record) =>
    ['project', 'request', 'feature_revision', 'criterion'].includes(record.kind)));
  if (narrow) {
    for (const record of records) {
      if (record.kind === 'request') record.originalText = 'Correct the ERPNext error message.';
      if (record.kind === 'feature_revision') {
        record.criteria = record.criteria.slice(0, 1); record.outcome = 'Correct ERPNext error message';
      }
      if (record.kind === 'criterion' && record.id === 'criterion-general') record.expectedBehavior = 'Correct error message';
    }
  }
  const store = new ProjectStore(path);
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history: records, receipts: [] });
  const criteria = (records.find((record) => record.kind === 'feature_revision') as Extract<FactoryRecord, { kind: 'feature_revision' }>).criteria;
  const scope = narrow ? [{ request, term: 'ERPNext', role: 'entire_scope' as const }] :
    [{ request, term: 'ERPNext', role: 'example' as const }];
  const plannedScope = scope.map((item) => ({ request: item.request, term: item.term,
    coverage: narrow ? 'entire_scope' as const : 'general' as const }));
  const understanding = UnderstandingRevisionSchema.parse({ ...base, kind: 'understanding_revision', id: 'understand-1',
    feature, sourceRequests: [request], criteria, goal: narrow ? 'Correct error message' : 'Feature X across all connected systems',
    userBehavior: narrow ? 'Read an accurate ERPNext error' : 'Use the common feature with any system',
    terms: { system: 'A connected application' }, priorities: [], examples: narrow ? [] : ['ERPNext', 'Second system'],
    exclusions: ['No supervisor changes'], existingWork: [{ source: { uri: 'repo://connection' }, finding: 'Common interface exists' }],
    openUnknowns: [], scope, changeReason: 'Research current behavior before design',
  });
  const decision = DecisionChangeSchema.parse({ ...base, kind: 'decision_change', id: 'settled-decision',
    questionOrChange: narrow ? 'Use the requested wording' : 'Preserve every-system behavior',
    affectedRecords: [feature], rationale: 'Explicit original request', disposition: 'selected',
    sourceRefs: [source(request)], scopeChanges: [], choice: { kind: 'product', state: 'resolved' },
  });
  const template = baseline.find((record) => record.kind === 'design_revision')!;
  const design = DesignRevisionSchema.parse({ ...template, id: 'design-new', feature,
    productBehavior: narrow ? 'Correct the ERPNext message' : 'Feature X through common interface',
    technicalDesign: narrow ? 'Update the existing message constant' : 'Extend the connection interface and adapters',
    decisions: [ref(decision)], unresolvedQuestions: [], sourceComparison: comparison([request]),
    workflow: { understanding: ref(understanding), reuse: { alreadyWorks: 'Common interface and message path',
      gap: narrow ? 'Incorrect message' : 'Feature X absent', change: narrow ? 'Correct message' : 'Extend interface and connect adapters' },
    scope: plannedScope, changeReason: 'Initial design from researched reuse' },
  });
  const tasks = criteria.map((criterion, index) => DetailedPlanTaskSchema.parse({ ...base,
    kind: 'detailed_plan_task', id: `task-new-${index}`, feature, design: ref(design), plan: { id: 'plan-new', revision: 1 },
    criteria: [criterion], draft: true,
  }));
  const plan = ImplementationPlanRevisionSchema.parse({ ...base, kind: 'implementation_plan_revision', id: 'plan-new',
    feature, design: ref(design), deliverySequence: tasks.map(ref), strategy: 'focused', strategyReason: 'Shared interface context',
    integrationApproach: narrow ? 'Verify existing message flow' : 'Connect adapters to common interface',
    dependencies: tasks.length > 1 ? [{ prerequisiteTaskId: tasks[0]!.id, consumerTaskId: tasks[1]!.id,
      reason: 'Second adapter consumes common interface', needs: { kind: 'criterion', criterion: criteria[0]! } }] : [],
    priorities: tasks.map((task, priority) => ({ taskId: task.id, priority })), readiness: { ready: false, comparison: comparison([request, design]) },
    workflow: { slices: tasks.map((task, index) => ({ id: `slice-${index}`, behavior: narrow ? 'Correct message' : `Deliver system path ${index}`,
      criteria: task.criteria, tasks: [ref(task)] })), scope: plannedScope,
    integrationSteps: narrow ? [] : ['Connect adapters through the common interface and run together'],
    finalVerification: [narrow ? 'Trigger error and check exact wording' : 'Exercise ERPNext and a second system through the same interface'],
    retainedTasks: [], changeReason: 'Initial ordered delivery plan' },
  });
  function stage(name: StageRevision['stage'], artifact: FactoryRecord, previousStage?: StageRevision): StageRevision {
    return StageRevisionSchema.parse({ ...base, kind: 'stage_revision', id: `stage-${name}`, stage: name, feature,
      sourceRequests: [request], criteria, artifact: ref(artifact), changeReason: `Record ${name}`,
      ...(previousStage ? { previousStage: ref(previousStage) } : {}),
    });
  }
  const understandStage = stage('understand', understanding);
  const designStage = stage('design', design, understandStage);
  const planStage = stage('plan', plan, designStage);
  const write = (selected: StageRevision, artifacts: FactoryRecord[]) => recordStage(store, {
    idempotencyKey: `${selected.id}-${selected.revision}`, expectedRevision: selected.revision - 1,
    issuedAt: time, stage: selected, records: artifacts,
  });
  const start = () => {
    write(understandStage, [understanding]); write(designStage, [design, decision]); write(planStage, [plan, ...tasks]);
  };
  const detailedTasks = tasks.map((task) => DetailedPlanTaskSchema.parse({ ...task, revision: 2,
    draft: false, plan: { id: plan.id, revision: 2 }, expectedBehavior: narrow ? 'Show corrected message' : 'Deliver connected-system behavior',
    designRefs: [source(design)], boundaries: ['Use the existing connection path'], reuseTargets: [{ uri: 'repo://connection' }],
    inputs: ['Existing connection'], outputs: ['Working behavior and test evidence'], blockers: [],
    verificationCases: [narrow ? 'Expected error wording' : 'Both ERPNext and a non-ERPNext system'],
    verificationMethod: 'Run the acceptance cases through the common interface',
    decisionsToKeep: [ref(decision)], returnRequirements: ['Commit, tests, behavior evidence, limitations'],
  }));
  const detailedPlan = ImplementationPlanRevisionSchema.parse({ ...plan, revision: 2,
    deliverySequence: detailedTasks.map(ref), workflow: { ...plan.workflow!, changeReason: 'Complete actionable task detail',
      slices: plan.workflow!.slices.map((slice, index) => ({ ...slice, tasks: [ref(detailedTasks[index]!)] })) },
  });
  const detailStage = stage('detail', detailedPlan, planStage);
  const finish = () => write(detailStage, [detailedPlan, ...detailedTasks]);
  const check = (key = 'readiness-1') => checkPlanReadiness(store, { projectId: base.projectId, detailStage: ref(detailStage),
    idempotencyKey: key, issuedAt: time, expectedPlanRevision: 2 });
  return { store, criteria, understanding, decision, design, plan, tasks, detailedPlan, detailedTasks,
    understandStage, designStage, planStage, detailStage, stage, write, start, finish, check };
}

for (const narrow of [false, true]) test(`${narrow ? 'narrow correction' : 'general cross-system feature'} completes all four stages and readiness`, () => {
  const flow = setup(narrow);
  try {
    flow.start(); flow.finish();
    const result = flow.check();
    assert.equal(result.check?.kind, 'plan_readiness_revision');
    assert.deepEqual(result.check && 'findings' in result.check ? result.check.findings : null, []);
    assert.deepEqual(result.readyPlan, { id: 'plan-new', revision: 3 });
    assert.equal(flow.store.get(base.projectId, 'plan-new')?.kind, 'implementation_plan_revision');
    assert.equal(flow.store.history(base.projectId).filter((record) => record.kind === 'stage_revision').length, 4);
    assert.equal(flow.detailedPlan.workflow!.slices.length, narrow ? 1 : 2);
    assert.equal(flow.store.get(base.projectId, flow.decision.id)?.revision, 1, 'Settled decision needs no approval mutation');
    assert.equal(flow.store.get(base.projectId, flow.detailedTasks[0]!.id)?.revision, 2, 'Ready check retains task revisions');
    assert.deepEqual(flow.check(), result, 'Same key replays without a duplicate ready revision');
    assert.equal(validateRecords(flow.store.history(base.projectId)).ok, true);
  } finally { flow.store.close(); }
});

const findingCases: { name: string; code: string; edit: (flow: ReturnType<typeof setup>) => void }[] = [
  { name: 'dropped behavior', code: 'dropped_behavior', edit: (flow) => {
    flow.detailedPlan.workflow!.slices[1]!.criteria = [];
    flow.detailedTasks[1]!.criteria = []; flow.detailedTasks[1]!.maintenanceObjective = 'Draft maintenance';
  } },
  { name: 'BUILD-02 ERPNext-only narrowing with all criterion IDs retained', code: 'example_driven_narrowing', edit: (flow) => {
    // Use the same original request and narrowing text as the BUILD-02 dispatch failure.
    assert.equal(originalScenario.edits[0].value, 'Implement feature X for ERPNext only.');
    flow.design.productBehavior = originalScenario.edits[0].value;
    flow.design.workflow!.scope[0]!.coverage = 'example_only';
    flow.detailedPlan.workflow!.scope[0]!.coverage = 'example_only';
  } },
  { name: 'missing integration', code: 'missing_integration', edit: (flow) => { flow.detailedPlan.workflow!.integrationSteps = []; } },
  { name: 'missing final feature verification on one slice', code: 'missing_integration', edit: (flow) => { flow.detailedPlan.workflow!.finalVerification = []; } },
  { name: 'open product decision', code: 'unresolved_product_decision', edit: (flow) => {
    flow.decision.choice!.state = 'open'; flow.decision.disposition = 'proposed';
  } },
  { name: 'missing task verification and boundaries', code: 'detail_gap', edit: (flow) => {
    flow.detailedTasks[0]!.draft = true; delete flow.detailedTasks[0]!.verificationMethod; delete flow.detailedTasks[0]!.boundaries;
  } },
  { name: 'invented task scope', code: 'invented_scope', edit: (flow) => {
    flow.detailedTasks[0]!.criteria = []; flow.detailedTasks[0]!.draft = true;
  } },
];
for (const scenario of findingCases) test(`readiness records ${scenario.name} and withholds a ready revision`, () => {
  const flow = setup(scenario.name.includes('one slice'));
  try {
    scenario.edit(flow); flow.start(); flow.finish();
    const result = flow.check();
    assert.equal(result.readyPlan, null);
    assert.equal(result.check?.kind, 'plan_readiness_revision');
    if (result.check?.kind !== 'plan_readiness_revision') return;
    assert.ok(result.check.findings.some((finding) => finding.code === scenario.code), JSON.stringify(result.check.findings));
    assert.equal(flow.store.get(base.projectId, 'plan-new')?.revision, 2);
    assert.deepEqual(planReadinessHistory(flow.store, base.projectId, 'plan-new'), [result.check]);
  } finally { flow.store.close(); }
});

test('an existing design is selected after a recorded current-request check without rewriting it', () => {
  const flow = setup();
  try {
    flow.start();
    const selected = StageRevisionSchema.parse({ ...flow.designStage, revision: 2, changeReason: 'Reuse suitable current design',
      reuse: { check: comparison([request, flow.design]), criterionMap: flow.criteria.map((criterion) => ({ current: criterion, existing: criterion })) } });
    flow.write(selected, []);
    assert.equal(flow.store.get(base.projectId, flow.design.id)?.revision, 1);
    assert.deepEqual(flow.store.get(base.projectId, selected.id)?.revision, 2);
    // Select the reused design in a new plan-stage revision, preserving its artifact via an explicit plan reuse check.
    const selectedPlan = StageRevisionSchema.parse({ ...flow.planStage, revision: 2, previousStage: ref(selected),
      reuse: { check: comparison([request, flow.plan]), criterionMap: flow.criteria.map((criterion) => ({ current: criterion, existing: criterion })) } });
    flow.write(selectedPlan, []);
    flow.detailStage.previousStage = ref(selectedPlan);
    flow.finish(); assert.ok(flow.check().readyPlan);
  } finally { flow.store.close(); }
});

test('existing design reuse requires the current request in the recorded comparison', () => {
  const flow = setup();
  try {
    flow.start();
    const selected = { ...flow.designStage, revision: 2,
      reuse: { check: comparison([flow.design]), criterionMap: flow.criteria.map((criterion) => ({ current: criterion, existing: criterion })) } };
    assert.throws(() => flow.write(selected, []), /omitted_source/);
    assert.equal(flow.store.get(base.projectId, selected.id)?.revision, 1);
  } finally { flow.store.close(); }
});

test('material replanning revises the affected task and retains the unaffected task revision', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish();
    const changed = DetailedPlanTaskSchema.parse({ ...flow.detailedTasks[1]!, revision: 3,
      plan: { id: flow.plan.id, revision: 3 }, expectedBehavior: 'Use discovered second-system error contract' });
    const retained = flow.detailedTasks[0]!;
    const replanned = ImplementationPlanRevisionSchema.parse({ ...flow.detailedPlan, revision: 3,
      deliverySequence: [ref(retained), ref(changed)], workflow: { ...flow.detailedPlan.workflow!,
        changeReason: 'Discovery: second-system adapter requires an error contract adjustment',
        retainedTasks: [{ task: ref(retained), reason: 'Common interface behavior and its inputs are unchanged' }],
        slices: flow.detailedPlan.workflow!.slices.map((slice, index) => ({ ...slice, tasks: [ref(index ? changed : retained)] })) },
    });
    const detail = StageRevisionSchema.parse({ ...flow.detailStage, revision: 2, artifact: ref(replanned),
      changeReason: replanned.workflow!.changeReason });
    flow.write(detail, [replanned, changed]);
    const result = checkPlanReadiness(flow.store, { projectId: base.projectId, detailStage: ref(detail),
      idempotencyKey: 'replanned-check', issuedAt: time, expectedPlanRevision: 3 });
    assert.ok(result.readyPlan, JSON.stringify(result.check));
    assert.equal(flow.store.get(base.projectId, retained.id)?.revision, 2);
    assert.equal(flow.store.get(base.projectId, changed.id)?.revision, 3);
  } finally { flow.store.close(); }
});

test('stage writes enforce order, CAS and payload-sensitive idempotency', () => {
  const flow = setup();
  try {
    assert.throws(() => flow.write(flow.designStage, [flow.design, flow.decision]), /missing_reference/);
    flow.start();
    assert.throws(() => flow.write({ ...flow.planStage, changeReason: 'Different payload' }, [flow.plan, ...flow.tasks]), /idempotency_conflict/);
    assert.throws(() => recordStage(flow.store, { stage: flow.planStage, records: [flow.plan, ...flow.tasks],
      expectedRevision: 0, issuedAt: time, idempotencyKey: 'stale-new-key' }), /revision_conflict/);
  } finally { flow.store.close(); }
});

test('CLI records all stages, prints findings and returns a failure status for an unready plan', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-planning-'));
  const path = join(directory, 'project.sqlite');
  const flow = setup(false, path);
  flow.store.close();
  const cli = (args: string[]) => spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, ...args], { encoding: 'utf8' });
  const runStage = (stage: StageRevision, records: FactoryRecord[]) => {
    const file = join(directory, `${stage.stage}.json`);
    writeFileSync(file, JSON.stringify({ stage, records, expectedRevision: 0, issuedAt: time, idempotencyKey: stage.id }));
    const result = cli([stage.stage, '--db', path, '--input', file]);
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    runStage(flow.understandStage, [flow.understanding]); runStage(flow.designStage, [flow.design, flow.decision]);
    runStage(flow.planStage, [flow.plan, ...flow.tasks]);
    delete flow.detailedTasks[0]!.verificationMethod;
    runStage(flow.detailStage, [flow.detailedPlan, ...flow.detailedTasks]);
    const file = join(directory, 'check.json');
    writeFileSync(file, JSON.stringify({ projectId: base.projectId, detailStage: ref(flow.detailStage),
      expectedPlanRevision: 2, idempotencyKey: 'cli-check', issuedAt: time }));
    const checked = cli(['check-plan', '--db', path, '--input', file]);
    assert.equal(checked.status, 1, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).check.ready, false);
    const findings = cli(['findings', '--db', path, '--project', base.projectId, '--plan', flow.plan.id]);
    assert.equal(findings.status, 0, findings.stderr);
    assert.equal(JSON.parse(findings.stdout)[0].findings[0].code, 'detail_gap');
    const stages = cli(['stages', '--db', path, '--project', base.projectId, '--feature', feature.id]);
    assert.equal(JSON.parse(stages.stdout).length, 4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a previously settled answer is not raised again from a stale question list', () => {
  const flow = setup(true);
  try {
    flow.design.unresolvedQuestions.push(flow.decision.questionOrChange);
    flow.start(); flow.finish();
    assert.ok(flow.check().readyPlan);
  } finally { flow.store.close(); }
});

test('a failed readiness check can be corrected and rechecked without rewriting unaffected tasks', () => {
  const flow = setup();
  try {
    flow.detailedPlan.workflow!.integrationSteps = [];
    flow.start(); flow.finish();
    assert.equal(flow.check().readyPlan, null);
    const fixed = ImplementationPlanRevisionSchema.parse({ ...flow.detailedPlan, revision: 3,
      workflow: { ...flow.detailedPlan.workflow!, integrationSteps: ['Exercise both adapters through the common interface'],
        changeReason: 'Resolve recorded missing-integration finding',
        retainedTasks: flow.detailedTasks.map((task) => ({ task: ref(task), reason: 'Task detail is unaffected by feature integration step' })) } });
    const detail = StageRevisionSchema.parse({ ...flow.detailStage, revision: 2, artifact: ref(fixed), changeReason: fixed.workflow!.changeReason });
    flow.write(detail, [fixed]);
    const result = checkPlanReadiness(flow.store, { projectId: base.projectId, detailStage: ref(detail),
      idempotencyKey: 'corrected-check', issuedAt: time, expectedPlanRevision: 3 });
    assert.ok(result.readyPlan, JSON.stringify(result.check));
    const checks = planReadinessHistory(flow.store, base.projectId, flow.plan.id);
    assert.equal(checks.length, 2);
    assert.equal(checks[0]!.ready, false); assert.equal(checks[1]!.ready, true);
    assert.equal(flow.store.get(base.projectId, flow.detailedTasks[0]!.id)?.revision, 2);
  } finally { flow.store.close(); }
});

test('a ready revision cannot change the checked delivery content or claim an unchecked result', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish(); flow.check();
    const history = flow.store.history(base.projectId);
    const forged = structuredClone(history);
    const ready = forged.find((record) => record.kind === 'implementation_plan_revision' && record.revision === 3);
    assert.equal(ready?.kind, 'implementation_plan_revision');
    if (ready?.kind !== 'implementation_plan_revision') return;
    ready.workflow!.finalVerification = [];
    const result = validateRecords(forged);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === 'plan_not_ready'));
    const exported = flow.store.exportProject(base.projectId);
    const restored = new ProjectStore(':memory:');
    try {
      restored.importProject(exported);
      assert.deepEqual(restored.exportProject(base.projectId), exported);
      assert.deepEqual(planReadinessHistory(restored, base.projectId, flow.plan.id), planReadinessHistory(flow.store, base.projectId, flow.plan.id));
    } finally { restored.close(); }
  } finally { flow.store.close(); }
});

test('existing design and detailed plan revisions can be reused for a new feature revision after current-request checks', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish();
    const prior = flow.store.get(base.projectId, feature.id)!;
    assert.equal(prior.kind, 'feature_revision');
    if (prior.kind !== 'feature_revision') return;
    const current = { ...prior, revision: 2, previousRevision: 1, changeReason: 'Reassess unchanged behavior against current priorities' };
    flow.store.mutate({ schemaVersion: 1, id: 'feature-change', projectId: base.projectId, issuedAt: time,
      idempotencyKey: 'feature-change', command: 'record_decision_suggestion', targetId: feature.id, expectedRevision: 1,
      payload: { decision: flow.decision } }, () => [current]);
    const understanding = UnderstandingRevisionSchema.parse({ ...flow.understanding, revision: 2, feature: ref(current),
      changeReason: 'Current priorities checked against retained behavior' });
    const understand = StageRevisionSchema.parse({ ...flow.understandStage, revision: 2, feature: ref(current), artifact: ref(understanding) });
    flow.write(understand, [understanding]);
    const reuse = (artifact: FactoryRecord) => ({ check: comparison([request, artifact]),
      criterionMap: flow.criteria.map((criterion) => ({ current: criterion, existing: criterion })) });
    const design = StageRevisionSchema.parse({ ...flow.designStage, revision: 2, feature: ref(current), previousStage: ref(understand), reuse: reuse(flow.design) });
    flow.write(design, []);
    const plan = StageRevisionSchema.parse({ ...flow.planStage, revision: 2, feature: ref(current), previousStage: ref(design),
      artifact: ref(flow.detailedPlan), reuse: reuse(flow.detailedPlan) });
    flow.write(plan, []);
    const detail = StageRevisionSchema.parse({ ...flow.detailStage, revision: 2, feature: ref(current), previousStage: ref(plan) });
    flow.write(detail, []);
    const result = checkPlanReadiness(flow.store, { projectId: base.projectId, detailStage: ref(detail),
      idempotencyKey: 'current-request-check', issuedAt: time, expectedPlanRevision: 2 });
    assert.ok(result.readyPlan, JSON.stringify(result.check));
    assert.equal(flow.store.get(base.projectId, flow.design.id)?.revision, 1);
    assert.equal(flow.store.get(base.projectId, flow.detailedTasks[0]!.id)?.revision, 2);
    const ready = flow.store.get(base.projectId, flow.plan.id);
    assert.equal(ready?.kind, 'implementation_plan_revision');
    if (ready?.kind === 'implementation_plan_revision') assert.deepEqual(ready.feature, ref(current));
  } finally { flow.store.close(); }
});

test('a suitable BUILD-02 design can be reused without a metadata-only rewrite', () => {
  const flow = setup();
  try {
    delete flow.design.workflow;
    flow.store.mutate({ schemaVersion: 1, id: 'existing-design', projectId: base.projectId, issuedAt: time,
      idempotencyKey: 'existing-design', command: 'record_decision_suggestion', targetId: flow.design.id, expectedRevision: 0,
      payload: { decision: flow.decision } }, () => [flow.design, flow.decision]);
    flow.write(flow.understandStage, [flow.understanding]);
    flow.designStage.reuse = { check: comparison([request, flow.design]),
      criterionMap: flow.criteria.map((criterion) => ({ current: criterion, existing: criterion })) };
    flow.write(flow.designStage, []);
    flow.write(flow.planStage, [flow.plan, ...flow.tasks]); flow.finish();
    assert.ok(flow.check().readyPlan);
    assert.equal(flow.store.get(base.projectId, flow.design.id)?.revision, 1);
  } finally { flow.store.close(); }
});

test('unresolved source-comparison findings cannot be discarded by the deterministic ready transition', () => {
  const flow = setup();
  try {
    flow.detailedPlan.readiness.comparison = { ...comparison([request, flow.design]), result: 'failed',
      findings: [{ result: 'failed', description: 'Source analyst identified an unrepresented failure case',
        criterionId: flow.criteria[0]!.id, sourceRefs: [source(request)], evidence: [] }] };
    flow.start(); flow.finish();
    const result = flow.check();
    assert.equal(result.readyPlan, null);
    assert.equal(result.check?.kind, 'plan_readiness_revision');
    if (result.check?.kind === 'plan_readiness_revision') assert.ok(result.check.findings.some((finding) => finding.code === 'source_gap'));
  } finally { flow.store.close(); }
});


function reuseForCurrentFeature(flow: ReturnType<typeof setup>, options: {
  criterionChange?: 'amend' | 'demote'; additionalRequest?: boolean;
} = {}) {
  const prior = flow.store.get(base.projectId, feature.id)!;
  assert.equal(prior.kind, 'feature_revision');
  if (prior.kind !== 'feature_revision') throw new Error('missing feature');
  const writes: FactoryRecord[] = [];
  const current = { ...prior, revision: 2, previousRevision: 1, criteria: [...prior.criteria],
    sourceRequests: [...prior.sourceRequests], decisions: [...prior.decisions], changeReason: 'Checked current request against existing artifacts' };
  if (options.criterionChange) {
    const index = options.criterionChange === 'demote' ? 1 : 0;
    const old = flow.store.get(base.projectId, current.criteria[index]!.id)!;
    assert.equal(old.kind, 'criterion');
    if (old.kind !== 'criterion') throw new Error('missing criterion');
    const criterion = { ...old, revision: 2,
      ...(options.criterionChange === 'demote' ? { requirement: 'optional' as const } :
        { expectedBehavior: 'Common interface also preserves the clarified error contract' }) };
    writes.push(criterion); current.criteria[index] = ref(criterion);
    if (options.criterionChange === 'demote') {
      const decision = DecisionChangeSchema.parse({ ...flow.decision, id: 'demotion-decision',
        questionOrChange: 'Defer optional second-system case', originalInstruction: 'Make the second-system criterion optional',
        affectedRecords: [ref(current), ref(criterion)],
        scopeChanges: [{ featureId: current.id, fromRevision: 1, toRevision: 2, criterionId: criterion.id, action: 'demote' }] });
      current.decisions.push(ref(decision)); writes.push(decision);
    }
  }
  const additional = { ...baseline.find((record) => record.kind === 'request')!, id: 'request-current',
    originalText: 'Keep feature X across every system; ERPNext remains an example.', interpretationRefs: [], dispositionRefs: [],
    clientRequestId: 'current-request', disposition: 'unclassified' as const };
  if (options.additionalRequest) { writes.push(additional); current.sourceRequests.push(ref(additional)); }
  flow.store.mutate({ schemaVersion: 1, id: 'current-feature', projectId: base.projectId, issuedAt: time,
    idempotencyKey: 'current-feature', command: 'record_decision_suggestion', targetId: feature.id, expectedRevision: 1,
    payload: { decision: flow.decision } }, () => [...writes, current]);
  const understanding = UnderstandingRevisionSchema.parse({ ...flow.understanding, revision: 2, feature: ref(current),
    sourceRequests: current.sourceRequests, criteria: current.criteria,
    scope: options.additionalRequest ? [...flow.understanding.scope, { request: ref(additional), term: 'ERPNext', role: 'example' }] : flow.understanding.scope });
  const understand = StageRevisionSchema.parse({ ...flow.understandStage, revision: 2, feature: ref(current),
    sourceRequests: current.sourceRequests, criteria: current.criteria, artifact: ref(understanding) });
  flow.write(understand, [understanding]);
  const reuse = (artifact: FactoryRecord) => ({ check: comparison([...current.sourceRequests, artifact]),
    criterionMap: current.criteria.map((criterion, index) => ({ current: criterion, existing: flow.criteria[index]! })) });
  const design = StageRevisionSchema.parse({ ...flow.designStage, revision: 2, feature: ref(current),
    sourceRequests: current.sourceRequests, criteria: current.criteria, previousStage: ref(understand), reuse: reuse(flow.design) });
  flow.write(design, []);
  const plan = StageRevisionSchema.parse({ ...flow.planStage, revision: 2, feature: ref(current),
    sourceRequests: current.sourceRequests, criteria: current.criteria, previousStage: ref(design),
    artifact: ref(flow.detailedPlan), reuse: reuse(flow.detailedPlan) });
  flow.write(plan, []);
  const detail = StageRevisionSchema.parse({ ...flow.detailStage, revision: 2, feature: ref(current),
    sourceRequests: current.sourceRequests, criteria: current.criteria, previousStage: ref(plan) });
  flow.write(detail, []);
  return { current, detail, additional, check: () => checkPlanReadiness(flow.store, { projectId: base.projectId,
    detailStage: ref(detail), idempotencyKey: 'review-current-check', issuedAt: time, expectedPlanRevision: 2 }) };
}

test('review finding 1: ready staged plans accept verified retained tasks for dispatch and review', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish(); const result = flow.check(); assert.ok(result.readyPlan);
    const plan = result.readyPlan;
    const task = flow.detailedTasks[0]!;
    const mapping = { ...baseline.find((record) => record.kind === 'task_mapping')!, id: 'mapping-staged',
      firstMateTaskId: 'execution-task', detailedPlanTask: ref(task), feature, criteria: task.criteria };
    const assignment = { ...baseline.find((record) => record.kind === 'assignment')!, id: 'assignment-staged',
      feature, design: ref(flow.design), plan, detailedPlanTask: ref(task), firstMateTaskId: 'execution-task',
      criteria: task.criteria, sourceRefs: [request, flow.design, plan, task].map(source),
      selectedContext: [request, flow.design, result.readyPlan!, task].map((record) => ({ source: source(record), truncated: false })),
      instructionFidelity: comparison([request, flow.design, plan, task]) };
    const review = { ...baseline.find((record) => record.kind === 'product_review')!, id: 'review-staged',
      feature, design: ref(flow.design), plan, detailedPlanTasks: [ref(task)], assignments: [ref(assignment)],
      results: [], outcome: 'incomplete', originalRequests: [request], sourceRefs: [request, flow.design, plan].map(source),
      sourceComparison: comparison([request, flow.design, plan, task]), instructionFidelity: comparison([request, flow.design, plan, task]),
      planConformance: comparison([request, flow.design, plan, task]) };
    const records = [...flow.store.history(base.projectId), mapping, assignment, review];
    const dispatch = validateAssignmentForDispatch(records, ref(assignment));
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch));
    assert.equal(validateRecords(records).ok, true, JSON.stringify(validateRecords(records)));
    for (const mismatch of ['feature', 'design'] as const) {
      const invalid = structuredClone(records);
      const ready = invalid.find((record) => record.kind === 'implementation_plan_revision' && record.revision === 3)!;
      (ready as unknown as Record<string, unknown>)[mismatch] = { id: `unrelated-${mismatch}`, revision: 1 };
      const result = validateAssignmentForDispatch(invalid, ref(assignment));
      assert.equal(result.ok, false, `Incompatible ${mismatch} must fail`);
      if (!result.ok) assert.ok(result.issues.some((issue) => issue.recordId === assignment.id && issue.path === `task.${mismatch}`));
    }
    const withoutRetention = structuredClone(records);
    const ready = withoutRetention.find((record) => record.kind === 'implementation_plan_revision' && record.revision === 3);
    assert.ok(ready?.kind === 'implementation_plan_revision'); ready.workflow!.retainedTasks = [];
    assert.equal(validateAssignmentForDispatch(withoutRetention, ref(assignment)).ok, false);
  } finally { flow.store.close(); }
});

test('review finding 2: legacy ready plans cannot dispatch draft or incomplete tasks', () => {
  for (const field of ['boundaries', 'verificationCases'] as const) {
    const records = structuredClone(baseline);
    const task = records.find((record) => record.kind === 'detailed_plan_task');
    assert.ok(task?.kind === 'detailed_plan_task'); task.draft = true; delete task[field];
    const result = validateAssignmentForDispatch(records, { id: 'assignment-1', revision: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === 'detail_gap'));
  }
});

test('review finding 3: all explicit scope roles retain their meaning in design and plan', () => {
  for (const role of ['required', 'entire_scope'] as const) for (const owner of ['design', 'plan'] as const) {
    const flow = setup(true);
    try {
      flow.understanding.scope[0]!.role = role;
      flow.design.workflow!.scope[0]!.coverage = role;
      flow.plan.workflow!.scope[0]!.coverage = role;
      flow.detailedPlan.workflow!.scope[0]!.coverage = role;
      (owner === 'design' ? flow.design : flow.detailedPlan).workflow!.scope[0]!.coverage = 'general';
      flow.start(); flow.finish(); const result = flow.check();
      assert.equal(result.readyPlan, null);
      assert.ok(result.check?.kind === 'plan_readiness_revision');
      assert.ok(result.check.findings.some((finding) => finding.path === 'workflow.scope' &&
        finding.record.id === (owner === 'design' ? flow.design.id : flow.plan.id)));
    } finally { flow.store.close(); }
  }
});

test('review finding 4: reuse translates changed prerequisite criteria in the generated ready plan', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish();
    const current = reuseForCurrentFeature(flow, { criterionChange: 'amend' });
    const result = current.check(); assert.ok(result.readyPlan, JSON.stringify(result.check));
    const ready = flow.store.get(base.projectId, flow.plan.id);
    assert.ok(ready?.kind === 'implementation_plan_revision');
    assert.deepEqual(ready.dependencies[0]!.needs, { kind: 'criterion', criterion: current.current.criteria[0] });
    assert.equal(flow.store.get(base.projectId, flow.detailedTasks[0]!.id)?.revision, 2);
    assert.equal(validateRecords(flow.store.history(base.projectId)).ok, true);
  } finally { flow.store.close(); }
});

test('review finding 5: checked reuse covers additional requests while current scope entries still apply', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish();
    const current = reuseForCurrentFeature(flow, { additionalRequest: true });
    assert.ok(current.check().readyPlan);
    for (const owner of ['design_revision', 'implementation_plan_revision'] as const) {
      const records = flow.store.history(base.projectId);
      const artifact = records.find((record) => record.kind === owner && record.revision === (owner === 'design_revision' ? 1 : 2));
      assert.ok(artifact?.kind === owner);
      if (artifact.kind !== 'design_revision' && artifact.kind !== 'implementation_plan_revision') continue;
      artifact.workflow!.scope.push({ request: ref(current.additional), term: 'ERPNext', coverage: 'example_only' });
      assert.ok(planReadinessFindings(records, current.detail).some((finding) =>
        finding.code === 'example_driven_narrowing' && finding.record.id === artifact.id));
    }
  } finally { flow.store.close(); }
});

test('review finding 6: checked legacy decisions remain settled without rewriting their design', () => {
  for (const disposition of ['selected', 'rejected'] as const) {
    const flow = setup();
    try {
      delete flow.design.workflow; delete flow.decision.choice; flow.decision.disposition = disposition;
      flow.design.unresolvedQuestions = [flow.decision.questionOrChange];
      flow.store.mutate({ schemaVersion: 1, id: 'legacy-choice', projectId: base.projectId, issuedAt: time,
        idempotencyKey: 'legacy-choice', command: 'record_decision_suggestion', targetId: flow.design.id, expectedRevision: 0,
        payload: { decision: flow.decision } }, () => [flow.design, flow.decision]);
      flow.write(flow.understandStage, [flow.understanding]);
      flow.designStage.reuse = { check: comparison([request, flow.design]),
        criterionMap: flow.criteria.map((criterion) => ({ current: criterion, existing: criterion })) };
      flow.write(flow.designStage, []); flow.write(flow.planStage, [flow.plan, ...flow.tasks]); flow.finish();
      assert.ok(flow.check().readyPlan);
      assert.equal(flow.store.get(base.projectId, flow.design.id)?.revision, 1);
      assert.equal(flow.store.get(base.projectId, flow.decision.id)?.revision, 1);
    } finally { flow.store.close(); }
  }
});

test('review finding 7: classified technical questions do not become product approvals', () => {
  for (const kind of ['technical', 'product'] as const) {
    const flow = setup();
    try {
      flow.decision.choice = { kind, state: 'open' }; flow.decision.disposition = 'proposed';
      flow.design.unresolvedQuestions = [flow.decision.questionOrChange];
      flow.start(); flow.finish(); const result = flow.check();
      assert.equal(Boolean(result.readyPlan), kind === 'technical');
      assert.ok(result.check?.kind === 'plan_readiness_revision');
      assert.equal(result.check.findings.some((finding) => finding.code === 'unresolved_product_decision'), kind === 'product');
    } finally { flow.store.close(); }
  }
});

test('review finding 8: an approved optional demotion need not have delivery coverage', () => {
  const flow = setup();
  try {
    flow.tasks.splice(1); flow.detailedTasks.splice(1);
    for (const plan of [flow.plan, flow.detailedPlan]) {
      plan.deliverySequence.splice(1); plan.workflow!.slices.splice(1); plan.dependencies = [];
    }
    flow.start(); flow.finish();
    const current = reuseForCurrentFeature(flow, { criterionChange: 'demote' });
    assert.ok(current.check().readyPlan);
    // Electing to deliver an optional criterion still requires a matching task.
    const records = flow.store.history(base.projectId);
    const plan = records.find((record) => record.id === flow.plan.id && record.revision === 2);
    assert.ok(plan?.kind === 'implementation_plan_revision');
    plan.workflow!.slices[0]!.criteria.push(flow.criteria[1]!);
    assert.ok(planReadinessFindings(records, current.detail).some((finding) => finding.code === 'dropped_behavior'));
  } finally { flow.store.close(); }
});

test('review finding 9: explicit maintenance tasks and their slices need no fabricated criterion', () => {
  const flow = setup(true);
  try {
    const draft = DetailedPlanTaskSchema.parse({ ...flow.tasks[0]!, id: 'maintenance-task', criteria: [],
      maintenanceObjective: 'Remove the unused error helper while retaining current behavior' });
    const detailed = DetailedPlanTaskSchema.parse({ ...flow.detailedTasks[0]!, id: draft.id, criteria: [],
      maintenanceObjective: draft.maintenanceObjective });
    flow.tasks.push(draft); flow.detailedTasks.push(detailed);
    for (const [plan, task] of [[flow.plan, draft], [flow.detailedPlan, detailed]] as const) {
      plan.deliverySequence.push(ref(task));
      plan.workflow!.slices.push({ id: 'maintenance-slice', behavior: task.maintenanceObjective!, criteria: [], tasks: [ref(task)] });
      plan.workflow!.integrationSteps.push('Verify cleanup alongside the message correction');
    }
    flow.start(); flow.finish(); assert.ok(flow.check().readyPlan);
    const records = flow.store.history(base.projectId);
    const task = records.find((record) => record.id === detailed.id && record.revision === 2);
    assert.ok(task?.kind === 'detailed_plan_task'); delete task.maintenanceObjective;
    assert.ok(planReadinessFindings(records, flow.detailStage).some((finding) => finding.code === 'invented_scope'));
  } finally { flow.store.close(); }
});

function replan(flow: ReturnType<typeof setup>, selected: ImplementationPlanRevision, options: {
  designMap: NonNullable<StageRevision['reuse']>['criterionMap'];
  planMap?: NonNullable<StageRevision['reuse']>['criterionMap'];
  criteria: Ref[];
  refineReady?: boolean;
}) {
  const prior = flow.store.get(base.projectId, feature.id);
  assert.ok(prior?.kind === 'feature_revision');
  const revision = prior.revision + 1;
  const current = { ...prior, revision, previousRevision: prior.revision, criteria: options.criteria,
    changeReason: 'Recheck delivery against current criteria' };
  const changedCriteria = options.criteria.flatMap((criterion) => {
    const existing = flow.store.get(base.projectId, criterion.id);
    assert.ok(existing?.kind === 'criterion');
    return existing.revision === criterion.revision ? [] : [{ ...existing, revision: criterion.revision }];
  });
  flow.store.mutate({ schemaVersion: 1, id: `replan-${revision}`, projectId: base.projectId, issuedAt: time,
    idempotencyKey: `replan-${revision}`, command: 'record_decision_suggestion', targetId: feature.id,
    expectedRevision: prior.revision, payload: { decision: flow.decision } }, () => [...changedCriteria, current]);
  const currentFields = { revision, feature: ref(current), criteria: current.criteria };
  const understanding = { ...flow.understanding, ...currentFields };
  const understand = { ...flow.understandStage, ...currentFields, artifact: ref(understanding) };
  const revisedDesign = { ...flow.design, revision: 2, feature: ref(current),
    workflow: { ...flow.design.workflow!, understanding: ref(understanding), changeReason: 'Refine the implementation design' } };
  const design = { ...flow.designStage, ...currentFields, previousStage: ref(understand),
    ...(options.refineReady ? { artifact: ref(revisedDesign) } :
      { reuse: { check: comparison([request, flow.design]), criterionMap: options.designMap } }) };
  const plan = { ...flow.planStage, ...currentFields, artifact: ref(selected), previousStage: ref(design),
    ...(options.planMap ? { reuse: { check: comparison([request, selected]), criterionMap: options.planMap } } : {}) };
  flow.write(understand, [understanding]);
  flow.write(design, options.refineReady ? [revisedDesign] : []);
  const tasks = options.planMap ? [] : flow.detailedTasks.map((task, index) => ({
    ...task, revision: task.revision + 1, feature: ref(current), plan: ref(selected), criteria: [options.criteria[index]!],
  }));
  const authored = options.planMap ? [] : [{ ...selected, feature: ref(current), deliverySequence: tasks.map(ref), dependencies: [],
    workflow: { ...selected.workflow!, slices: selected.workflow!.slices.map((slice, index) => ({ ...slice,
      criteria: tasks[index]!.criteria, tasks: [ref(tasks[index]!)] })) } }, ...tasks];
  flow.write(plan, authored);
  const refined = { ...selected, revision: selected.revision + 1, feature: ref(current), design: ref(revisedDesign),
    readiness: { ready: false, comparison: comparison([request, revisedDesign]) },
    workflow: { ...selected.workflow!, readinessCheck: undefined,
      changeReason: 'Refine the reused plan while retaining unchanged tasks',
      retainedTasks: selected.deliverySequence.map((task) => ({ task, reason: 'Task behavior remains valid' })) } };
  const detailedPlan = options.refineReady ? ImplementationPlanRevisionSchema.parse(refined) : selected;
  const detail = { ...flow.detailStage, ...currentFields, artifact: ref(detailedPlan), previousStage: ref(plan) };
  flow.write(detail, options.refineReady ? [detailedPlan] : []);
  const result = checkPlanReadiness(flow.store, { projectId: base.projectId, detailStage: ref(detail),
    idempotencyKey: `check-replan-${revision}`, issuedAt: time, expectedPlanRevision: detailedPlan.revision });
  return { current, tasks, result };
}

test('1069-1: a reused prerequisite must supply every translated dependency criterion', () => {
  const flow = setup();
  try {
    const [prerequisite, needs] = flow.criteria as [Ref, Ref];
    flow.detailedPlan.dependencies[0]!.needs = { kind: 'criterion', criterion: needs };
    flow.start(); flow.finish();
    const [a, b] = flow.criteria.map((criterion) => ({ ...criterion, revision: 2 })) as [Ref, Ref];
    const map = [{ existing: prerequisite, current: a }, { existing: needs, current: a }, { existing: needs, current: b }];
    const { result } = replan(flow, flow.detailedPlan, { criteria: [a, b], designMap: map, planMap: map });
    assert.equal(result.readyPlan, null);
    assert.ok(result.check?.kind === 'plan_readiness_revision' && result.check.findings.some((finding) => finding.code === 'dependency_gap'));
  } finally { flow.store.close(); }
});

test('1069-2: readiness translates a dependency once when a split retains its original criterion', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish();
    const [a, b] = flow.criteria as [Ref, Ref];
    const map = [{ existing: a, current: a }, { existing: a, current: b }, { existing: b, current: b }];
    const { result } = replan(flow, flow.detailedPlan, { criteria: [a, b], designMap: map, planMap: map });
    assert.ok(result.readyPlan, JSON.stringify(result.check));
    const ready = flow.store.get(base.projectId, result.readyPlan.id, result.readyPlan.revision);
    assert.ok(ready?.kind === 'implementation_plan_revision');
    assert.deepEqual(ready.dependencies.map((dependency) => dependency.needs),
      [a, b].map((criterion) => ({ kind: 'criterion', criterion })));
  } finally { flow.store.close(); }
});

test('1069-3: new tasks against the current feature keep their explicit assignment criteria', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish();
    const [a, b] = flow.criteria as [Ref, Ref];
    const map = [{ existing: a, current: a }, { existing: a, current: b }, { existing: b, current: b }];
    const { current, tasks, result } = replan(flow, { ...flow.detailedPlan, revision: 3 }, { criteria: [a, b], designMap: map });
    assert.ok(result.readyPlan, JSON.stringify(result.check));
    const task = tasks[0]!;
    const mapping = { ...baseline.find((record) => record.kind === 'task_mapping')!, feature: ref(current),
      detailedPlanTask: ref(task), criteria: [a] };
    const assignment = { ...baseline.find((record) => record.kind === 'assignment')!, feature: ref(current),
      design: ref(flow.design), plan: result.readyPlan, detailedPlanTask: ref(task), criteria: [a],
      sourceRefs: [request, flow.design, result.readyPlan, task].map(source),
      selectedContext: [request, flow.design, result.readyPlan!, task].map((record) => ({ source: source(record), truncated: false })),
      instructionFidelity: comparison([request, flow.design, result.readyPlan, task]) };
    const dispatch = validateAssignmentForDispatch([...flow.store.history(base.projectId), mapping, assignment], ref(assignment));
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch));
  } finally { flow.store.close(); }
});

test('1069-4: repeated checked reuse carries prior criterion translations for retained tasks and slices', () => {
  const flow = setup(true);
  try {
    flow.start(); flow.finish();
    const original = flow.criteria[0]!;
    let selected = { ...flow.detailedPlan, revision: 3 };
    let existing = original;
    for (const revision of [2, 3, 4]) {
      const current = { ...original, revision };
      const { result } = replan(flow, selected, { criteria: [current],
        designMap: [{ existing: original, current }],
        ...(revision === 2 ? {} : { planMap: [{ existing, current }] }) });
      assert.ok(result.readyPlan, JSON.stringify(result.check));
      const ready = flow.store.get(base.projectId, result.readyPlan.id, result.readyPlan.revision);
      assert.ok(ready?.kind === 'implementation_plan_revision');
      assert.deepEqual(ready.deliverySequence, [{ id: flow.detailedTasks[0]!.id, revision: 3 }]);
      selected = ready;
      existing = current;
    }
  } finally { flow.store.close(); }
});

test('1090-2: Detail can refine a reused ready plan and retain its prior criterion mappings', () => {
  const flow = setup(true);
  try {
    flow.start(); flow.finish();
    const original = flow.criteria[0]!;
    const second = { ...original, revision: 2 };
    const initial = replan(flow, flow.detailedPlan, { criteria: [second],
      designMap: [{ existing: original, current: second }], planMap: [{ existing: original, current: second }] });
    assert.ok(initial.result.readyPlan);
    const selected = flow.store.get(base.projectId, initial.result.readyPlan.id, initial.result.readyPlan.revision);
    assert.ok(selected?.kind === 'implementation_plan_revision');
    const third = { ...original, revision: 3 };
    const refined = replan(flow, selected, { criteria: [third], refineReady: true,
      designMap: [], planMap: [{ existing: second, current: third }] });
    assert.ok(refined.result.readyPlan, JSON.stringify(refined.result.check));
    const ready = flow.store.get(base.projectId, refined.result.readyPlan.id, refined.result.readyPlan.revision);
    assert.ok(ready?.kind === 'implementation_plan_revision');
    assert.deepEqual(ready.deliverySequence, flow.detailedTasks.map(ref));
    assert.deepEqual(ready.workflow!.slices, selected.workflow!.slices);
    const task = flow.detailedTasks[0]!;
    const mapping = { ...baseline.find((record) => record.kind === 'task_mapping')!, feature: ref(refined.current),
      detailedPlanTask: ref(task), criteria: [third] };
    const assignment = { ...baseline.find((record) => record.kind === 'assignment')!, feature: ref(refined.current),
      design: ready.design, plan: ref(ready), detailedPlanTask: ref(task), criteria: [third],
      sourceRefs: [request, ready.design, ready, task].map(source), selectedContext: [request, ready.design, ready, task].map((record) => ({ source: source(record), truncated: false })),
      instructionFidelity: comparison([request, ready.design, ready, task]) };
    const dispatch = validateAssignmentForDispatch([...flow.store.history(base.projectId), mapping, assignment], assignment);
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch));
    const withoutRetention = flow.store.history(base.projectId);
    const detail = withoutRetention.find((record) => record.kind === 'stage_revision' && record.stage === 'detail' && record.revision === 3);
    const refinedPlan = withoutRetention.find((record) => record.kind === 'implementation_plan_revision' && record.revision === selected.revision + 1);
    assert.ok(detail?.kind === 'stage_revision' && refinedPlan?.kind === 'implementation_plan_revision');
    refinedPlan.workflow!.retainedTasks = [];
    assert.ok(planReadinessFindings(withoutRetention, detail).some((finding) => finding.code === 'invented_scope'));
  } finally { flow.store.close(); }
});

for (const narrow of [false, true]) test(`BUILD-07 prepares ${narrow ? 'a correction' : 'a general feature'} from the BUILD-06 ready revision`, () => {
  const flow = setup(narrow);
  const directory = mkdtempSync(join(tmpdir(), 'sf-staged-brief-'));
  try {
    flow.start(); flow.finish();
    const ready = flow.check().readyPlan; assert.ok(ready);
    const task = flow.detailedTasks[0]!;
    const plan = flow.store.get(base.projectId, ready.id, ready.revision);
    assert.ok(plan?.kind === 'implementation_plan_revision');
    const mapping = { ...baseline.find((record) => record.kind === 'task_mapping')!,
      id: 'staged-brief-mapping', firstMateTaskId: 'staged-brief-worker', feature: plan.feature,
      detailedPlanTask: ref(task), criteria: task.criteria, dependencies: [] };
    flow.store.mutate({ schemaVersion: 1, id: 'map-staged-brief', projectId: base.projectId,
      issuedAt: time, idempotencyKey: 'map-staged-brief', command: 'map_manage_execution_task', targetId: mapping.id,
      expectedRevision: 0, payload: { action: 'map', feature: plan.feature, criteria: task.criteria,
        detailedPlanTask: ref(task), task: { kind: 'existing', firstMateTaskId: 'staged-brief-worker' },
        dependencies: [], reason: 'Map the already-existing execution task' } }, () => [mapping]);
    const required = requiredAssignmentContext(flow.store.history(base.projectId), { projectId: base.projectId,
      feature: plan.feature, design: plan.design, plan: ref(plan), detailedPlanTask: ref(task), criteria: task.criteria });
    const sourceFiles = required.sources.filter((source) => !source.record).map((source, index) => {
      const path = join(directory, `source-${index}.txt`); writeFileSync(path, 'Existing implementation and exact captured source.');
      return { source, path };
    });
    const briefPath = join(directory, 'brief.md');
    writeFileSync(briefPath, readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url), 'utf8'));
    const result = prepareWorkerBrief(flow.store, { projectId: base.projectId, assignmentId: 'staged-brief-assignment',
      attemptId: 'staged-brief-attempt', expectedRevision: 0, idempotencyKey: 'prepare-staged-brief', issuedAt: time,
      detailedPlanTask: ref(task), plan: ref(plan), firstMateTaskId: 'staged-brief-worker',
      returnLocation: 'data/staged-brief-worker/report.md', briefPath, sourceFiles });
    assert.equal(result.ok, true, JSON.stringify(result));
    const assignment = flow.store.get(base.projectId, result.assignment.id);
    assert.ok(assignment?.kind === 'assignment');
    assert.equal(assignment.plan.revision, 3); assert.equal(assignment.detailedPlanTask.revision, 2);
    for (const record of [flow.decision, flow.understanding, flow.detailStage]) {
      assert.ok(assignment.selectedContext.some((context) => context.source.uri === recordSource(record).uri));
    }
    assert.equal(checkWorkerBrief(flow.store, base.projectId, ref(assignment), briefPath, fakeJudge).ok, true);
  } finally { flow.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('review 1377 finding 3: checked reuse remains selected after priority and workflow edits before assignment', () => {
  const flow = setup();
  const display = new ProjectStore(':memory:');
  try {
    flow.start(); flow.finish();
    const reused = reuseForCurrentFeature(flow, { additionalRequest: true });
    const ready = reused.check(); assert.ok(ready.readyPlan);
    const task = flow.detailedTasks[0]!;
    const template = baseline.find((record) => record.kind === 'task_mapping'); assert.ok(template?.kind === 'task_mapping');
    const mapping = { ...template, id: 'mapping-reused', firstMateTaskId: 'execution-reused', feature: ref(reused.current),
      detailedPlanTask: ref(task), criteria: task.criteria, dependencies: [] };
    const prioritized = { ...reused.current, revision: 3, previousRevision: 2, priority: 4,
      state: 'in_progress' as const, changeReason: 'Prioritize checked work without changing scope' };
    display.importProject({ schemaVersion: 1, projectId: base.projectId,
      history: [...flow.store.history(base.projectId), mapping, prioritized], receipts: [] });
    const view = projectView(display, { projectId: base.projectId });
    assert.deepEqual(view.features[0]!.plan && ref(view.features[0]!.plan), ref(ready.readyPlan));
    const row = workView(view).rows[0]!;
    assert.deepEqual(row.reasons.filter((reason) => reason.startsWith('Product readiness')), []);
    assert.equal(row.unknowns.includes('Unknown — selected product plan unavailable'), false);
  } finally { display.close(); flow.store.close(); }
});

test('artifact editors compose checked reuse through ready-plan lineage for retained tasks and slices', () => {
  const flow = setup();
  try {
    flow.start(); flow.finish();
    const original = flow.criteria;
    const second = original.map(c => ({ ...c, revision: 2 }));
    const splitMap = [{ existing: original[0]!, current: second[0]! }, { existing: original[0]!, current: second[1]! }, { existing: original[1]!, current: second[1]! }];
    const initial = replan(flow, flow.detailedPlan, { criteria: second,
      designMap: splitMap, planMap: splitMap });
    assert.ok(initial.result.readyPlan);
    const selected = flow.store.get(base.projectId, initial.result.readyPlan.id, initial.result.readyPlan.revision);
    assert.ok(selected?.kind === 'implementation_plan_revision');
    const third = original.map(c => ({ ...c, revision: 3 }));
    const refined = replan(flow, selected, { criteria: third,
      designMap: splitMap.map(entry => ({ existing: entry.existing, current: { ...entry.current, revision: 3 } })), planMap: second.map((existing, i) => ({ existing, current: third[i]! })) });
    assert.ok(refined.result.readyPlan);
    const view = projectView(flow.store, { projectId: base.projectId });
    const html = renderFeature(view, view.features[0]!);
    const contexts = [...html.matchAll(/name="context" value="([^"]*)"/gu)].map(match => JSON.parse(match[1]!.replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&')) as EditContext);
    const context = contexts.find(c => c.kind === 'plan'); assert.ok(context?.kind === 'plan');
    const command = buildEditCommand(context, { reason: 'Refine composed reused artifacts' }, 'composed-editor', '2026-11-12T12:00:00Z');
    assert.ok(command.command === 'design_plan_feature' && 'tasks' in command.payload);
    assert.deepEqual(command.payload.tasks[0]!.criteria, third);
    assert.deepEqual(command.payload.plan.workflow!.slices[0]!.criteria, third);
    applyCommand(flow.store, command);
  } finally { flow.store.close(); }
});
