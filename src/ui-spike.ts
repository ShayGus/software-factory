import { z } from 'zod';
import { CommandEnvelopeSchema } from './commands.js';
import { IdSchema } from './primitives.js';
import { manageExecutionTask, type TaskAdapterOptions } from './tasks.js';
import { ProjectStore, StoreError } from './store.js';

/** Bounded BUILD-05 routing experiment, not the BUILD-12–14 HTTP service.
 * The store, command vocabulary and execution adapter are the existing ones.
 * Product edits exercise their contracts; their final editors remain provisional.
 */
export const scottyFields = {
  title: { owner: 'FirstMate/tasks-axi', route: 'update' },
  status: { owner: 'FirstMate/tasks-axi', route: 'lifecycle' },
  priority: { owner: 'FirstMate/tasks-axi', route: 'set_priority' },
  dependencies: { owner: 'FirstMate/tasks-axi', route: 'edit_dependencies' },
  notes: { owner: 'toolkit', route: 'capture_consolidate_learning' },
  description: { owner: 'FirstMate/tasks-axi', route: 'update' },
  labels: { owner: 'FirstMate/tasks-axi', route: 'read_only' },
  defer: { owner: 'FirstMate/tasks-axi', route: 'pause_resume' },
  feature: { owner: 'toolkit', route: 'record_decision_suggestion' },
  criteria: { owner: 'toolkit', route: 'record_decision_suggestion' },
  decisions: { owner: 'toolkit', route: 'record_decision_suggestion' },
  originalRequest: { owner: 'toolkit', route: 'read_only' },
} as const;

const EditSchema = z.strictObject({ projectId: IdSchema, id: IdSchema,
  field: z.enum(Object.keys(scottyFields) as [keyof typeof scottyFields, ...(keyof typeof scottyFields)[]]),
  value: z.unknown() });

export interface SpikeResponse { status: number; body: unknown }
export class UiSpikeApi {
  constructor(readonly store: ProjectStore, readonly tasks: TaskAdapterOptions) {}

  /** These relative links are also rendered in the execution task bodies.
   * No write accepts a Beads physical ID or matches by title.
   */
  handle(method: string, path: string, body?: unknown): SpikeResponse {
    try {
      const url = new URL(path, 'http://spike.invalid');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (method === 'GET' && url.pathname === '/canonical') {
        return { status: 200, body: { spike: true, fields: scottyFields, method: 'POST', path: '/canonical',
          contract: 'CommandEnvelopeSchema', lifecycle: 'Open FirstMate lifecycle; this stub only exposes task pause/resume/cancel.',
          adoption: 'Provisional; verify actual editor mutations in BUILD-12–14 and BUILD-17.' } };
      }
      if (method === 'GET' && parts.length === 4 && parts[0] === 'projects' && parts[2] === 'records') {
        const raw = url.searchParams.get('revision');
        const revision = raw === null ? undefined : z.coerce.number().int().positive().parse(raw);
        const record = this.store.get(parts[1]!, parts[3]!, revision);
        if (!record) throw new StoreError('not_found', 'record_not_found');
        return { status: 200, body: { record, readOnly: true } };
      }
      if (method === 'POST' && url.pathname === '/scotty-edit') {
        const edit = EditSchema.parse(body);
        const record = this.store.get(edit.projectId, edit.id);
        if (!record) throw new StoreError('not_found', 'record_not_found');
        // Refuse projection edits even when the browser enables its native editor.
        return { status: 409, body: { error: 'canonical_operation_required',
          ...scottyFields[edit.field],
          record: `/projects/${encodeURIComponent(edit.projectId)}/records/${encodeURIComponent(edit.id)}`,
          operation: scottyFields[edit.field].route === 'read_only' ? null : '/canonical',
          expectedRevision: record.revision } };
      }
      if (method === 'POST' && url.pathname === '/canonical') {
        const command = CommandEnvelopeSchema.parse(body);
        if (command.command === 'map_manage_execution_task') {
          const result = manageExecutionTask(this.store, command, this.tasks);
          return { status: result.operation.state === 'succeeded' ? 200 : 202, body: result };
        }
        if (command.command === 'record_decision_suggestion') {
          // This stub tests typed, revision-checked feature/criterion and decision
          // round trips. No arbitrary record import, lifecycle, or request rewrite.
          if (command.payload.project) throw new StoreError('validation', 'project_edit_not_exposed');
          if (command.payload.decision.id !== command.targetId &&
            !command.payload.intakeRecords?.some((record) => record.id === command.targetId)) {
            throw new StoreError('validation', 'command_must_target_written_record');
          }
          const result = this.store.mutate(command, () => [command.payload.decision, ...(command.payload.intakeRecords ?? [])]);
          return { status: 200, body: result };
        }
        if (command.command === 'capture_consolidate_learning' && command.payload.action === 'capture') {
          const observation = command.payload.observation;
          if (observation.id !== command.targetId) throw new StoreError('validation', 'command_must_target_written_record');
          const result = this.store.mutate(command, () => [observation]);
          return { status: 200, body: result };
        }
        throw new StoreError('validation', 'operation_not_exposed_by_spike');
      }
      return { status: 404, body: { error: 'spike_route_not_found' } };
    } catch (error) {
      if (error instanceof StoreError) return { status: error.detail.code === 'conflict' ? 409 :
        error.detail.code === 'not_found' ? 404 : 400, body: { error: error.detail } };
      return { status: 400, body: { error: { code: 'validation',
        message: error instanceof Error ? error.message : String(error) } } };
    }
  }
}
