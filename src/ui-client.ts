import { buildEditCommand, type EditContext } from './ui-edit.js';
import type { CommandEnvelope } from './commands.js';

const pageState = document.querySelector<HTMLElement>('#page-state')!;
const forms = [...document.querySelectorAll<HTMLFormElement>('form[data-editor]')];
let dirty = false;
let lastRefresh = Date.now();
for (const form of forms) {
  let pending: CommandEnvelope | undefined;
  let busy = false;
  const output = form.querySelector('output')!;
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    try {
      const data = new FormData(form);
      const context = JSON.parse(String(data.get('context'))) as EditContext;
      const values = Object.fromEntries([...data.entries()].filter(([key]) => key !== 'context').map(([key, value]) => [key, String(value)]));
      pending ??= buildEditCommand(context, values, crypto.randomUUID(), new Date().toISOString());
      busy = true;
      button.disabled = true;
      output.textContent = 'Loading — saving canonical operation…';
      const response = await fetch('/canonical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) });
      const result = await response.json();
      if (response.status === 409) {
        output.textContent = 'Stale — revision conflict. Your edit is retained. Reload and compare the current record before saving again.';
        pageState.textContent = 'Stale — another edit changed a referenced revision. Reload to compare.';
        pending = undefined;
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
        link.href = `/projects/${encodeURIComponent(pending.projectId)}/inspect/${encodeURIComponent(result.operation.id)}`;
        link.textContent = ' Inspect saved operation';
        output.append(link);
        pending = undefined;
        return;
      }
      if (!response.ok) {
        output.textContent = `${result.error?.code ?? 'Validation'} — ${result.error?.message ?? 'Could not save this change.'}`;
        pending = undefined;
        button.disabled = false;
        return;
      }
      pending = undefined;
      dirty = false;
      pageState.textContent = 'Saved — reloading current records…';
      location.reload();
    } catch (error) {
      output.textContent = pending ? 'Unknown — response unavailable. Retry sends the exact same idempotency key and payload; keep this page open.' :
        `Validation — ${error instanceof Error ? error.message : String(error)}`;
      button.textContent = pending ? 'Retry same operation' : 'Save change';
      button.disabled = false;
    } finally { busy = false; }
  });
}
window.addEventListener('beforeunload', (event) => { if (dirty) event.preventDefault(); });
// Local reads refresh freshness only; unsaved editor values are never replaced.
setInterval(() => {
  if (Date.now() - lastRefresh > 60000) pageState.textContent = 'Stale — page was loaded over a minute ago. Reload to inspect current records.';
}, 10000);
window.addEventListener('online', () => { pageState.textContent = 'Stale — connection restored. Reload before starting a new edit.'; });
window.addEventListener('offline', () => { pageState.textContent = 'Unknown — connection unavailable. Saved task outcomes may need reconciliation.'; });
lastRefresh = Date.now();
