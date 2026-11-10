import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, TextSchema } from './primitives.js';
import { captureRequest, stableId } from './intake.js';
import { ProjectStore } from './store.js';

// Harness fields beyond the ones consumed here are allowed. Prompt text is never
// trimmed or interpreted; transcript_path is provenance, not a file to scrape.
export const UserPromptSubmitSchema = z.object({
  hook_event_name: z.literal('UserPromptSubmit'), session_id: IdSchema,
  transcript_path: TextSchema, prompt: TextSchema, prompt_id: IdSchema.optional(),
});
export function captureChatPrompt(store: ProjectStore, projectId: string, input: unknown, clientRequestId?: string) {
  const hook = UserPromptSubmitSchema.parse(input);
  return captureRequest(store, {
    projectId, clientRequestId: clientRequestId ?? (hook.prompt_id ?
      stableId('chat-prompt', hook.session_id, hook.prompt_id) : randomUUID()),
    originalText: hook.prompt, channel: 'chat', attachments: [],
    source: { uri: `claude-code:session/${encodeURIComponent(hook.session_id)}?transcript=${encodeURIComponent(hook.transcript_path)}` },
  });
}
