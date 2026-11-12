import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digestText, importLegacyTasks, projectView, workView, verifyRestoredArtifact, resolveRestoredReference } from '../src/index.js';
import { setup, projectId } from './release-checks/helper.js';

const currentPr = 'https://example.invalid/software-factory/pull/24';
const oldPr = 'https://example.invalid/software-factory/pull/18';
const readyDetail = `checks green: PR ready for review · run: current-run · pr=${currentPr}`;
function observe(flow: ReturnType<typeof setup>, detail = readyDetail, metadataUrl: string | null = currentPr,
  event = { state: 'working', raw: 'working: implementation started', age_seconds: 120 }) {
  const row = flow.runtime.read()[0]!;
  writeFileSync(flow.runtime.statePath, JSON.stringify([{ ...row,
    current_state: { ...row.current_state, state: 'done', source: 'run-step', detail },
    pr: { url: metadataUrl, source: 'meta', head: null },
    paths: { status_log: { last_event: event } },
  }]));
  const fleet = flow.executable('fleet-with-omission.cjs', `const cp=require('node:child_process');
const snapshot=JSON.parse(cp.execFileSync(${JSON.stringify(flow.runtime.executable)},['--json'],{encoding:'utf8'}));
snapshot.backlog.records.push({id:null,structured:false,raw:'Imported work omitted from structured inventory'});
process.stdout.write(JSON.stringify(snapshot));`);
  importLegacyTasks(flow.store, projectId, { ...flow.runtimeAdapter, snapshotExecutable: fleet });
}

const model = (flow: ReturnType<typeof setup>) => workView(projectView(flow.store, { projectId }));

test('review 1424-3: unrelated status events cannot supply a PR readiness age', async t => {
  for (const event of [
    { state: 'working', raw: 'working: implementation started', age_seconds: 900 },
    { state: 'working', raw: 'working: later administrative update', age_seconds: 30 },
    { state: 'done', raw: `done: PR ready for review ${oldPr}`, age_seconds: 120 },
  ]) await t.test(event.raw, async t => {
    const flow = setup(t, 'CHECK-18', undefined, false); observe(flow, readyDetail, currentPr, event);
    assert.equal(model(flow).ready[0]?.reference, currentPr);
    assert.equal(model(flow).ready[0]?.age, 'Unknown', 'Only evidence of this PR becoming ready may establish readiness age');
    assert.equal(model(flow).ready[0]?.readySince, null);
    const http = await flow.http();
    assert.match((await http('GET', '/projects/project-1/work')).text, /Age since ready: Unknown/);
  });
});

test('review 1424-4: recovery observations preserve the latest imported Work evidence', async t => {
  for (const operation of ['artifact', 'reference'] as const) await t.test(operation, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'sf-work-recovery-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'supplied.txt'); const reference = 'source.txt';
    writeFileSync(path, 'Recovered artifact'); writeFileSync(join(directory, reference), 'Recovered source');
    const flow = setup(t, 'CHECK-18', records => {
      const project = records.find(record => record.kind === 'project'); assert.ok(project?.kind === 'project');
      project.integration = { state: 'reconciling', outstandingConditions: [],
        restoredArtifacts: [{ path, digest: null }], restoredUnresolvedReferences: [reference] };
    }, false);
    observe(flow, readyDetail.replace(currentPr, oldPr), oldPr);
    observe(flow); const imported = model(flow).snapshot;
    const runtimeReads = readFileSync(join(flow.directory, 'runtime-reads'), 'utf8');
    if (operation === 'artifact') {
      const digest = digestText('Recovered artifact');
      verifyRestoredArtifact(flow.store, { projectId, path, digest,
        evidence: [{ artifact: { uri: path, digest }, description: 'Verified recovered artifact', observedAt: new Date().toISOString() }] });
    } else {
      const digest = digestText('Recovered source');
      resolveRestoredReference(flow.store, { projectId, reference, base: directory, digest,
        evidence: [{ artifact: { uri: join(directory, reference), digest }, description: 'Verified recovered source', observedAt: new Date().toISOString() }] });
    }
    flow.reopen();
    assert.deepEqual(model(flow).snapshot, imported, 'Recovery payloads do not hide or refresh imported fleet evidence');
    const stale = workView(projectView(flow.store, { projectId }, Date.parse(imported!.observedAt) + 120_000));
    assert.equal(stale.stale, true, 'Recovery writes do not reset the fleet capture timestamp');
    const http = await flow.http(); const response = await http('GET', '/projects/project-1/work');
    assert.ok(response.text.includes(currentPr)); assert.ok(response.text.includes('Imported work omitted from structured inventory'));
    assert.equal(readFileSync(join(flow.directory, 'runtime-reads'), 'utf8'), runtimeReads);
  });
});

test('review 1424-5: readiness uses current-run PR evidence and discloses conflicting identities', async t => {
  await t.test('current-run detail supplies the PR when metadata has no URL', async t => {
    const flow = setup(t, 'CHECK-18', undefined, false); observe(flow, readyDetail, null);
    assert.equal(model(flow).ready[0]?.reference, currentPr);
    const http = await flow.http(); assert.ok((await http('GET', '/projects/project-1/work')).text.includes(currentPr));
  });
  await t.test('metadata without attributed current-run PR evidence stays unknown', t => {
    const flow = setup(t, 'CHECK-18', undefined, false); observe(flow, 'checks green: PR ready for review', oldPr);
    assert.equal(model(flow).ready.length, 0, 'An unassociated metadata URL must not be advertised as the current ready PR');
    assert.ok(model(flow).snapshot?.omissions.some(text => /PR identity.*unknown/i.test(text)));
  });
  await t.test('different current-run and metadata URLs are a visible conflict', async t => {
    const flow = setup(t, 'CHECK-18', undefined, false); observe(flow, readyDetail, oldPr);
    assert.equal(model(flow).ready.length, 0);
    const omissions = model(flow).snapshot?.omissions.join('\n') ?? '';
    assert.match(omissions, /Conflict.*PR identity/i); assert.ok(omissions.includes(currentPr)); assert.ok(omissions.includes(oldPr));
    const http = await flow.http(); assert.match((await http('GET', '/projects/project-1/work')).text, /Conflict.*PR identity/i);
  });
});
