import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { FirstMateInboxNoteSchema } from './firstmate.js';
import { DecisionChangeSchema, type Operation } from './records.js';
import { pendingOperation, ProjectStore, StoreError } from './store.js';
import { ref, requestRecord, stableId } from './intake.js';

export interface DeliveryOptions {
  /** Always explicit: never inherit an ambient FM_HOME. */
  fmHome: string;
  /** Defaults to <fmHome>/bin/fm-inbox.sh. Useful with a separate FirstMate installation. */
  inboxExecutable?: string;
  timeoutMs?: number;
}

/** No scheduler or worker control: deliver one already-committed capture intent. */
export function deliverRequest(store: ProjectStore, projectId: string, requestId: string, options: DeliveryOptions): Operation {
  return store.withTaskLock(projectId, () => deliverRequestIntent(store, projectId, requestId, options));
}

function deliverRequestIntent(store: ProjectStore, projectId: string, requestId: string, options: DeliveryOptions): Operation {
  if (!isAbsolute(options.fmHome)) throw new StoreError('validation', 'explicit_absolute_FM_HOME_required');
  const executable = options.inboxExecutable ?? join(options.fmHome, 'bin', 'fm-inbox.sh');
  if (!isAbsolute(executable)) throw new StoreError('validation', 'absolute_inbox_executable_required');
  const request = requestRecord(store, projectId, requestId);
  const operation = store.get(projectId, stableId('delivery', requestId));
  if (operation?.kind !== 'operation' || operation.command !== 'capture_request') {
    throw new StoreError('not_found', 'capture_delivery_operation_not_found');
  }
  store.assertExternalOperationsAllowed(projectId, operation);
  if (operation.state === 'succeeded') return operation;
  // Validate durable intent against its original command, including imported stores.
  const receipt = store.exportProject(projectId).receipts.find((entry) =>
    entry.command.command === 'capture_request' && entry.command.targetId === request.id &&
    entry.command.idempotencyKey === operation.idempotencyKey);
  if (!receipt) throw new StoreError('validation', 'capture_receipt_required_for_delivery');
  const intent = pendingOperation(receipt.command, operation.id);
  if (intent.payloadDigest !== operation.payloadDigest) throw new StoreError('validation', 'capture_delivery_digest_mismatch');

  let raw = '';
  let state: Operation['state'] = 'unknown';
  let note = '';
  let externalReferences: Operation['externalReferences'] = [];
  let processFailure: { stdout?: unknown; stderr?: unknown; message?: string; code?: string } | undefined;
  // An inherited state/wake/root override must not redirect an explicit home.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FM_')));
  env.FM_HOME = resolve(options.fmHome);
  try {
    // Toolkit IDs include the project namespace. A client may reuse its local ID
    // in another project sharing this FirstMate home without colliding there.
    raw = execFileSync(executable, ['note', '--request-id', request.id, '--json', '-'], {
      cwd: resolve(options.fmHome), env, input: request.originalText,
      encoding: 'utf8', timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    processFailure = error as NonNullable<typeof processFailure>;
    if (processFailure.stdout) raw = String(processFailure.stdout);
  }
  try {
    const response = FirstMateInboxNoteSchema.parse(JSON.parse(raw));
    if (response.request_id !== request.id || !response.saved) {
      throw new Error('FirstMate did not confirm this request was saved');
    }
    state = 'succeeded'; // `replay` confirms the same saved note, never another capture.
    note = JSON.stringify(response);
    externalReferences = [{ uri: `firstmate:inbox/${encodeURIComponent(response.id)}` }, { uri: response.path }];
  } catch (error) {
    // A valid saved receipt is authoritative even on exit 3 (alert failed).
    // Without one, a timeout or nonzero exit can still follow a save. Retry the
    // SAME request ID so FirstMate reconciles through its replay path.
    const failure = processFailure ?? { message: error instanceof Error ? error.message : String(error) };
    state = failure.code === 'ENOENT' || failure.code === 'EACCES' ? 'failed' : 'unknown';
    note = JSON.stringify({ error: failure.message ?? String(error), stdout: raw,
      stderr: failure.stderr ? String(failure.stderr) : '', fmHome: resolve(options.fmHome) });
  }
  const at = new Date().toISOString();
  const decision = DecisionChangeSchema.parse({
    kind: 'decision_change', id: randomUUID(), projectId, schemaVersion: 1, revision: 1,
    createdAt: at, updatedAt: at, questionOrChange: 'Record FirstMate request delivery observation',
    affectedRecords: [ref(operation)], rationale: note, disposition: 'selected',
    sourceRefs: [{ uri: `factory:request/${encodeURIComponent(request.id)}`, record: { id: request.id, revision: 1 } }],
    scopeChanges: [],
  });
  const next: Operation = { ...operation, revision: operation.revision + 1, updatedAt: at, state, externalReferences,
    reconciliation: { observedAt: at, observedState: state, note, evidence: [{
      artifact: { uri: `factory:delivery-observation/${decision.id}`,
        digest: `sha256:${createHash('sha256').update(note).digest('hex')}` },
      description: note, observedAt: at,
    }] } };
  store.mutate({ schemaVersion: 1, id: randomUUID(), projectId, issuedAt: at,
    idempotencyKey: randomUUID(), command: 'record_decision_suggestion', targetId: operation.id,
    expectedRevision: operation.revision, payload: { decision },
  }, () => [decision, next]);
  return next;
}
