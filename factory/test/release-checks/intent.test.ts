import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectStore, runFeature, validateReviewForCompletion, recordDecisionSuggestion, projectView,
  validateRecords, ref } from '../../src/index.js';
import { scenario } from '../milestone-helper.js';
import { setup, semanticGate, product, cases, projectId, at } from './helper.js';

// The retrospective's example-to-scope failure is intentionally exercised with
// source text omitted from *all* derived criteria, not merely a missing ID.
test('CHECK-01 — several behaviors survive planning or remain visibly unresolved', t => {
  const flow = scenario({ bootstrap: true, originalRequest: cases['CHECK-01']!.originalRequest }); t.after(flow.close);
  flow.mode({ planFailure: true });
  assert.throws(() => runFeature(flow.config, 'prepare'), /plan_review_failed/);
  const recorded = JSON.parse(readFileSync(join(flow.config.runDirectory, 'plan-check-agent.json'), 'utf8'));
  assert.equal(recorded.verdict.verdict, 'fail'); assert.ok(recorded.verdict.findings.length);
  assert.deepEqual(Object.keys(flow.wrapper.read().tasks), ['permanent-guard']);
  assert.equal(existsSync(join(flow.root, 'worker-started')), false);
  const store = new ProjectStore(flow.database); t.after(() => store.close());
  const request = store.records(projectId).find(r => r.kind === 'request');
  assert.equal(request?.kind === 'request' && request.originalText, cases['CHECK-01']!.originalRequest);
  assert.equal(store.records(projectId).some(r => r.kind === 'implementation_plan_revision' && r.readiness.ready), false);
  const gate = setup(t, 'CHECK-01');
  assert.ok(semanticGate(gate, 'CHECK-01').findings.some(f => f.code === 'omitted_behavior'));
});

test('CHECK-02 — adjacent enhancement remains a suggestion outside current scope', t => {
  const flow = setup(t, 'CHECK-02'); const feature = flow.store.get(projectId, 'feature-1')!;
  const decision = { kind: 'decision_change', id: 'dashboard-suggestion', projectId, schemaVersion: 1, revision: 1,
    createdAt: at, updatedAt: at, questionOrChange: cases['CHECK-02']!.candidate, affectedRecords: [ref(feature)],
    rationale: 'Adjacent planner suggestion; never selected by the original request', disposition: 'proposed',
    sourceRefs: [{ uri: 'fixture:planner-suggestion' }], scopeChanges: [] };
  recordDecisionSuggestion(flow.store, { schemaVersion: 1, id: 'suggestion-command', projectId, issuedAt: at,
    idempotencyKey: 'suggestion', command: 'record_decision_suggestion', targetId: decision.id, expectedRevision: 0, payload: { decision } });
  assert.deepEqual(flow.store.get(projectId, feature.id), feature);
  assert.equal(projectView(flow.store, { projectId }).suggestions[0]?.id, decision.id);
  assert.ok(semanticGate(flow, 'CHECK-02').findings.some(f => f.code === 'invented_scope'));
});

test('CHECK-03 — narrow request retains its meaning and rejects unrelated expansion', t => {
  const flow = setup(t, 'CHECK-03', records => {
    for (const r of records) {
      if (r.kind === 'feature_revision') r.outcome = cases['CHECK-03']!.originalRequest;
      if (r.kind === 'criterion') r.expectedBehavior = 'Correct the ERPNext error message.';
      if (r.kind === 'design_revision') r.productBehavior = 'Correct the ERPNext error message using the existing message path.';
      if (r.kind === 'detailed_plan_task') r.expectedBehavior = 'Correct the ERPNext error message.';
    }
  });
  const result = semanticGate(flow, 'CHECK-03');
  assert.ok(result.findings.some(f => f.code === 'invented_scope'));
  const a = flow.assignment();
  assert.ok(a.selectedContext.some(c => c.extract?.includes(cases['CHECK-03']!.originalRequest)));
});

function rejectProduct(t: test.TestContext, id: string) {
  const fixture = cases[id]!;
  const flow = product(t, id, fixture.deliveredCode, records => {
    if (id === 'CHECK-20') {
      const a = records.find(r => r.kind === 'assignment'); assert.ok(a?.kind === 'assignment');
      a.instructionText = 'Implement feature X only for ERPNext.';
    }
  });
  const review = flow.run(fixture.productVerdict!);
  assert.equal(review.outcome, 'failed');
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), review).ok, false);
  assert.equal(projectView(flow.store, { projectId }).features[0]?.completeness, 'Incomplete — product behavior still needs verification');
  assert.equal(flow.store.get(projectId, review.id)?.kind, 'product_review');
  return { flow, review };
}
test('CHECK-04 — original-request review detects behavior absent from every checklist', t => {
  const { review } = rejectProduct(t, 'CHECK-04');
  assert.ok(review.conformance?.verdict?.criteria.every(c => c.state === 'accomplished'));
});
test('CHECK-05 — technical success cannot complete absent product behavior', t => {
  const { flow, review } = rejectProduct(t, 'CHECK-05');
  assert.ok(flow.input.results.every(r => r.result === 'passed'));
  assert.equal(review.conformance?.verdict?.criteria[1]?.state, 'failed');
});

test('CHECK-13 — planning preserves existing implementation and specifies the real gap', t => {
  const flow = scenario({ bootstrap: true, originalRequest: cases['CHECK-13']!.originalRequest }); t.after(flow.close);
  const prepared = runFeature(flow.config, 'prepare'); assert.ok(prepared);
  const store = new ProjectStore(flow.database); t.after(() => store.close());
  const designs = store.records(projectId).filter(r => r.kind === 'design_revision');
  assert.equal(designs.length, 1); const design = designs[0]!; assert.ok(design.kind === 'design_revision');
  assert.equal(design.workflow?.reuse.alreadyWorks, 'Connection interface');
  assert.equal(design.workflow?.reuse.gap, 'Feature X absent');
  assert.equal(design.workflow?.reuse.change, 'Extend common interface');
  const a = store.records(projectId).find(r => r.kind === 'assignment'); assert.ok(a?.kind === 'assignment');
  assert.ok(a.selectedContext.some(c => c.extract?.includes('Connection interface')));
  assert.ok(semanticGate(setup(t, 'CHECK-13'), 'CHECK-13').findings.some(f => f.code === 'invented_scope'));
});

test('CHECK-15 — preserved baseline without the requested improvement stays incomplete', t => {
  const fixture = cases['CHECK-15']!;
  const flow = product(t, 'CHECK-15', fixture.deliveredCode);
  const review = flow.run(fixture.productVerdict!);
  assert.equal(review.outcome, 'failed'); assert.deepEqual(review.improvementEvidence, []);
  assert.ok(review.conformance?.verdict?.findings[0]?.message.includes('Baseline preserved'));
  assert.equal(validateReviewForCompletion(flow.store.history(projectId), review).ok, false);
});

test('CHECK-16 — focused investigation and independent parallel work retain separate plans', t => {
  for (const strategy of ['focused', 'parallel'] as const) {
    const flow = scenario({ bootstrap: true, originalRequest: cases['CHECK-16']!.originalRequest }); t.after(flow.close);
    for (const stage of [flow.outputs.plan, flow.outputs.detail]) {
      const plan = (stage.records as { kind: string; strategy: string; strategyReason: string }[]).find(r => r.kind === 'implementation_plan_revision'); assert.ok(plan);
      plan.strategy = strategy;
      plan.strategyReason = strategy === 'focused' ? 'Coupled interface investigation needs one continuous context.' : 'Independent acceptance verification can run in parallel.';
    }
    flow.save(join(flow.root, 'outputs.json'), flow.outputs);
    runFeature(flow.config, 'prepare');
    const store = new ProjectStore(flow.database); t.after(() => store.close());
    const plan = store.get(projectId, 'plan-1'); assert.ok(plan?.kind === 'implementation_plan_revision');
    assert.equal(plan.strategy, strategy); assert.equal(plan.readiness.ready, true);
    assert.equal(validateRecords(store.history(projectId)).ok, true);
    const a = store.records(projectId).find(r => r.kind === 'assignment'); assert.ok(a?.kind === 'assignment');
    assert.ok(a.selectedContext.some(c => c.extract?.includes(plan.strategyReason)));
  }
});

test('CHECK-19 — correct plan cannot dispatch a wrongly narrowed brief', t => {
  const flow = setup(t, 'CHECK-19'); const result = semanticGate(flow, 'CHECK-19');
  assert.ok(result.findings.some(f => f.code === 'narrowed_generality'));
  const plan = flow.store.get(projectId, 'plan-1'); assert.ok(plan?.kind === 'implementation_plan_revision');
  assert.ok(plan.readiness.ready);
  assert.equal(flow.tasks.read().calls.some(c => c.args[0] === 'start'), false);
  const dispatch = scenario(); t.after(dispatch.close);
  runFeature(dispatch.config, 'prepare'); dispatch.mode({ narrow: true });
  assert.throws(() => runFeature(dispatch.config, 'start'), /firstmate-spawn_failed/);
  assert.equal(existsSync(join(dispatch.root, 'worker-started')), false);
  const recorded = JSON.parse(readFileSync(join(dispatch.root, 'hook-result.json'), 'utf8'));
  assert.equal(recorded.ok, false);
  assert.ok(recorded.findings.some((finding: { code: string }) => finding.code === 'narrowed_generality'));

});
test('CHECK-20 — faithful implementation of a bad brief still fails independent product review', t => {
  const { review } = rejectProduct(t, 'CHECK-20');
  assert.equal(review.instructionFidelity.result, 'passed', 'Even faithful brief compliance cannot override the original request');
});
