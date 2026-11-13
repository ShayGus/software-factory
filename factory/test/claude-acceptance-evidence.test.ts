import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function evidence(t: test.TestContext, decorated = false) {
  const home = mkdtempSync(join(tmpdir(), 'sf-claude-evidence-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'state'));
  writeFileSync(join(home, 'state/.session-start-complete'), '');
  const probe = 'sf-claude-install-check';
  const pathEvidencePath = join(home, 'resolved-path.txt');
  const path = join(home, '.tools/bin/tasks-axi');
  writeFileSync(pathEvidencePath, path + '\n');
  const events: any[] = [{ type: 'system', hook_event: 'SessionStart', exit_code: 0, stdout: 'The digest above is complete for this session start.' }];
  const tool = (id: string, name: string, input: unknown, content: string) => {
    events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] } });
  };
  tool('skill', 'Skill', { skill: 'software-factory' }, 'Launching skill: software-factory');
  tool('path', 'Bash', { command: `command -v tasks-axi > '${pathEvidencePath}'; cat '${pathEvidencePath}'` }, decorated ? `path=${path} rc=0\nMATCH` : path);
  for (const action of ['add', 'list', 'rm']) tool(action, 'Bash', { command: `bash '${home}/bin/fm-tasks-axi.sh' ${action} ${action === 'list' ? '' : probe}` },
    action === 'add' ? `ok: added ${probe} -> Queued` : action === 'rm' ? `ok: removed ${probe}` : `${probe},queued,Claude installation acceptance`);
  events.push({ type: 'result', subtype: 'success', is_error: false, result: 'SOFTWARE_FACTORY_ACCEPTANCE_OK' });
  return { events, context: { home, probe, pathEvidencePath }, tool };
}

test('acceptance accepts the actual decorated-path regression using the session command artifact', async t => {
  const { verifyClaudeEvidence } = await import(new URL('../../scripts/claude-acceptance-evidence.mjs', import.meta.url).href);
  const capturedPattern = evidence(t, true);
  assert.doesNotThrow(() => verifyClaudeEvidence(capturedPattern.events, capturedPattern.context));
});

test('bare machine path and successful tool events satisfy acceptance', async t => {
  const { verifyClaudeEvidence } = await import(new URL('../../scripts/claude-acceptance-evidence.mjs', import.meta.url).href);
  const valid = evidence(t);
  assert.doesNotThrow(() => verifyClaudeEvidence(valid.events, valid.context));
});

test('acceptance ignores final prose and refuses missing or contradictory machine evidence', async t => {
  const { verifyClaudeEvidence } = await import(new URL('../../scripts/claude-acceptance-evidence.mjs', import.meta.url).href);
  const valid = evidence(t, true);
  valid.events.at(-1).result = 'Arbitrary final wording, with no success marker.';
  assert.doesNotThrow(() => verifyClaudeEvidence(valid.events, valid.context));
  const without = (id: string) => valid.events.filter(event => !(event.type === 'user' && event.message.content[0].tool_use_id === id));
  for (const id of ['skill', 'path', 'add', 'list', 'rm']) assert.throws(() => verifyClaudeEvidence(without(id), valid.context));
  assert.throws(() => verifyClaudeEvidence(valid.events.filter(event => event.type !== 'system'), valid.context));
  writeFileSync(valid.context.pathEvidencePath, '/wrong/tasks-axi\n');
  assert.throws(() => verifyClaudeEvidence(valid.events, valid.context), /session command evidence/);
  rmSync(valid.context.pathEvidencePath);
  assert.throws(() => verifyClaudeEvidence(valid.events, valid.context), /session command evidence/);
});


test('startup diagnostics prevent claiming a complete working installation', async t => {
  const { verifyClaudeEvidence } = await import(new URL('../../scripts/claude-acceptance-evidence.mjs', import.meta.url).href);
  for (const diagnostic of ['MISSING: treehouse', 'OUTDATED: tasks-axi', 'BACKEND_INVALID: example', 'CREW_DISPATCH: invalid', 'TANGLE: wrong branch']) {
    const valid = evidence(t);
    valid.events[0].stdout += '\n' + diagnostic;
    assert.throws(() => verifyClaudeEvidence(valid.events, valid.context), /prerequisite/);
  }
});


test('a read-only competing session cannot reuse an older completion marker', async t => {
  const { verifyClaudeEvidence } = await import(new URL('../../scripts/claude-acceptance-evidence.mjs', import.meta.url).href);
  const valid = evidence(t);
  valid.events[0].stdout += '\n●  READ-ONLY SESSION - FLEET LOCK OWNERSHIP WAS NOT VERIFIED';
  assert.throws(() => verifyClaudeEvidence(valid.events, valid.context), /fleet-lock ownership/);
});


test('isolated update acceptance must prove its own startup marker', async t => {
  const { verifyClaudeEvidence } = await import(new URL('../../scripts/claude-acceptance-evidence.mjs', import.meta.url).href);
  const valid = evidence(t);
  const stateDirectory = join(valid.context.home, 'state/update-acceptance');
  mkdirSync(stateDirectory);
  assert.throws(() => verifyClaudeEvidence(valid.events, { ...valid.context, stateDirectory }), /session start/);
  writeFileSync(join(stateDirectory, '.session-start-complete'), '');
  assert.doesNotThrow(() => verifyClaudeEvidence(valid.events, { ...valid.context, stateDirectory }));
});
