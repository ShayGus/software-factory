#!/usr/bin/env node
// Serve an existing project and its imported runtime observations.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createServer } from 'node:http';
import { ProjectStore, ToolkitApi, TaskAdapterOptionsSchema } from '../dist/src/index.js';
import { createToolkitRequestHandler } from '../dist/src/ui-http.js';

const port = Number(process.env.SF_UI_PORT ?? 3185);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SF_UI_PORT must be an integer from 1 to 65535');
const database = process.env.SF_UI_DB;
const projectId = process.env.SF_UI_PROJECT;
if (!database || !isAbsolute(database) || !existsSync(database) || !projectId) {
  throw new Error('Set SF_UI_DB to an existing absolute SQLite path and SF_UI_PROJECT to its project ID');
}
const staleAfterMs = Number(process.env.SF_UI_STALE_AFTER_MS ?? 60000);
if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error('SF_UI_STALE_AFTER_MS must be a positive number');
const scottyUrl = process.env.SF_SCOTTY_URL;
if (scottyUrl && !/^http:\/\/127\.0\.0\.1:\d+\/?$/u.test(scottyUrl)) throw new Error('SF_SCOTTY_URL must be a loopback HTTP origin');
const adapter = process.env.SF_UI_ADAPTER_CONFIG ? TaskAdapterOptionsSchema.parse(JSON.parse(readFileSync(process.env.SF_UI_ADAPTER_CONFIG, 'utf8'))) : undefined;
const store = new ProjectStore(database);
try {
  if (store.get(projectId, projectId)?.kind !== 'project') throw new Error('SF_UI_PROJECT does not identify an existing project');
  const api = new ToolkitApi(store, adapter, { projectId, staleAfterMs, ...(scottyUrl ? { scottyUrl } : {}) });
  const server = createServer(createToolkitRequestHandler(api, { port }));
  server.once('error', (error) => { store.close(); console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Software Factory UI: http://127.0.0.1:${port}\nProject: ${projectId}; runtime freshness reflects the last imported observation.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { store.close(); process.exit(0); }));
} catch (error) { store.close(); throw error; }
