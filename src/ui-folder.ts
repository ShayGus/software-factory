import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerHookConfigSchema } from './worker-start-hook.js';
import { ProjectStore } from './store.js';
import { ToolkitApi, type SpikeResponse } from './ui-spike.js';
import { escapeHtml as h } from './ui-pages.js';

/** The dispatch registry owns project discovery. Re-read it for each request so
 * newly initialized projects appear without restarting the folder service. */
export class FolderToolkitApi {
  constructor(readonly registry: string, readonly home: string, readonly scottyUrl?: string) {}

  handle(method: string, path: string, body?: unknown): SpikeResponse {
    try {
      const projects = WorkerHookConfigSchema.parse(JSON.parse(readFileSync(this.registry, 'utf8'))).projects
        .filter(entry => realpathSync(entry.home) === realpathSync(this.home));
      if (new Set(projects.map(entry => entry.projectId)).size !== projects.length) throw new Error('Duplicate project IDs in factory registry');
      const url = new URL(path, 'http://factory.invalid');
      if (method === 'GET' && url.pathname === '/') {
        const rows = projects.map(entry => {
          let name = entry.projectId;
          let error = '';
          let store: ProjectStore | undefined;
          try {
            if (!existsSync(entry.database)) throw new Error('Project database is unavailable');
            store = new ProjectStore(entry.database, { readOnly: true });
            const record = store.get(entry.projectId, entry.projectId);
            if (record?.kind !== 'project') throw new Error('Project record is unavailable');
            name = record.goal;
          } catch { error = 'Records unavailable. Check this project’s database, then reload.'; }
          finally { store?.close(); }
          return `<article><h2><a href="/projects/${encodeURIComponent(entry.projectId)}">${h(name)}</a></h2>
            <p>${h(entry.projectId)}</p>${error ? `<p role="status">${h(error)}</p>` : ''}</article>`;
        }).join('');
        return { status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en"><head>
          <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Projects · Software Factory</title>
          <link rel="stylesheet" href="/assets/ui.css"></head><body><a class="skip" href="#main">Skip to content</a>
          <header><a class="brand" href="/">Software Factory</a><nav aria-label="Main">${this.scottyUrl ? `<a href="${h(this.scottyUrl)}">Scotty tickets and dependencies (read-only)</a>` : ''}</nav></header>
          <main id="main"><h1>Projects</h1><p class="prose">Requests, features, plans, decisions and work for this factory folder.</p>
          ${projects.length ? rows : '<section><h2>No projects yet</h2><p class="prose">Open Claude in this factory folder and ask FirstMate to work on a registered project. Its factory records will appear here after the first request.</p></section>'}
          </main></body></html>` };
      }
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const projectId = parts[0] === 'projects' ? parts[1] :
        method === 'POST' && body && typeof body === 'object' && 'projectId' in body ? body.projectId : undefined;
      const entry = projects.find(entry => entry.projectId === projectId);
      if (!entry) return { status: 404, body: { error: { code: 'not_found', message: 'Project is not registered in this factory folder' } } };
      if (!existsSync(entry.database)) throw new Error('Project database is unavailable');
      const store = new ProjectStore(entry.database);
      try {
        // Active-worker cancellation stays with FirstMate on the host. A UI
        // container cannot attest to host process or tmux session termination.
        const api = new ToolkitApi(store, { fmHome: this.home, tasksExecutable: join(this.home, 'bin/fm-tasks-axi.sh') },
        { projectId: entry.projectId, ...(this.scottyUrl ? { scottyUrl: this.scottyUrl } : {}) });
        return api.handle(method, parts.length === 2 && method === 'GET' ? '/' : path, body);
      } finally { store.close(); }
    } catch (error) {
      return { status: 503, body: { error: { code: 'factory_unavailable', message: error instanceof Error ? error.message : String(error) } } };
    }
  }
}
