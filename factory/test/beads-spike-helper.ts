import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A bd protocol double only. It never loads Beads or opens a Dolt database.
 * The real tasks-axi main backend still encodes/decodes its SQL seam and the
 * real BUILD-08 adapter calls its real command handlers in separate processes.
 */
export function beadsSpikeHarness(directory: string) {
  const compiled = join(directory, 'tasks-axi-main');
  const prepareUrl = new URL('../../scripts/prepare-spike-tasks-axi.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { prepareTasksAxi } from ${JSON.stringify(prepareUrl)}; prepareTasksAxi(process.argv[1]);`, compiled]);
  const workspace = join(directory, '.beads');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'metadata.json'), JSON.stringify({ dolt_mode: 'server', dolt_database: 'sf_spike_fake',
    dolt_server_socket: join(directory, 'fake.sock'), dolt_server_user: 'root' }));
  const statePath = join(directory, 'fake-bd.json');
  writeFileSync(statePath, JSON.stringify({ rows: {}, calls: [], serial: 0 }));
  const binary = join(directory, 'fake-bd.cjs');
  writeFileSync(binary, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
assert.equal(process.env.BEADS_DIR, path.join(__dirname, '.beads'));
assert.equal(process.env.BEADS_DOLT_AUTO_START, '0');
const file = path.join(__dirname, 'fake-bd.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const reply = value => { save(); process.stdout.write(JSON.stringify(value)); };
if (args[0] === 'version') { save(); process.stdout.write('bd version 1.1.0 (8e4e59d39: HEAD@8e4e59d39f34)'); process.exit(0); }
assert.equal(args[0], 'sql', 'Tests may only execute the fake SQL seam');
const sql = args[1];
if (sql === 'SELECT DOLT_VERSION() AS version') reply([{version:'2.7.2'}]);
else if (sql.startsWith('SELECT create_stmt')) reply(state.routine ? [{create_stmt:state.routine}] : []);
else if (sql.startsWith('CREATE PROCEDURE')) { state.routine=sql; reply([]); }
else if (sql.startsWith('CREATE TABLE') || sql.startsWith('INSERT INTO dolt_ignore')) reply([]);
else if (sql.startsWith('SELECT i.id')) {
  const match = sql.match(/ WHERE i.id=CONVERT\(X'([0-9a-f]*)' USING utf8mb4\)$/);
  reply(match ? [state.rows[Buffer.from(match[1], 'hex').toString()]].filter(Boolean) : Object.values(state.rows));
} else if (sql.startsWith('CALL tasks_axi_apply_v1(')) {
  const match = sql.match(/^CALL tasks_axi_apply_v1\(CONVERT\(X'([0-9a-f]*)' USING utf8mb4\)\)$/);
  assert.ok(match, 'Unexpected payload shape');
  const payload = JSON.parse(Buffer.from(match[1], 'hex').toString());
  const staged = structuredClone(state.rows);
  for (const entry of payload.entries) {
    const previous = staged[entry.id];
    if (entry.mode === 'create') assert.equal(previous, undefined);
    else assert.equal(previous.token, entry.token, 'Stale writer');
    const task = entry.namespace.task;
    staged[entry.id] = { id: entry.id, title: task.title, description: task.body ?? '',
      status: entry.status, priority: task.priority ?? 2,
      metadata: { ...(previous?.metadata ?? {}), tasks_axi: entry.namespace },
      edges: entry.edges, token: String(++state.serial) };
  }
  state.rows=staged;
  if (state.loseReply) { delete state.loseReply; save(); process.stderr.write('injected lost response'); process.exit(2); }
  reply([]);
} else throw new Error('Unmodelled SQL in fake bd: ' + sql.slice(0,80));
`);
  chmodSync(binary, 0o755);
  writeFileSync(join(directory, '.tasks.toml'), `backend = "beads"\n[beads]\npath = ${JSON.stringify(workspace)}\nbinary = ${JSON.stringify(binary)}\nprefix = "fm"\ndatabase = "sf_spike_fake"\nserver_socket = ${JSON.stringify(join(directory, 'fake.sock'))}\nserver_user = "root"\ntimeout_ms = 5000\ndone_keep = 10\n`);
  const executable = join(directory, 'scratch-tasks.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASKS_AXI_|BEADS_|BD_)/.test(k)));
// Isolate tasks-axi's optional user config lookup in this disposable test home.
env.HOME = __dirname;
const r = spawnSync(process.execPath, [${JSON.stringify(join(compiled, 'bin/tasks-axi.js'))}, ...process.argv.slice(2)], {cwd: __dirname, env, stdio:'inherit'});
process.exit(r.status ?? 1);
`);
  chmodSync(executable, 0o755);
  const read = () => JSON.parse(readFileSync(statePath, 'utf8')) as {
    rows: Record<string, { title: string; description: string; status: string; priority: number;
      edges: { id: string; type: string }[]; metadata: { tasks_axi: { task: { hold?: unknown } } } }>;
    calls: string[][]; loseReply?: boolean;
  };
  return { executable, read, loseReply: () => { const state = read(); state.loseReply = true; writeFileSync(statePath, JSON.stringify(state)); } };
}
