import { buildEditCommand, type EditContext } from './ui-edit.js';
import type { CommandEnvelope } from './commands.js';

const pageState = document.querySelector<HTMLElement>('#page-state')!;
const forms = [...document.querySelectorAll<HTMLFormElement>('form[data-editor]')];
const states = forms.map(() => ({ dirty: false, pending: undefined as CommandEnvelope | undefined, busy: false, version: 0, submittedVersion: 0 }));
const protectedEdits = () => states.some((state) => state.dirty || state.pending || state.busy);
const lastRefresh = Date.now();
const configuredThreshold = Number(document.querySelector<HTMLElement>('main')?.dataset?.staleAfterMs);
const staleAfterMs = Number.isFinite(configuredThreshold) && configuredThreshold > 0 ? configuredThreshold : 60000;
const snapshotLabels = [...document.querySelectorAll<HTMLElement>('[data-snapshot-at]')];
for (const form of forms) {
  const state = states[forms.indexOf(form)]!;
  const output = form.querySelector('output')!;
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  form.addEventListener('input', () => { state.dirty = true; state.version++; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    try {
      const data = new FormData(form);
      const context = JSON.parse(String(data.get('context'))) as EditContext;
      const values = Object.fromEntries([...data.entries()].filter(([key]) => key !== 'context').map(([key, value]) => [key, String(value)]));
      if (!state.pending) {
        state.pending = buildEditCommand(context, values, crypto.randomUUID(), new Date().toISOString());
        state.submittedVersion = state.version;
      }
      state.busy = true;
      button.disabled = true;
      output.textContent = 'Loading — saving canonical operation…';
      const response = await fetch('/canonical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.pending) });
      const result = await response.json();
      if (response.status === 409) {
        output.textContent = 'Stale — revision conflict. Your edit is retained. Reload and compare the current record before saving again.';
        pageState.textContent = 'Stale — another edit changed a referenced revision. Reload to compare.';
        state.pending = undefined;
        button.textContent = 'Reload current records';
        button.type = 'button';
        button.disabled = false;
        button.addEventListener('click', () => { if (confirm('Reload current records? Copy any unsaved edits first.')) location.reload(); });
        return;
      }
      if (result.operation?.state && result.operation.state !== 'succeeded') {
        output.textContent = result.operation.state === 'unknown' ? 'Unknown outcome — inspect the operation before any further task edit.' :
          `${result.operation.state} — inspect the operation and its evidence.`;
        pageState.textContent = String(output.textContent);
        const link = document.createElement('a');
        link.href = `/projects/${encodeURIComponent(state.pending.projectId)}/inspect/${encodeURIComponent(result.operation.id)}`;
        link.textContent = ' Inspect saved operation';
        output.append(link);
        state.pending = undefined;
        return;
      }
      if (!response.ok) {
        output.textContent = `${result.error?.code ?? 'Validation'} — ${result.error?.message ?? 'Could not save this change.'}`;
        state.pending = undefined;
        button.disabled = false;
        return;
      }
      state.pending = undefined;
      state.busy = false;
      state.dirty = state.version !== state.submittedVersion;
      output.textContent = 'Saved — reload to inspect the current records.';
      if (result.resumeUrl) {
        const link = document.createElement('a');
        link.href = result.resumeUrl; link.textContent = ' Inspect/Resume saved bundle'; output.append(link);
      }
      if (protectedEdits()) {
        pageState.textContent = 'Saved — drafts or unresolved commands remain on this page. Reload after preserving them.';
      } else {
        pageState.textContent = 'Saved — reloading current records…';
        if (result.resumeUrl) location.assign(result.resumeUrl); else location.reload();
      }
    } catch (error) {
      output.textContent = state.pending ? 'Unknown — response unavailable. Retry sends the exact same idempotency key and payload; keep this page open.' :
        `Validation — ${error instanceof Error ? error.message : String(error)}`;
      button.textContent = state.pending ? 'Retry same operation' : 'Save change';
      button.disabled = false;
    } finally { state.busy = false; }
  });
}
window.addEventListener('beforeunload', (event) => { if (protectedEdits()) event.preventDefault(); });
// Local reads refresh freshness only; unsaved editor values are never replaced.
setInterval(() => {
  if (Date.now() - lastRefresh > staleAfterMs) pageState.textContent = 'Stale — page has exceeded its freshness threshold. Reload to inspect current records.';
  for (const label of snapshotLabels) {
    const at = label.dataset?.snapshotAt;
    const threshold = Number(label.dataset?.staleAfterMs);
    if (at && Date.now() - Date.parse(at) > threshold) label.textContent = `Stale — FirstMate snapshot taken ${at}`;
  }
}, 10000);
window.addEventListener('online', () => { pageState.textContent = 'Stale — connection restored. Reload before starting a new edit.'; });
window.addEventListener('offline', () => { pageState.textContent = 'Unknown — connection unavailable. Saved task outcomes may need reconciliation.'; });
