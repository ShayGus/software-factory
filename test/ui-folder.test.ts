import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FolderToolkitApi } from '../src/ui-folder.js';
import { ProjectStore, RecordsSchema, buildEditCommand } from '../src/index.js';

test('folder discovers multiple project databases live and routes reads and canonical edits to the selected project', t => {
  const root = mkdtempSync(join(tmpdir(), 'sf-folder-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, 'projects.json');
  const save = (projects: unknown[]) => writeFileSync(registry, JSON.stringify({ version: 1, projects }));
  save([]);
  const api = new FolderToolkitApi(registry, root, 'http://127.0.0.1:3999');
  assert.match(String(api.handle('GET', '/').body), /No projects yet/);
  const projects = ['project-1', 'project-2'].map(projectId => {
    const database = join(root, `${projectId}.sqlite`);
    const store = new ProjectStore(database);
    try {
      const history = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../../fixtures/ui-overview.json', import.meta.url), 'utf8').replaceAll('project-1', projectId)));
      store.importProject({ schemaVersion: 1, projectId, history, receipts: [] });
    } finally { store.close(); }
    return { home: root, projectId, database, agentConfig: join(root, 'agents.json') };
  });
  save(projects);
  const index = String(api.handle('GET', '/').body);
  for (const project of projects) {
    assert.match(index, new RegExp(`href="/projects/${project.projectId}"`));
    assert.equal(api.handle('GET', `/projects/${project.projectId}`).status, 200);
    assert.equal(api.handle('GET', `/projects/${project.projectId}/work`).status, 200);
    assert.equal(api.handle('GET', `/projects/${project.projectId}/decisions`).status, 200);
    const page = String(api.handle('GET', `/projects/${project.projectId}`).body);
    const featuresLink = page.match(/href="([^"]+)">Features</)?.[1];
    assert.ok(featuresLink);
    assert.equal(api.handle('GET', featuresLink).status, 200);
    for (const suffix of ['', '/work', '/dependencies', '/features/feature-1']) {
      const taskPage = String(api.handle('GET', `/projects/${project.projectId}${suffix}`).body);
      assert.doesNotMatch(taskPage, /Cancel execution task<\/summary>/);
      assert.match(taskPage, /Cancel execution tasks through FirstMate chat/);
    }
  }
  const store = new ProjectStore(projects[1]!.database);
  const mapping = store.records('project-2').find(record => record.kind === 'task_mapping')!;
  assert.equal(mapping.kind, 'task_mapping');
  if (mapping.kind !== 'task_mapping') throw new Error('missing fixture mapping');
  const before = store.exportProject('project-2');
  const cancel = buildEditCommand({ kind: 'task', mapping, action: 'cancel' }, { reason: 'Must hand off to host before mutation' }, 'folder-cancel', new Date().toISOString());
  const refused = api.handle('POST', '/canonical', cancel);
  assert.equal(refused.status, 409);
  assert.match(JSON.stringify(refused.body), /firstmate_control_required/);
  assert.deepEqual(store.exportProject('project-2'), before, 'No cancellation disposition, hold or receipt may be committed');
  const feature = store.records('project-2').find(record => record.kind === 'feature_revision')!;
  assert.equal(feature.kind, 'feature_revision');
  if (feature.kind !== 'feature_revision') throw new Error('missing fixture feature');
  const command = buildEditCommand({ kind: 'feature', feature }, { outcome: 'Only project two changes', priority: '1', disposition: 'active', reason: 'folder routing' }, 'folder-edit', new Date().toISOString());
  store.close();
  const result = api.handle('POST', '/canonical', command);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(JSON.stringify(api.handle('GET', '/projects/project-2/overview').body), /Only project two changes/);
  assert.doesNotMatch(JSON.stringify(api.handle('GET', '/projects/project-1/overview').body), /Only project two changes/);
  assert.equal(api.handle('POST', '/canonical', { ...command, projectId: 'unregistered' }).status, 404);
  save([projects[0]]);
  assert.equal(api.handle('GET', '/projects/project-2').status, 404);
  rmSync(projects[0]!.database);
  assert.match(String(api.handle('GET', '/').body), /Records unavailable/);
  assert.equal(api.handle('GET', '/projects/project-1').status, 503);
});
