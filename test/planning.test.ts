import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  ProjectStore, RecordsSchema, UnderstandingRevisionSchema, DesignRevisionSchema,
  ImplementationPlanRevisionSchema, DetailedPlanTaskSchema, StageRevisionSchema, DecisionChangeSchema,
  recordStage, checkPlanReadiness, planReadinessHistory, ref, validateRecords,
  type FactoryRecord, type StageRevision,
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
    flow.detailedTasks[0]!.criteria = []; flow.detailedTasks[0]!.maintenanceObjective = 'Unrequested enhancement';
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
