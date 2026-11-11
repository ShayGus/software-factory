import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ProjectStore, RecordsSchema, prepareWorkerBrief, checkWorkerBrief, requiredAssignmentContext,
  scaffoldParts, validateAssignmentForDispatch, validateRecords, ref,
  selectAssignmentContext, digestText, type Artifact, type Assignment, type FactoryRecord, type PrepareWorkerBriefInput,
} from '../src/index.js';

const baseline = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/workflow.json', import.meta.url), 'utf8')));
const scaffold = readFileSync(new URL('../../fixtures/firstmate-brief.md', import.meta.url), 'utf8');
const scenario = JSON.parse(readFileSync(new URL('../../fixtures/scenarios/erpnext-narrowed-assignment.json', import.meta.url), 'utf8'));
const projectId = 'project-1';
function setup(options: { omitSource?: boolean; crlf?: boolean; dependencies?: boolean;
  editRecords?: (records: FactoryRecord[]) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-brief-'));
  const database = join(directory, 'records.sqlite');
  const store = new ProjectStore(database);
  const records = structuredClone(baseline.filter((record) => ['project', 'request', 'feature_revision', 'criterion',
    'design_revision', 'implementation_plan_revision', 'detailed_plan_task', 'task_mapping'].includes(record.kind)));
  if (options.dependencies) {
    const task = records.find((record) => record.kind === 'detailed_plan_task'); assert.ok(task?.kind === 'detailed_plan_task');
    const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
    const prerequisite = { ...structuredClone(task), id: 'prerequisite-task' }; records.push(prerequisite);
    plan.deliverySequence.unshift(ref(prerequisite));
    plan.dependencies = [{ prerequisiteTaskId: prerequisite.id, consumerTaskId: task.id, reason: 'Consume the common interface output',
      needs: { kind: 'artifact', artifact: { uri: join(directory, 'interface-output.txt'), revision: 'output-revision-1' } } },
    { prerequisiteTaskId: prerequisite.id, consumerTaskId: task.id, reason: 'Use the verified common behavior',
      needs: { kind: 'criterion', criterion: task.criteria[0]! } }];
  }
  options.editRecords?.(records);
  store.importProject({ schemaVersion: 1, projectId, history: records, receipts: [] });
  const template = baseline.find((record): record is Assignment => record.kind === 'assignment')!;
  const request = records.find((record) => record.kind === 'request'); assert.ok(request?.kind === 'request');
  const sources = requiredAssignmentContext(records, template).sources.filter((source) => !source.record)
    .sort((a, b) => Number(b.uri === request.source.uri) - Number(a.uri === request.source.uri));
  const sourceFiles = sources.map((source, index) => {
    const path = join(directory, `source-${index}.txt`);
    writeFileSync(path, source.uri === request.source.uri ? request.originalText : 'Existing common connected-system interface.');
    return { source, path };
  });
  const briefPath = join(directory, 'brief.md');
  const original = options.crlf ? scaffold.replaceAll('\n', '\r\n') : scaffold;
  writeFileSync(briefPath, original);
  const input: PrepareWorkerBriefInput = { projectId, assignmentId: 'generated-assignment', attemptId: 'attempt-build',
    expectedRevision: 0, idempotencyKey: 'prepare-1', issuedAt: '2026-11-11T12:00:00Z',
    detailedPlanTask: template.detailedPlanTask, plan: template.plan, firstMateTaskId: template.firstMateTaskId,
    returnLocation: 'data/pilot-build/report.md', briefPath,
    sourceFiles: options.omitSource ? sourceFiles.slice(1) : sourceFiles,
  };
  const prepare = () => prepareWorkerBrief(store, input);
  const assignment = () => {
    const record = store.get(projectId, input.assignmentId);
    assert.ok(record?.kind === 'assignment'); return record;
  };
  const check = () => checkWorkerBrief(store, projectId, ref(assignment()), briefPath);
  return { store, records, input, directory, database, briefPath, original, sourceFiles, prepare, assignment, check,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const crlf of [false, true]) test(`generated brief preserves intent and lifecycle bytes (${crlf ? 'CRLF' : 'LF'} scaffold)`, () => {
  const flow = setup({ crlf });
  try {
    const report = flow.prepare(); assert.equal(report.ok, true, JSON.stringify(report));
    const assignment = flow.assignment();
    const text = readFileSync(flow.briefPath, 'utf8');
    const parts = scaffoldParts(flow.original);
    assert.ok(text.startsWith(parts.prefix)); assert.ok(text.endsWith(parts.suffix));
    const middle = text.indexOf(parts.middle, parts.prefix.length);
    const request = flow.records.find((record) => record.kind === 'request'); assert.ok(request?.kind === 'request');
    assert.equal(text.slice(parts.prefix.length, middle), request.originalText + parts.newline.repeat(2));
    assert.match(text, /criterion-second-system@1/);
    assert.match(text, /Return one result per assigned criterion/);
    const sidecar = JSON.parse(readFileSync(report.sidecarPath, 'utf8'));
    for (const ref of [assignment.design, assignment.plan, assignment.detailedPlanTask]) {
      assert.ok(sidecar.revisions.some((revision: unknown) => JSON.stringify(revision) === JSON.stringify(ref)));
      assert.ok(assignment.selectedContext.some((context) => context.source.record?.id === ref.id &&
        context.source.record.revision === ref.revision));
    }
    assert.deepEqual(sidecar.selectedContext, assignment.selectedContext);
    assert.equal(assignment.instructionFidelity.result, 'passed');
    assert.equal(validateAssignmentForDispatch(flow.store.history(projectId), ref(assignment)).ok, true);
    assert.equal(flow.check().ok, true);
  } finally { flow.close(); }
});

const mutations = [
  { name: 'changed original ask', code: 'changed_captains_intent', edit: (text: string) => text.replace('Build feature X', 'Implement feature X') },
  { name: 'changed delivery mode', code: 'damaged_scaffold', edit: (text: string) => text.replace('mode=local-only', 'mode=remote') },
  { name: 'missing isolation instruction', code: 'damaged_scaffold', edit: (text: string) => text.replace('Verify isolation before editing.', '') },
  { name: 'omitted task behavior with criterion IDs retained', code: 'omitted_behavior', edit: (text: string) =>
    text.replace('Feature X across connected systems, including a second-system acceptance case.', '') },
  { name: 'invented scope', code: 'invented_scope', edit: (text: string) => text.replace('### Worker return', 'Also implement billing and payments.\n\n### Worker return') },
  { name: 'BUILD-02 ERPNext-only assignment with criterion IDs retained', code: 'narrowed_generality', edit: (text: string) =>
    text.replace('Feature X across connected systems, including a second-system acceptance case.', scenario.edits[0].value) },
];
for (const mutation of mutations) test(`fidelity rejects ${mutation.name}`, () => {
  const flow = setup();
  try {
    assert.equal(flow.prepare().ok, true);
    const edited = mutation.edit(readFileSync(flow.briefPath, 'utf8'));
    assert.match(edited, /criterion-general@1/); assert.match(edited, /criterion-second-system@1/);
    writeFileSync(flow.briefPath, edited);
    const report = flow.check(); assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) => finding.code === mutation.code), JSON.stringify(report));
  } finally { flow.close(); }
});

test('missing original source is explicit and blocks managed dispatch; a new revision can supply it', () => {
  const flow = setup({ omitSource: true });
  try {
    const report = flow.prepare(); assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) => finding.code === 'missing_required_context' && finding.message.includes(flow.sourceFiles[0]!.source.uri)));
    assert.equal(flow.assignment().instructionFidelity.result, 'failed');
    assert.equal(validateAssignmentForDispatch(flow.store.history(projectId), ref(flow.assignment())).ok, false);
    assert.match(readFileSync(flow.briefPath, 'utf8'), /### Missing required context/);
    const corrected = prepareWorkerBrief(flow.store, { ...flow.input, expectedRevision: 1, idempotencyKey: 'supply-source', sourceFiles: flow.sourceFiles });
    assert.equal(corrected.ok, true, JSON.stringify(corrected));
    assert.equal(flow.assignment().revision, 2);
  } finally { flow.close(); }
});

test('large sources receive a verbatim task-specific extract plus a reachable, digested original', () => {
  const flow = setup();
  try {
    const selected = flow.sourceFiles[0]!;
    const original = 'Unrelated background.\n'.repeat(100) + 'Relevant behavior and interfaces for the common feature.\n'.repeat(100);
    writeFileSync(selected.path, original);
    const start = original.indexOf('Relevant');
    flow.input.sourceFiles![0] = { ...selected, start, end: original.length };
    flow.input.maxSourceChars = 80;
    assert.equal(flow.prepare().ok, true);
    const context = flow.assignment().selectedContext.find((context) => context.source.uri === selected.source.uri)!;
    assert.equal(context.extract, original.slice(start, start + 80)); assert.equal(context.truncated, true);
    assert.equal(context.artifact?.uri, selected.path); assert.equal(readFileSync(context.artifact!.uri, 'utf8'), original);
    assert.equal(flow.check().ok, true);
  } finally { flow.close(); }
});

test('a claimed pass cannot dispatch with required record context removed', () => {
  const flow = setup();
  try {
    flow.prepare();
    const records = flow.store.history(projectId);
    const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
    assignment.selectedContext = assignment.selectedContext.filter((context) => context.source.record?.id !== assignment.design.id);
    const report = validateAssignmentForDispatch(records, ref(assignment)); assert.equal(report.ok, false);
    if (!report.ok) assert.ok(report.issues.some((issue) => issue.code === 'missing_required_context'));
    const legacy = structuredClone(baseline);
    const old = legacy.find((record): record is Assignment => record.kind === 'assignment')!;
    old.selectedContext = old.selectedContext.filter((context) => context.source.record?.id !== old.plan.id);
    assert.equal(validateAssignmentForDispatch(legacy, ref(old)).ok, false);
  } finally { flow.close(); }
});

for (const damage of ['sidecar', 'source', 'missing-sidecar', 'missing-source'] as const) test(`check fails with ${damage} damage after preparation`, () => {
  const flow = setup();
  try {
    const report = flow.prepare(); assert.equal(report.ok, true);
    const path = damage.includes('sidecar') ? report.sidecarPath : flow.sourceFiles[0]!.path;
    if (damage.startsWith('missing')) rmSync(path); else writeFileSync(path, '{}');
    const checked = flow.check(); assert.equal(checked.ok, false);
    assert.ok(checked.findings.some((finding) => ['sidecar_mismatch', 'missing_required_context'].includes(finding.code)));
  } finally { flow.close(); }
});

test('idempotent replay restores interrupted file writes and rejects a changed payload', () => {
  const flow = setup();
  try {
    const first = flow.prepare(); assert.equal(first.ok, true);
    const expected = readFileSync(flow.briefPath, 'utf8');
    rmSync(flow.briefPath); rmSync(first.sidecarPath);
    assert.deepEqual(flow.prepare(), first);
    assert.equal(readFileSync(flow.briefPath, 'utf8'), expected);
    assert.equal(flow.assignment().revision, 1);
    assert.throws(() => prepareWorkerBrief(flow.store, { ...flow.input, returnLocation: 'different-result.md' }), /idempotency_conflict/);
    const reopened = new ProjectStore(flow.database);
    try { assert.equal(checkWorkerBrief(reopened, projectId, first.assignment, flow.briefPath).ok, true); }
    finally { reopened.close(); }
  } finally { flow.close(); }
});

test('unmanaged task mappings remain valid without invented acceptance or a brief', () => {
  const mapping = baseline.find((record) => record.kind === 'task_mapping')!;
  const project = baseline.find((record) => record.kind === 'project')!;
  assert.equal(validateRecords([project, { ...mapping, legacy: true, feature: null, criteria: [], detailedPlanTask: null }]).ok, true);
});

test('CLI preparation and pre-dispatch gate return JSON and fail closed on changed instructions', () => {
  const flow = setup();
  try {
    const inputPath = join(flow.directory, 'input.json'); writeFileSync(inputPath, JSON.stringify(flow.input));
    const cli = new URL('../src/cli.js', import.meta.url);
    const run = (args: string[]) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
    const prepared = run(['prepare-brief', '--db', flow.database, '--input', inputPath]);
    assert.equal(prepared.status, 0, prepared.stderr); const result = JSON.parse(prepared.stdout);
    const args = ['check-brief', '--db', flow.database, '--project', projectId, '--assignment', result.assignment.id,
      '--revision', String(result.assignment.revision), '--brief', flow.briefPath];
    assert.equal(run(args).status, 0);
    writeFileSync(flow.briefPath, readFileSync(flow.briefPath, 'utf8').replace('Second-system case', 'ERPNext only'));
    const checked = run(args); assert.equal(checked.status, 1);
    assert.ok(JSON.parse(checked.stdout).findings.some((finding: { code: string }) => finding.code === 'narrowed_generality'));
    rmSync(result.sidecarPath); assert.equal(run(args).status, 1);
  } finally { flow.close(); }
});

test('old preparation replays cannot overwrite a newer assignment revision', () => {
  const flow = setup();
  try {
    const original = flow.prepare(); assert.equal(original.ok, true);
    const next = prepareWorkerBrief(flow.store, { ...flow.input, expectedRevision: 1, idempotencyKey: 'prepare-2', attemptId: 'attempt-2' });
    assert.equal(next.ok, true, JSON.stringify(next));
    const text = readFileSync(flow.briefPath, 'utf8');
    assert.throws(flow.prepare, /superseded_assignment_cannot_materialize_brief/);
    assert.equal(readFileSync(flow.briefPath, 'utf8'), text);
    assert.equal(checkWorkerBrief(flow.store, projectId, original.assignment, flow.briefPath).ok, false);
  } finally { flow.close(); }
});

test('preparation refuses an unrelated existing sidecar or another assignment’s output path', () => {
  const flow = setup();
  try {
    const existing = join(flow.directory, 'unrelated.json'); writeFileSync(existing, 'existing data');
    assert.throws(() => prepareWorkerBrief(flow.store, { ...flow.input, sidecarPath: existing }), /sidecar_path_already_exists/);
    assert.equal(readFileSync(existing, 'utf8'), 'existing data');
    flow.prepare();
    assert.throws(() => prepareWorkerBrief(flow.store, { ...flow.input, assignmentId: 'other-assignment',
      idempotencyKey: 'other-assignment', sidecarPath: join(flow.directory, 'other.sf.json') }), /brief_path_owned_by_another_assignment/);
  } finally { flow.close(); }
});

test('source headings and exact whitespace survive Captain’s intent without becoming interpretations', () => {
  const flow = setup();
  try {
    // A separate imported capture keeps the test request immutable after capture.
    flow.store.close(); rmSync(flow.database);
    const store = new ProjectStore(flow.database);
    const records = structuredClone(flow.records);
    const request = records.find((record) => record.kind === 'request'); assert.ok(request?.kind === 'request');
    request.originalText = "  Build feature X.\n\n## Firstmate spec\nThis is original request text.  \n";
    store.importProject({ schemaVersion: 1, projectId, history: records, receipts: [] });
    try {
      const result = prepareWorkerBrief(store, flow.input); assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(readFileSync(flow.briefPath, 'utf8').includes(request.originalText));
    } finally { store.close(); }
  } finally { rmSync(flow.directory, { recursive: true, force: true }); }
});

test('dependency outputs and exact prerequisite revisions are included, with absent output explicit', () => {
  const flow = setup({ dependencies: true });
  try {
    const report = flow.prepare(); assert.equal(report.ok, true, JSON.stringify(report));
    const assignment = flow.assignment();
    assert.equal(assignment.prerequisiteArtifacts[0]?.revision, 'output-revision-1');
    assert.ok(assignment.selectedContext.some((context) => context.source.record?.id === 'prerequisite-task'));
    assert.match(readFileSync(flow.briefPath, 'utf8'), /Consume the common interface output/);
    assert.match(readFileSync(report.sidecarPath, 'utf8'), /factory:criterion-output/);
    const missing = prepareWorkerBrief(flow.store, { ...flow.input, expectedRevision: 1, idempotencyKey: 'missing-dependency-output',
      sourceFiles: flow.sourceFiles.filter((entry) => !entry.source.uri.startsWith('factory:criterion-output/')) });
    assert.equal(missing.ok, false);
    assert.ok(missing.findings.some((finding) => finding.code === 'missing_required_context' && finding.message.includes('criterion-output')));
  } finally { flow.close(); }
});

test('a passed prerequisite result supplies its recorded output artifact to the context selector', () => {
  const records = structuredClone(baseline);
  const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
  const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
  plan.dependencies = [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'dependent-task', reason: 'Use verified common behavior',
    needs: { kind: 'criterion', criterion: assignment.criteria[0]! } }];
  const selected = selectAssignmentContext(records, { ...assignment, detailedPlanTask: { id: 'dependent-task', revision: 1 } },
    (source) => ({ text: 'Recorded implementation and output snapshot.', uri: source.uri }));
  assert.ok(selected.records.some((record) => record.id === 'result-general'));
  assert.ok(selected.prerequisites.some((artifact) => artifact.uri === 'fixture://implementation/feature-x'));
  assert.ok(!selected.sources.some((source) => source.uri.startsWith('factory:criterion-output/')));
});

test('BUILD-02 narrowing is rejected even if its stored fidelity flag still claims a pass', () => {
  const records = structuredClone(baseline);
  const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
  assignment.instructionText = scenario.edits[0].value;
  const report = validateAssignmentForDispatch(records, ref(assignment)); assert.equal(report.ok, false);
  if (!report.ok) assert.ok(report.issues.some((issue) => issue.code === 'narrowed_generality'));
});

test('source truncation preserves Unicode code points', () => {
  const flow = setup();
  try {
    writeFileSync(flow.sourceFiles[0]!.path, 'A😀B');
    flow.input.maxSourceChars = 2;
    const result = flow.prepare(); assert.equal(result.ok, true, JSON.stringify(result));
    const context = flow.assignment().selectedContext.find((context) => context.source.uri === flow.sourceFiles[0]!.source.uri)!;
    assert.equal(context.extract, 'A'); assert.equal(context.truncated, true);
  } finally { flow.close(); }
});

test('recorded handover context stays pinned when later dependency results arrive', () => {
  const records = structuredClone(baseline);
  const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
  const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
  plan.dependencies = [{ prerequisiteTaskId: 'task-1', consumerTaskId: 'dependent-task', reason: 'Use verified common behavior',
    needs: { kind: 'criterion', criterion: assignment.criteria[0]! } }];
  const consumer = { ...assignment, detailedPlanTask: { id: 'dependent-task', revision: 1 } };
  const selected = selectAssignmentContext(records, consumer, (source) => ({ text: 'Recorded output snapshot.', uri: source.uri }));
  const previous = records.find((record) => record.id === 'result-general'); assert.ok(previous?.kind === 'criterion_result' && previous.artifact);
  records.push({ ...previous, revision: 2, artifact: { ...previous.artifact, revision: 'new-output' } });
  const pinned = requiredAssignmentContext(records, consumer, selected.selectedContext);
  assert.ok(pinned.records.some((record) => record.id === previous.id && record.revision === 1));
  assert.ok(!pinned.records.some((record) => record.id === previous.id && record.revision === 2));
  assert.ok(pinned.prerequisites.some((artifact) => artifact.revision === 'fixture-commit-1'));
});

test('review 1094-1: exact generation cannot approve a task narrowed from the original general design', () => {
  const flow = setup({ editRecords: (records) => {
    const task = records.find((record) => record.kind === 'detailed_plan_task'); assert.ok(task?.kind === 'detailed_plan_task');
    task.expectedBehavior = scenario.edits[0].value;
  } });
  try {
    const report = flow.prepare(); assert.equal(report.ok, false, JSON.stringify(report));
    assert.ok(report.findings.some((finding) => finding.code === 'narrowed_generality'));
    assert.equal(flow.check().ok, false);
    assert.equal(flow.assignment().instructionFidelity.result, 'failed');
    // A manually asserted pass must not bypass the operative-text check either.
    const records = flow.store.history(projectId);
    const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
    assignment.instructionFidelity = { ...assignment.instructionFidelity, result: 'passed', findings: [] };
    const dispatch = validateAssignmentForDispatch(records, ref(assignment)); assert.equal(dispatch.ok, false);
    if (!dispatch.ok) assert.ok(dispatch.issues.some((finding) => finding.code === 'narrowed_generality'));
  } finally { flow.close(); }
});

for (const identity of ['digest', 'revision'] as const) test(`review 1094-2: one snapshot cannot cover two ${identity} identities of the same URI`, () => {
  const uri = 'fixture://versioned-output';
  const first: Artifact = { uri, ...(identity === 'digest' ? { digest: digestText('first output') } : { revision: 'first-revision' }) };
  const second: Artifact = { uri, ...(identity === 'digest' ? { digest: digestText('second output') } : { revision: 'second-revision' }) };
  const flow = setup({ dependencies: true, editRecords: (records) => {
    const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
    const dependency = plan.dependencies[0]!;
    plan.dependencies = [{ ...dependency, needs: { kind: 'artifact', artifact: first } },
      { ...dependency, needs: { kind: 'artifact', artifact: second } }];
  } });
  try {
    const file = flow.sourceFiles.find((entry) => entry.source.uri === uri)!; writeFileSync(file.path, 'first output');
    const report = flow.prepare(); assert.equal(report.ok, false, JSON.stringify(report));
    assert.ok(report.findings.some((finding) => finding.code === 'missing_required_context' && finding.message.includes(uri) &&
      finding.message.includes(identity === 'digest' ? second.digest! : second.revision!)), JSON.stringify(report));
    assert.equal(flow.check().ok, false);
  } finally { flow.close(); }
});

for (const via of ['designRefs', 'reuseTargets', 'sourceRefs'] as const) test(`review 1094-3: ${via}-only record originals are bundled at the selected revision`, () => {
  const flow = setup({ editRecords: (records) => {
    const design = records.find((record) => record.kind === 'design_revision'); assert.ok(design?.kind === 'design_revision');
    const original = { ...structuredClone(design), id: 'source-only-design', technicalDesign: 'Large original design. '.repeat(2000) };
    records.push(original, { ...original, revision: 2, technicalDesign: 'Later unrelated design revision' });
    const source = { uri: 'factory:reference/source-only-design', record: ref(original) };
    if (via === 'sourceRefs') design.sourceRefs.push(source);
    else {
      const task = records.find((record) => record.kind === 'detailed_plan_task'); assert.ok(task?.kind === 'detailed_plan_task');
      task[via]!.push(source);
    }
  } });
  try {
    flow.input.maxSourceChars = 80;
    const report = flow.prepare(); assert.equal(report.ok, true, JSON.stringify(report));
    const context = flow.assignment().selectedContext.find((context) => context.source.record?.id === 'source-only-design')!;
    assert.equal(context.truncated, true);
    const coverage = JSON.parse(readFileSync(report.sidecarPath, 'utf8'));
    assert.ok(coverage.revisions.some((record: { id: string; revision: number }) => record.id === 'source-only-design' && record.revision === 1));
    assert.ok(!coverage.revisions.some((record: { id: string; revision: number }) => record.id === 'source-only-design' && record.revision === 2));
    assert.equal(coverage.records.find((record: { id: string }) => record.id === 'source-only-design').technicalDesign,
      'Large original design. '.repeat(2000));
    assert.equal(flow.check().ok, true);
  } finally { flow.close(); }
});

for (const faithful of [
  'Feature X works for every connected system, with ERPNext only an example.',
  'Feature X is not limited to ERPNext.',
  'Implement the general feature; do not implement only ERPNext.',
]) test(`review 1094-4: faithful instructions dispatch: ${faithful}`, () => {
  const records = structuredClone(baseline);
  const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
  assignment.instructionText = faithful;
  const report = validateAssignmentForDispatch(records, ref(assignment));
  assert.equal(report.ok, true, JSON.stringify(report));
});

for (const identity of ['digest', 'revision'] as const) test(`review 1094-2: distinct snapshots satisfy both ${identity} versions without collapsing coverage`, () => {
  const uri = 'fixture://versioned-output';
  const versions: Artifact[] = ['first', 'second'].map((version) => ({ uri,
    ...(identity === 'digest' ? { digest: digestText(`${version} output`) } : { revision: `${version}-revision` }) }));
  const flow = setup({ dependencies: true, editRecords: (records) => {
    const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
    plan.dependencies = versions.map((artifact) => ({ ...plan.dependencies[0]!, needs: { kind: 'artifact', artifact } }));
  } });
  try {
    const snapshots = versions.map((artifact, index) => {
      const path = join(flow.directory, `version-${index}.txt`); writeFileSync(path, `${index === 0 ? 'first' : 'second'} output`);
      return { source: { uri }, artifact, path };
    });
    const report = prepareWorkerBrief(flow.store, { ...flow.input,
      sourceFiles: [...flow.sourceFiles.filter((entry) => entry.source.uri !== uri), ...snapshots] });
    assert.equal(report.ok, true, JSON.stringify(report));
    const contexts = flow.assignment().selectedContext.filter((context) => context.source.uri === uri);
    assert.equal(contexts.length, 2);
    for (const version of versions) assert.ok(contexts.some((context) => context.artifact?.revision === version.revision &&
      (!version.digest || context.artifact?.digest === version.digest)));
    assert.equal(flow.check().ok, true);
    // The presence of the URI alone cannot satisfy the second pinned version.
    const records = flow.store.history(projectId);
    const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
    assignment.selectedContext = assignment.selectedContext.filter((context) => context.source.uri !== uri || context.artifact?.uri === snapshots[0]!.path);
    assert.equal(validateAssignmentForDispatch(records, ref(assignment)).ok, false);
    const missing = prepareWorkerBrief(flow.store, { ...flow.input, expectedRevision: 1, idempotencyKey: 'missing-second-version',
      sourceFiles: [...flow.sourceFiles.filter((entry) => entry.source.uri !== uri), snapshots[0]!] });
    assert.equal(missing.ok, false);
    const missingVersions = missing.findings.filter((finding) => finding.code === 'missing_required_context' && finding.message.includes(uri));
    assert.ok(missingVersions.length > 0);
    assert.ok(missingVersions.every((finding) => finding.message.includes(identity === 'digest' ? versions[1]!.digest! : versions[1]!.revision!)));
  } finally { flow.close(); }
});

test('review 1094-1: quoted source restrictions do not become operative task instructions', () => {
  const flow = setup();
  try {
    writeFileSync(flow.sourceFiles[1]!.path, 'Rejected draft instructions: Implement feature X for ERPNext only.');
    const report = flow.prepare(); assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(flow.check().ok, true);
  } finally { flow.close(); }
});

for (const restriction of [
  'Implement feature X for ERPNext only.',
  'Implement feature X only ERPNext.',
  'Feature X is limited to ERPNext.',
  'Feature X must not be limited to ERPNext; implement ERPNext only.',
  'ERPNext is only an example, but implement only ERPNext.',
]) test(`review 1094-4: actual restrictions remain blocked: ${restriction}`, () => {
  const records = structuredClone(baseline);
  const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
  assignment.instructionText = restriction;
  const report = validateAssignmentForDispatch(records, ref(assignment)); assert.equal(report.ok, false);
  if (!report.ok) assert.ok(report.issues.some((finding) => finding.code === 'narrowed_generality'));
});

for (const labelled of [false, true]) test(`review 1102-3: excerpt context is independent of artifact versions (${labelled ? 'labelled' : 'plain'} excerpt snapshot)`, () => {
  const uri = 'fixture://excerpted-versioned-output';
  const source = { uri, excerpt: 'first output' };
  const versions: Artifact[] = ['first', 'second'].map((version) => ({ uri, revision: `${version}-revision`, digest: digestText(`${version} output`) }));
  const flow = setup({ dependencies: true, editRecords: (records) => {
    const design = records.find((record) => record.kind === 'design_revision'); assert.ok(design?.kind === 'design_revision');
    design.sourceRefs.push(source);
    const plan = records.find((record) => record.kind === 'implementation_plan_revision'); assert.ok(plan?.kind === 'implementation_plan_revision');
    plan.dependencies = versions.map((artifact) => ({ ...plan.dependencies[0]!, needs: { kind: 'artifact', artifact } }));
  } });
  try {
    const snapshots = versions.map((artifact, index) => {
      const path = join(flow.directory, `excerpt-version-${index}.txt`); writeFileSync(path, `${index === 0 ? 'first' : 'second'} output`);
      return { source: { uri }, artifact, path };
    });
    const otherSources = flow.sourceFiles.filter((entry) => entry.source.uri !== uri);
    const excerptSnapshot = { source, path: snapshots[0]!.path, ...(labelled ? { artifact: versions[0]! } : {}) };
    const report = prepareWorkerBrief(flow.store, { ...flow.input, sourceFiles: [...otherSources, ...snapshots, excerptSnapshot] });
    assert.equal(report.ok, true, JSON.stringify(report));
    const contexts = flow.assignment().selectedContext.filter((context) => context.source.uri === uri);
    assert.equal(contexts.length, 3);
    assert.equal(contexts.filter((context) => context.source.excerpt).length, 1);
    assert.equal(contexts.find((context) => context.source.excerpt)?.extract, 'first output');
    for (const version of versions) assert.ok(contexts.some((context) => !context.source.excerpt &&
      context.artifact?.revision === version.revision && context.artifact?.digest === version.digest));
    assert.equal(flow.check().ok, true);
    // Both the quote and each complete version remain independently required.
    for (const remove of ['excerpt', 'second-version'] as const) {
      const records = flow.store.history(projectId);
      const assignment = records.find((record): record is Assignment => record.kind === 'assignment')!;
      assignment.selectedContext = assignment.selectedContext.filter((context) => context.source.uri !== uri ||
        (remove === 'excerpt' ? !context.source.excerpt : context.artifact?.revision !== versions[1]!.revision));
      const dispatch = validateAssignmentForDispatch(records, ref(assignment)); assert.equal(dispatch.ok, false);
      if (!dispatch.ok) assert.ok(dispatch.issues.some((finding) => finding.code === 'missing_required_context' &&
        finding.message.includes(remove === 'excerpt' ? source.excerpt : versions[1]!.revision!)));
    }
    const wrongExcerpt = prepareWorkerBrief(flow.store, { ...flow.input, expectedRevision: 1, idempotencyKey: 'wrong-excerpt-snapshot',
      sourceFiles: [...otherSources, ...snapshots, { source, path: snapshots[1]!.path, ...(labelled ? { artifact: versions[1]! } : {}) }] });
    assert.equal(wrongExcerpt.ok, false);
    assert.ok(wrongExcerpt.findings.some((finding) => finding.code === 'missing_required_context' && finding.message.includes(source.excerpt)));
  } finally { flow.close(); }
});
