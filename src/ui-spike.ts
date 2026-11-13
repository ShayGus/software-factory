import { BundleRefsSchema } from './ui-bundle.js';
import { z } from 'zod';
import { CommandEnvelopeSchema } from './commands.js';
import { IdSchema } from './primitives.js';
import { type TaskAdapterOptions } from './tasks.js';
import { applyCommand } from './application.js';
import { projectView, featureView, type UiOptions } from './ui-state.js';
import { renderOverview, renderFeature, renderRecord, renderWork, renderDecisions, renderLearning } from './ui-pages.js';
import { ProjectStore, StoreError } from './store.js';

/** BUILD-05 field ownership retained by the focused toolkit editors. */
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

export interface SpikeResponse { status: number; body: unknown; contentType?: string }
export class ToolkitApi {
  constructor(readonly store: ProjectStore, readonly tasks?: TaskAdapterOptions, readonly options: UiOptions = { projectId: 'project-1' }) {}

  /** These relative links are also rendered in the execution task bodies.
   * No write accepts a Beads physical ID or matches by title.
   */
  handle(method: string, path: string, body?: unknown): SpikeResponse {
    try {
      const url = new URL(path, 'http://toolkit.invalid');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (method === 'GET' && url.pathname === '/canonical') {
        return { status: 200, body: { fields: scottyFields, method: 'POST', path: '/canonical',
          contract: 'CommandEnvelopeSchema', operations: ['record_decision_suggestion', 'design_plan_feature', 'map_manage_execution_task', 'capture_consolidate_learning (capture only)'],
          lifecycle: 'Existing FirstMate lifecycle; toolkit task edits use BUILD-08.' } };
      }
      if (method === 'GET' && url.pathname === '/') {
        return { status: 200, body: renderOverview(projectView(this.store, this.options)), contentType: 'text/html; charset=utf-8' };
      }
      if (method === 'GET' && parts[0] === 'projects' && parts[1]) {
        const options = { ...this.options, projectId: parts[1] };
        if (parts.length === 2) return { status: 200, body: renderOverview(projectView(this.store, options)), contentType: 'text/html; charset=utf-8' };
        if (parts.length === 3 && (parts[2] === 'decisions' || parts[2] === 'learning')) {
          const view = projectView(this.store, options);
          return { status: 200, body: parts[2] === 'decisions' ? renderDecisions(view) : renderLearning(view), contentType: 'text/html; charset=utf-8' };
        }
        if (parts.length === 3 && parts[2] === 'overview') return { status: 200, body: projectView(this.store, options) };
        if ((parts.length === 3 && ['work', 'dependencies'].includes(parts[2]!)) || (parts.length === 4 && parts[2] === 'work')) {
          return { status: 200, body: renderWork(projectView(this.store, options), parts[2] === 'dependencies', parts[3]), contentType: 'text/html; charset=utf-8' };
        }
        if (parts.length === 4 && parts[2] === 'features') {
          const raw = url.searchParams.get('bundle');
          const view = projectView(this.store, raw === null ? options : { ...options, bundle: { featureId: parts[3]!, refs: BundleRefsSchema.parse(JSON.parse(raw)) } });
          return { status: 200, body: renderFeature(view, featureView(view, parts[3]!)), contentType: 'text/html; charset=utf-8' };
        }
        if (parts.length === 4 && parts[2] === 'inspect') {
          const raw = url.searchParams.get('revision');
          const revision = raw === null ? undefined : z.coerce.number().int().positive().parse(raw);
          const record = this.store.get(parts[1], parts[3]!, revision);
          if (!record) throw new StoreError('not_found', 'record_not_found');
          return { status: 200, body: renderRecord(projectView(this.store, options), record), contentType: 'text/html; charset=utf-8' };
        }
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
        const result = applyCommand(this.store, command, this.tasks);
        if ('operation' in result && ['unknown', 'failed'].includes(result.operation.state)) {
          return { status: result.operation.state === 'unknown' ? 202 : 502, body: { ...result, error: {
            code: result.operation.state === 'unknown' ? 'unknown_outcome' : 'external_failure',
            message: 'Inspect the saved operation before another task edit.', paths: [],
            externalReferences: result.operation.externalReferences,
          } } };
        }
        return { status: 'operation' in result && result.operation.state !== 'succeeded' ? 202 : 200, body: result };
      }
      throw new StoreError('not_found', 'route_not_found');
    } catch (error) {
      if (error instanceof StoreError) return { status: error.detail.code === 'conflict' ? 409 :
        error.detail.code === 'not_found' ? 404 : 400, body: { error: error.detail } };
      return { status: 400, body: { error: { code: 'validation',
        message: error instanceof Error ? error.message : String(error), paths: error instanceof z.ZodError ? error.issues.map((issue) => issue.path.join('.')) : [], externalReferences: [] } } };
    }
  }
}

// Compatibility name for the BUILD-05 fixture and opt-in integration harness.
export { ToolkitApi as UiSpikeApi };
