import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { StoreError } from './store.js';

// Deliberately recognize only the command we document and can attribute to this
// database/project. An arbitrary shell wrapper cannot prove automatic capture.
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function chatHookCommand(nodeExecutable: string, cliPath: string, database: string, projectId: string): string {
  for (const path of [nodeExecutable, cliPath, database]) if (!isAbsolute(path)) {
    throw new StoreError('validation', 'hook_paths_must_be_absolute');
  }
  return [nodeExecutable, cliPath, 'chat-hook', '--db', database, '--project', projectId].map(shellQuote).join(' ');
}
export function chatHookSettings(command: string) {
  return { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] } };
}
const SettingsSchema = z.object({
  disableAllHooks: z.boolean().optional(),
  hooks: z.object({ UserPromptSubmit: z.array(z.object({
    matcher: z.string().optional(),
    hooks: z.array(z.object({ type: z.string(), command: z.string().optional(),
      async: z.boolean().optional(), if: z.string().optional() })),
  })).optional() }).optional(),
});
export function captureChannelCoverage(expectedCommand: string, settingsPaths: string[] = []) {
  const facts = settingsPaths.map((path) => {
    try {
      const result = SettingsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!result.success) return { path, configured: false, disabled: false, error: 'invalid_hook_settings' };
      const settings = result.data;
      return { path, disabled: settings.disableAllHooks === true, error: null,
        configured: settings.hooks?.UserPromptSubmit?.some((group) =>
          // UserPromptSubmit has no matcher. Only the documented unconditional form is claimed.
          group.matcher === undefined && group.hooks.some((hook) => hook.type === 'command' &&
            hook.command === expectedCommand && hook.async !== true && hook.if === undefined)) ?? false };
    } catch (error) { return { path, configured: false, disabled: false, error: String(error) }; }
  });
  const automatic = facts.some((fact) => fact.configured) && !facts.some((fact) => fact.disabled || fact.error);
  return { basis: 'supplied configuration files only; runtime execution and other settings scopes are not verified', facts,
    channels: [
      { channel: 'cli', capture: 'manual', reason: 'The capture command must be invoked explicitly.' },
      { channel: 'chat', capture: automatic ? 'automatic' : 'manual',
        reason: automatic ? 'An enabled unconditional UserPromptSubmit command matches this database and project.' :
          'No verified enabled hook in the supplied settings; use the capture command with --channel chat.' },
      { channel: 'firstmate_inbox', capture: 'manual',
        reason: 'No inbound inbox importer is implemented. Capture the existing note text and source explicitly; delivery alone does not import inbox notes.' },
    ],
  };
}
