import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CommandEnvelopeSchema, type BoundaryError, type CommandEnvelope } from './commands.js';
import { IdSchema, RefSchema, type Ref } from './primitives.js';
import { OperationSchema, RecordsSchema, type FactoryRecord, type Operation } from './records.js';
import {
  assertExpectedRevision, assertIdempotencyReuse, assertRevisionTransition, commandDigest, validateRecords,
} from './rules.js';

export type MutationCommand = Exclude<CommandEnvelope, { command: 'read_project_state_export' }>;
export const MutationResultSchema = z.strictObject({ records: z.array(RefSchema).min(1) });
export type MutationResult = z.infer<typeof MutationResultSchema>;
const ReceiptSchema = z.strictObject({ command: CommandEnvelopeSchema, result: MutationResultSchema });
export const ProjectExportSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: IdSchema, history: RecordsSchema.min(1),
  receipts: z.array(ReceiptSchema),
});
export type ProjectExport = z.infer<typeof ProjectExportSchema>;

/** Uses the BUILD-02 error vocabulary; specific causes are retained in message. */
export class StoreError extends Error {
  readonly detail: BoundaryError;
  constructor(code: BoundaryError['code'], message: string, paths: string[] = []) {
    super(message);
    this.name = 'StoreError';
    this.detail = { code, message, paths, externalReferences: [] };
  }
}
function fail(message: string): never { throw new StoreError('validation', message); }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new StoreError('validation', result.error.message,
    result.error.issues.map((issue) => issue.path.join('.')));
  return result.data;
}
function mutation(input: unknown): MutationCommand {
  const command = parse(CommandEnvelopeSchema, input);
  if (command.command === 'read_project_state_export') fail('read_command_is_not_mutation');
  return command;
}
function expected(expectedRevision: number, actual: FactoryRecord | undefined): void {
  try { assertExpectedRevision(expectedRevision, actual?.revision ?? null); }
  catch { throw new StoreError('conflict', 'revision_conflict', [actual?.id ?? 'targetId']); }
}
function transition(previous: FactoryRecord | undefined, next: FactoryRecord): void {
  if (!previous) {
    if (next.revision !== 1) fail('initial_revision_must_be_one');
  } else {
    try { assertRevisionTransition(previous, next); }
    catch (error) { fail(error instanceof Error ? error.message : 'invalid_revision_transition'); }
    if (previous.kind === 'operation' && next.kind === 'operation' &&
      (previous.command !== next.command || previous.idempotencyKey !== next.idempotencyKey ||
        previous.payloadDigest !== next.payloadDigest)) fail('operation_identity_change');
  }
}
function validateHistory(records: FactoryRecord[]): void {
  const checked = validateRecords(records);
  if (!checked.ok) throw new StoreError('validation', checked.issues.map((issue) =>
    `${issue.code}: ${issue.message}`).join('; '), checked.issues.map((issue) => `${issue.recordId}.${issue.path}`));
  const previous = new Map<string, FactoryRecord>();
  for (const record of [...records].sort((a, b) => a.revision - b.revision)) {
    transition(previous.get(record.id), record);
    previous.set(record.id, record);
  }
  const operationKeys = new Map<string, string>();
  const requestKeys = new Map<string, string>();
  for (const record of records) {
    const keys = record.kind === 'operation' ? operationKeys : record.kind === 'request' ? requestKeys : null;
    if (!keys) continue;
    const key = record.kind === 'operation' ? record.idempotencyKey :
      record.kind === 'request' ? record.clientRequestId : '';
    const existing = keys.get(key);
    if (existing && existing !== record.id) fail('duplicate_client_or_operation_key');
    keys.set(key, record.id);
  }
}
const same = (left: Ref, right: Ref) => left.id === right.id && left.revision === right.revision;

/** Construct an intent only: no external action or reconciliation is performed. */
export function pendingOperation(input: unknown, id: string): Operation {
  const command = mutation(input);
  return OperationSchema.parse({
    kind: 'operation', id, projectId: command.projectId, schemaVersion: 1, revision: 1,
    createdAt: command.issuedAt, updatedAt: command.issuedAt,
    idempotencyKey: command.idempotencyKey, command: command.command, payloadDigest: commandDigest(command),
    state: 'pending', externalReferences: [], reconciliation: null,
  });
}

/** Synchronous local persistence. Application handlers derive records; this class owns atomic writes. */
export class ProjectStore {
  readonly #db: DatabaseSync;
  #transactionOpen = false;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) fail('unsupported_database_version');
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS record_history (
          project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
          kind TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
          PRIMARY KEY(id, revision)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS history_project ON record_history(project_id, id, revision);
        CREATE TABLE IF NOT EXISTS command_receipts (
          project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(project_id, idempotency_key)
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#db.close(); }

  history(projectId: string): FactoryRecord[] {
    parse(IdSchema, projectId);
    return this.#db.prepare('SELECT body FROM record_history WHERE project_id = ? ORDER BY id, revision')
      .all(projectId).map((row) => parse(RecordsSchema, [JSON.parse(String(row.body))])[0]!);
  }
  records(projectId: string): FactoryRecord[] {
    const latest = new Map<string, FactoryRecord>();
    for (const record of this.history(projectId)) latest.set(record.id, record);
    return [...latest.values()];
  }
  get(projectId: string, id: string, revision?: number): FactoryRecord | undefined {
    return this.history(projectId).filter((record) => record.id === id &&
      (revision === undefined || record.revision === revision)).at(-1);
  }
  receipt(projectId: string, idempotencyKey: string) {
    const row = this.#db.prepare('SELECT body FROM command_receipts WHERE project_id = ? AND idempotency_key = ?')
      .get(parse(IdSchema, projectId), parse(IdSchema, idempotencyKey));
    return row ? parse(ReceiptSchema, JSON.parse(String(row.body))) : undefined;
  }

  operations(projectId: string): Operation[] {
    return this.records(projectId).filter((record): record is Operation => record.kind === 'operation');
  }

  /**
   * prepare is a trusted, synchronous, side-effect-free application handler. It runs only
   * for a new key under the write lock. Include any pending Operation in the returned records.
   * Each returned revision implies expectedRevision = revision - 1 for that record.
   */
  mutate(input: unknown, prepare: (history: FactoryRecord[]) => unknown): MutationResult {
    const command = mutation(input);
    return this.#transaction(() => {
      const receipt = this.#db.prepare('SELECT body FROM command_receipts WHERE project_id = ? AND idempotency_key = ?')
        .get(command.projectId, command.idempotencyKey);
      if (receipt) {
        const first = parse(ReceiptSchema, JSON.parse(String(receipt.body)));
        let original = first.command;
        // Older initialization receipts recorded the project in their result only.
        if (command.command === 'record_decision_suggestion' && command.payload.project &&
          original.command === 'record_decision_suggestion' && !original.payload.project && original.expectedRevision === 0) {
          const { targetId } = original;
          const ref = first.result.records.find((record) => record.id === targetId && record.revision === 1);
          const project = ref && this.get(original.projectId, ref.id, ref.revision);
          if (project?.kind === 'project') original = { ...original, payload: { ...original.payload, project } };
        }
        if (commandDigest(original) !== commandDigest(command)) fail('idempotency_conflict');
        return first.result;
      }
      // An imported operation without a receipt still reserves its key: never execute it again.
      if (this.operations(command.projectId).some((op) => op.idempotencyKey === command.idempotencyKey)) {
        fail('operation_key_has_no_replay_receipt');
      }
      const history = this.history(command.projectId);
      const latest = new Map<string, FactoryRecord>();
      for (const record of history) latest.set(record.id, record);
      expected(command.expectedRevision, latest.get(command.targetId));
      if (command.command === 'design_plan_feature' && 'expectedRevisions' in command.payload) for (const ref of command.payload.expectedRevisions) {
        expected(ref.revision, latest.get(ref.id));
      }
      const writes = parse(RecordsSchema.min(1), prepare(structuredClone(history)));
      const ids = new Set<string>();
      for (const record of writes) {
        if (record.projectId !== command.projectId) fail('project_mismatch');
        if (ids.has(record.id)) fail('duplicate_write');
        ids.add(record.id);
        // IDs are globally stable, including across projects.
        const owner = this.#db.prepare('SELECT project_id FROM record_history WHERE id = ? LIMIT 1').get(record.id);
        if (owner && owner.project_id !== record.projectId) fail('identity_change');
        const previous = latest.get(record.id);
        expected(record.revision - 1, previous);
        transition(previous, record);
        if (record.kind === 'operation' && !previous) {
          try { assertIdempotencyReuse(record, command); }
          catch { fail('idempotency_conflict'); }
          if (record.state !== 'pending' || record.reconciliation !== null || record.externalReferences.length) {
            fail('new_operation_must_be_pending');
          }
        }
      }
      validateHistory([...history, ...writes]);
      const result = MutationResultSchema.parse({ records: writes.map(({ id, revision }) => ({ id, revision })) });
      for (const record of writes) this.#insertRecord(record);
      this.#db.prepare('INSERT INTO command_receipts(project_id, idempotency_key, body) VALUES (?, ?, ?)')
        .run(command.projectId, command.idempotencyKey, JSON.stringify({ command, result }));
      return result;
    });
  }

  exportProject(projectId: string): ProjectExport {
    // One read snapshot, so concurrent writers cannot split history from receipts.
    return this.#transaction(() => {
      const history = this.history(projectId);
      if (!history.length) throw new StoreError('not_found', 'project_not_found');
      const receipts = this.#db.prepare('SELECT body FROM command_receipts WHERE project_id = ? ORDER BY idempotency_key')
        .all(projectId).map((row) => parse(ReceiptSchema, JSON.parse(String(row.body))));
      return ProjectExportSchema.parse({ schemaVersion: 1, projectId, history, receipts });
    }, false);
  }

  /** Restore one closed project into a completely empty database, without executing operations. */
  importProject(input: unknown): void {
    const data = parse(ProjectExportSchema, input);
    this.#transaction(() => {
      if (this.#db.prepare('SELECT 1 FROM record_history LIMIT 1').get() ||
        this.#db.prepare('SELECT 1 FROM command_receipts LIMIT 1').get()) fail('import_requires_empty_store');
      if (data.history.some((record) => record.projectId !== data.projectId)) fail('project_mismatch');
      validateHistory(data.history);
      const keys = new Set<string>();
      for (const receipt of data.receipts) {
        const command = mutation(receipt.command);
        if (command.projectId !== data.projectId) fail('project_mismatch');
        if (keys.has(command.idempotencyKey)) fail('duplicate_receipt');
        keys.add(command.idempotencyKey);
        for (const ref of receipt.result.records) {
          if (!data.history.some((record) => same(ref, record))) fail('receipt_missing_record');
        }
        for (const operation of data.history.filter((record): record is Operation =>
          record.kind === 'operation' && record.idempotencyKey === command.idempotencyKey)) {
          try { assertIdempotencyReuse(operation, command); }
          catch { fail('idempotency_conflict'); }
        }
      }
      for (const record of data.history) this.#insertRecord(record);
      for (const receipt of data.receipts) this.#db.prepare(
        'INSERT INTO command_receipts(project_id, idempotency_key, body) VALUES (?, ?, ?)')
        .run(data.projectId, receipt.command.idempotencyKey, JSON.stringify(receipt));
    });
  }

  #insertRecord(record: FactoryRecord): void {
    this.#db.prepare('INSERT INTO record_history(project_id, id, revision, kind, body) VALUES (?, ?, ?, ?, ?)')
      .run(record.projectId, record.id, record.revision, record.kind, JSON.stringify(record));
  }
  #transaction<T>(body: () => T, write = true): T {
    if (this.#transactionOpen) fail('nested_transaction');
    this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    this.#transactionOpen = true;
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally { this.#transactionOpen = false; }
  }
}
