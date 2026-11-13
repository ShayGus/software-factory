import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function verifyClaudeEvidence(events, { home, probe, pathEvidencePath }) {
  const final = events.findLast((event) => event.type === 'result');
  const calls = events.filter((event) => event.type === 'assistant').flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'tool_use');
  const results = events.filter((event) => event.type === 'user').flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'tool_result');
  const output = (call) => {
    const result = results.find((result) => result.tool_use_id === call.id && !result.is_error);
    if (!result) return '';
    return typeof result.content === 'string' ? result.content : (result.content ?? []).map((block) => block.text ?? '').join('\n');
  };
  if (!final || final.is_error || final.subtype !== 'success') {
    throw new Error('Claude session did not complete successfully');
  }
  if (!calls.some((call) => call.name === 'Skill' && call.input?.skill === 'software-factory' && output(call).includes('Launching skill: software-factory'))) {
    throw new Error('Claude did not successfully load the software-factory skill');
  }
  for (const action of ['add', 'list', 'rm']) {
    if (!calls.some((call) => call.name === 'Bash' && call.input?.command?.includes('fm-tasks-axi.sh') &&
        new RegExp(`\\b${action}\\b`).test(call.input.command) && output(call).includes(
          action === 'add' ? `ok: added ${probe} -> Queued` : action === 'rm' ? `ok: removed ${probe}` : `${probe},queued,`))) {
      throw new Error(`Claude did not successfully run the backlog ${action} check`);
    }
  }
  // The path is stdout written by a command in this session, not the model's
  // explanation or its formatting of a tool result. Require a successful tool
  // event naming this fresh artifact as well as its exact machine contents.
  if (!calls.some((call) => call.name === 'Bash' && call.input?.command?.includes('command -v tasks-axi') &&
      call.input.command.includes(pathEvidencePath) && results.some((result) => result.tool_use_id === call.id && !result.is_error)) ||
      !existsSync(pathEvidencePath) || readFileSync(pathEvidencePath, 'utf8') !== join(home, '.tools/bin/tasks-axi') + '\n') {
    throw new Error('Claude local settings did not expose the home-local tasks-axi in session command evidence');
  }
  const startup = events.filter((event) => event.type === 'system' && event.hook_event === 'SessionStart');
  if (!startup.some((event) => event.exit_code === 0 && event.stdout?.includes('The digest above is complete for this session start.')) ||
      !existsSync(join(home, 'state/.session-start-complete'))) throw new Error('Normal FirstMate session start did not complete');
  if (startup.some((event) => /(?:TANGLE:|CREW_DISPATCH: invalid|BACKEND_INVALID:|MISSING(?:_MANUAL)?:|OUTDATED:)/.test(event.stdout ?? ''))) {
    throw new Error('FirstMate startup reported an invalid home branch, configuration or missing/outdated prerequisite');
  }
}
