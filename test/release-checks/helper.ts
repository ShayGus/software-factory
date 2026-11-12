import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { TestContext } from 'node:test';
import { ProjectStore, RecordsSchema, prepareWorkerBrief, requiredAssignmentContext, checkWorkerBrief,
  ref, ToolkitApi, createToolkitRequestHandler, parseRoborevResult, reviewProduct,
  type FactoryRecord, type InstructionJudgeVerdict, type ProductVerdict } from '../../src/index.js';
import { fakeJudgeOptions } from '../judge-helper.js';
import { fakeRuntime } from '../runtime-helper.js';
import { fakeTask, fakeTaskWrapper } from '../task-wrapper-helper.js';

export const projectId = 'project-1';
export const at = '2026-11-12T14:00:00.000Z';
export const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../../fixtures/workflow.json', import.meta.url), 'utf8')));
export const cases: Record<string, { originalRequest: string; candidate?: string; instructionVerdict?: InstructionJudgeVerdict; correction?: string; productVerdict?: ProductVerdict; deliveredCode?: string }> =
  JSON.parse(readFileSync(new URL('../../../fixtures/release-checks.json', import.meta.url), 'utf8'));
export const goodCode = 'export function feature(system) { return system.featureX(); }\n';
export const badCode = 'export function feature(system) { if (system.name !== "ERPNext") throw Error("unsupported"); return system.featureX(); }\n';
export function setup(t: TestContext, id: string, edit?: (records: FactoryRecord[]) => void, withResults = true) {
  const request = cases[id]!.originalRequest;
  const directory = mkdtempSync(join(tmpdir(), `sf-${id}-`));
  const database = join(directory, 'project.sqlite');
  const records = structuredClone(baseline.filter((r) => !['observation', 'guidance_revision'].includes(r.kind) &&
    (withResults || !['criterion_result', 'product_review'].includes(r.kind))));
  const source = records.find((r) => r.kind === 'request'); assert.ok(source?.kind === 'request'); source.originalText = request;
  edit?.(records);
  let store = new ProjectStore(database);
  store.importProject({ schemaVersion: 1, projectId, history: records, receipts: [] });
  const tasks = fakeTaskWrapper(directory, false, database);
  tasks.edit(s => { s.tasks['pilot-build'] = fakeTask('pilot-build', { state: 'in_flight' }); });
  const runtime = fakeRuntime(directory, ['pilot-build']);
  const adapter = { fmHome: directory, tasksExecutable: tasks.executable, snapshotExecutable: runtime.executable, guardTaskId: 'permanent-guard' };
  const executable = (name: string, body: string) => {
    const path = join(directory, name); writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o755 }); return path;
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const assignment = () => { const a = store.get(projectId, 'assignment-1'); assert.ok(a?.kind === 'assignment'); return a; };
  const brief = () => {
    const a = assignment(); const history = store.history(projectId);
    const sources = requiredAssignmentContext(history, a).sources.filter(s => !s.record).map((source, i) => {
      const path = join(directory, `source-${i}.txt`); writeFileSync(path, source.uri.includes('01a-inbox') ? request : 'Existing connection interface');
      return { source, path };
    });
    const path = join(directory, 'brief.md'); writeFileSync(path, readFileSync(new URL('../../../fixtures/firstmate-brief.md', import.meta.url)));
    const result = prepareWorkerBrief(store, { projectId, assignmentId: a.id, attemptId: a.attemptId, expectedRevision: a.revision,
      idempotencyKey: 'prepare', issuedAt: at, detailedPlanTask: a.detailedPlanTask, plan: a.plan,
      firstMateTaskId: a.firstMateTaskId, returnLocation: a.returnLocation, briefPath: path, sourceFiles: sources });
    assert.equal(result.ok, true, JSON.stringify(result)); return { path, result };
  };
  async function http() {
    const api = new ToolkitApi(store, adapter, { projectId, fixture: true });
    const server = createServer(createToolkitRequestHandler(api, { port: 0 }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    // Rebind the handler's origin guard to the OS-selected local port.
    server.removeAllListeners('request'); server.on('request', createToolkitRequestHandler(api, { port: address.port }));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      return { status: response.status, text: await response.text() };
    };
  }
  return { directory, database, records, request, get store() { return store; }, tasks, runtime, adapter, runtimeAdapter: { fmHome: directory, snapshotExecutable: runtime.executable }, executable, assignment, brief, http,
    reopen() { store.close(); store = new ProjectStore(database); } };
}
export function semanticGate(flow: ReturnType<typeof setup>, id: string) {
  const fixture = cases[id]!; const brief = flow.brief();
  const current = readFileSync(brief.path, 'utf8');
  writeFileSync(brief.path, current.replace('### Worker return', `${fixture.candidate}\n\n### Worker return`));
  const record = join(flow.directory, 'judge.jsonl');
  const result = checkWorkerBrief(flow.store, projectId, ref(flow.assignment()), brief.path,
    fakeJudgeOptions({ result: JSON.stringify(fixture.instructionVerdict), record }));
  const input = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(input.originalRequests[0].text, fixture.originalRequest);
  assert.notEqual(input.agentPid, process.pid);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.judgment?.ok, 'The source-based agent path must run; a mechanical failure cannot stand in for semantic review');
  return result;
}
export function product(t: TestContext, id: string, code = badCode, edit?: (records: FactoryRecord[]) => void) {
  const flow = setup(t, id, edit, false);
  const git = (...args: string[]) => execFileSync('git', ['-C', flow.directory, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'release-check@example.invalid'); git('config', 'user.name', 'Release fixture');
  writeFileSync(join(flow.directory, 'feature.js'), code); git('add', 'feature.js'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture delivery');
  const artifact = { uri: `git:${flow.directory}`, revision: git('rev-parse', 'HEAD') };
  const results = baseline.filter(r => r.kind === 'criterion_result').map(r => ({ ...r, artifact,
    evidence: [{ artifact, description: 'Worker claims acceptance passed', observedAt: at }] }));
  const input = { projectId, reviewId: 'release-review', expectedRevision: 0, idempotencyKey: 'release-review', issuedAt: at,
    assignment: ref(flow.assignment()), repository: flow.directory, deliveredArtifact: artifact, results,
    baselineEvidence: [{ artifact: { uri: 'fixture:baseline', revision: 'before' }, description: 'Requested behavior absent', observedAt: at }] };
  const run = (answer: ProductVerdict) => {
    const record = join(flow.directory, 'product-agent.jsonl');
    const result = reviewProduct(flow.store, input, fakeJudgeOptions({ result: JSON.stringify(answer), record }), (_repo, sha, observedAt) =>
      parseRoborevResult(JSON.stringify({ job_id: 42, output: 'Technical checks passed', created_at: at,
        structured_output: { verdict: 'pass' }, job: { id: 42, git_ref: sha, status: 'done', job_type: 'review' } }), sha, observedAt));
    const snapshot = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(snapshot.originalRequests[0].text, cases[id]!.originalRequest);
    assert.notEqual(snapshot.agentPid, process.pid);
    assert.equal(result.review.conformance?.technicalReviews[0]?.verdict, 'passed');
    return result.review;
  };
  return { ...flow, run, input };
}
export function taskCommand(id = 'release-task') {
  return { schemaVersion: 1, id: `command-${id}`, projectId, issuedAt: at, idempotencyKey: `key-${id}`,
    command: 'map_manage_execution_task', targetId: `mapping-${id}`, expectedRevision: 0,
    payload: { action: 'create', task: { kind: 'new', firstMateTaskId: id, title: 'Deliver requested common behavior', repo: 'sample' },
      feature: { id: 'feature-1', revision: 1 }, criteria: [{ id: 'criterion-general', revision: 1 }, { id: 'criterion-second-system', revision: 1 }],
      detailedPlanTask: { id: 'task-1', revision: 1 }, dependencies: [] as string[], reason: 'Original requested behavior' } };
}
export function correction(flow: ReturnType<typeof setup>, id: string, action = 'clarification') {
  return { schemaVersion: 1, id: `correction-command-${id}`, projectId, issuedAt: new Date().toISOString(),
    idempotencyKey: `correction-${id}`, command: 'deliver_correction', targetId: `correction-${id}`, expectedRevision: 0,
    payload: { affectedRevision: { id: 'feature-1', revision: 1 }, assignment: ref(flow.assignment()),
      originalCorrection: cases[id]!.correction!, action, sequence: 1, supersedes: [], sourceRefs: [{ uri: `fixture:${id}/original-correction` }] } };
}
