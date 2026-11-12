import { buildEditCommand, type EditContext } from './ui-edit.js';
import type { CommandEnvelope } from './commands.js';
import type { Ref } from './primitives.js';

const pageState = document.querySelector<HTMLElement>('#page-state')!;
const forms = [...document.querySelectorAll<HTMLFormElement>('form[data-editor]')];
const states = forms.map(() => ({ dirty: false, pending: undefined as CommandEnvelope | undefined, busy: false, conflicted: false, version: 0, submittedVersion: 0 }));
const protectedEdits = () => states.some((state) => state.dirty || state.pending || state.busy || state.conflicted);
const editorIdentity = (context: EditContext) => JSON.stringify(context.kind === 'task' ? [context.kind, context.mapping.id, context.action] :
  context.kind === 'answer' ? [context.kind, context.decision.id, context.reuse?.id] :
  context.kind === 'standing-instruction' ? [context.kind, context.projectId] :
  context.kind === 'criterion' ? [context.kind, context.criterion.id] :
  context.kind === 'feature' ? [context.kind, context.feature.id] :
  [context.kind, context.feature.id, context.design.id, context.plan.id, context.kind === 'plan-task' ? context.taskId : undefined]);
const editorRevisions = (context: EditContext): Ref[] => context.kind === 'task' ? [context.mapping] :
  context.kind === 'answer' ? [context.decision, ...(context.reuse ? [context.reuse] : [])] :
  context.kind === 'standing-instruction' ? context.guidance :
  context.kind === 'criterion' ? [context.feature, context.criterion] :
  context.kind === 'feature' ? [context.feature] :
  context.expectedRevisions ?? [context.feature, context.design, context.plan, ...context.tasks];
const lastRefresh = Date.now();
const configuredThreshold = Number(document.querySelector<HTMLElement>('main')?.dataset?.staleAfterMs);
const staleAfterMs = Number.isFinite(configuredThreshold) && configuredThreshold > 0 ? configuredThreshold : 60000;
const snapshotLabels = [...document.querySelectorAll<HTMLElement>('[data-snapshot-at]')];
for (const form of forms) {
  const state = states[forms.indexOf(form)]!;
  const output = form.querySelector('output')!;
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const conflict = () => {
    state.conflicted = true;
    output.textContent = 'Stale — revision conflict. Your edit is retained. Reload and compare the current record before saving again.';
    pageState.textContent = 'Stale — another edit changed a referenced revision. Reload to compare.';
    state.pending = undefined;
    button.textContent = 'Reload current records';
    button.type = 'button';
    button.disabled = false;
    button.addEventListener('click', () => { if (confirm('Reload current records? Copy any unsaved edits first.')) location.reload(); });
  };
  form.addEventListener('input', () => { state.dirty = true; state.version++; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy || state.conflicted) return;
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
        conflict();
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
      state.dirty = state.version !== state.submittedVersion;
      output.textContent = 'Saved — reload to inspect the current records.';
      if (result.resumeUrl) {
        const link = document.createElement('a');
        link.href = result.resumeUrl; link.textContent = ' Inspect/Resume saved bundle'; output.append(link);
      }
      if (state.dirty) {
        // Advance only to revisions proved by this save. A competing writer's
        // newer context must not authorize overwriting it with retained inputs.
        const refreshed = await fetch(result.resumeUrl ?? location.href);
        if (!refreshed.ok) throw new Error('Could not refresh saved revision context. Keep your draft and reload to compare.');
        const page = new DOMParser().parseFromString(await refreshed.text(), 'text/html');
        const candidates = [...page.querySelectorAll<HTMLFormElement>('form[data-editor]')];
        const current = candidates.map((candidate) => candidate.querySelector<HTMLInputElement>('[name=context]')?.value)
          .find((value) => value && editorIdentity(JSON.parse(value) as EditContext) === editorIdentity(context));
        if (!current) { conflict(); return; }
        const before = editorRevisions(context);
        const expected = new Map([...before, ...(result.records ?? []), ...(result.mapping ? [result.mapping] : [])]
          .map((record: Ref) => [record.id, record.revision]));
        const refreshedRevisions = editorRevisions(JSON.parse(current) as EditContext);
        if (refreshedRevisions.some((record) => expected.get(record.id) !== record.revision) ||
          before.some((record) => !refreshedRevisions.some((fresh) => fresh.id === record.id))) {
          conflict(); return;
        }
        form.querySelector<HTMLInputElement>('[name=context]')!.value = current;
        button.disabled = false;
        button.textContent = 'Save change';
        output.textContent = 'Saved — newer input is retained and ready to save.';
      }
      state.busy = false;
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
