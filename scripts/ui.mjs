#!/usr/bin/env node
// Explicit local fixture UI only. Nothing imports this script in tests.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ProjectStore, RecordsSchema, ToolkitApi, manageExecutionTask } from '../dist/src/index.js';
import { createToolkitRequestHandler } from '../dist/src/ui-http.js';
import { fakeTask, fakeTaskWrapper } from '../dist/src/testing/task-wrapper.js';

const port = Number(process.env.SF_UI_PORT ?? 3185);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SF_UI_PORT must be an integer from 1 to 65535');
const root = mkdtempSync(join(tmpdir(), 'software-factory-ui-'));
const database = join(root, 'toolkit.sqlite');
const store = new ProjectStore(database);
let server;
const cleanup = () => { store.close(); rmSync(root, { recursive: true, force: true }); };
try {
  const history = RecordsSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/ui-overview.json', import.meta.url), 'utf8')));
  store.importProject({ schemaVersion: 1, projectId: 'project-1', history, receipts: [] });
  const transport = fakeTaskWrapper(root, true, database);
  transport.edit((state) => {
    state.tasks['pilot-build'] = fakeTask('pilot-build', { title: 'Common connected-system feature', priority: 1, state: 'done' });
    state.tasks['pilot-verify'] = fakeTask('pilot-verify', { title: 'Second-system acceptance', priority: 2 });
  });
  const adapter = { fmHome: root, tasksExecutable: transport.executable };
  // Record observations through the same BUILD-08 path the task editors use.
  for (const mapping of store.records('project-1').filter((record) => record.kind === 'task_mapping')) {
    manageExecutionTask(store, { schemaVersion: 1, id: `fixture-${mapping.id}`, projectId: mapping.projectId,
      issuedAt: new Date().toISOString(), idempotencyKey: `fixture-${mapping.id}`, targetId: mapping.id,
      expectedRevision: mapping.revision, command: 'map_manage_execution_task', payload: {
        feature: mapping.feature, criteria: mapping.criteria, detailedPlanTask: mapping.detailedPlanTask,
        task: { kind: 'existing', firstMateTaskId: mapping.firstMateTaskId }, action: 'map',
        dependencies: mapping.dependencies, reason: 'Observe isolated synthetic tasks for the local UI fixture' } }, adapter);
  }
  const scottyUrl = process.env.SF_SCOTTY_URL;
  if (scottyUrl && !/^http:\/\/127\.0\.0\.1:\d+\/?$/u.test(scottyUrl)) throw new Error('SF_SCOTTY_URL must be a loopback HTTP origin');
  const staleAfterMs = Number(process.env.SF_UI_STALE_AFTER_MS ?? 60000);
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error('SF_UI_STALE_AFTER_MS must be a positive number');
  const snapshot = JSON.parse(readFileSync(new URL('../fixtures/ui-work-snapshot.json', import.meta.url), 'utf8'));
  // Keep the sample ready age meaningful without claiming an actual runtime read.
  snapshot.observedAt = new Date().toISOString();
  snapshot.tasks[0].ready[0].readySince = new Date(Date.now() - 30 * 60000).toISOString();
  const api = new ToolkitApi(store, adapter, { projectId: 'project-1', fixture: true, staleAfterMs,
    readSnapshot: () => snapshot, ...(scottyUrl ? { scottyUrl } : {}) });
  server = createServer(createToolkitRequestHandler(api, { port }));
  server.once('error', (error) => { cleanup(); console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Software Factory fixture UI: http://127.0.0.1:${port}\nSynthetic data only. Ctrl-C discards this session.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { cleanup(); process.exit(0); }));
} catch (error) { cleanup(); throw error; }
