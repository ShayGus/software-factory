import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FirstMateTask } from '../src/index.js';

export function fakeTask(id: string, patch: Partial<FirstMateTask> = {}): FirstMateTask {
  return { id, title: id, state: 'queued', kind: 'ship', repo: 'sample', priority: null,
    created: '2026-11-11', closed: null, deps: [], hold: null, links: [], body: null,
    blocked: false, blocked_by: [], held: false, ...patch };
}
export interface FakeState {
  atomic: boolean;
  tasks: Record<string, FirstMateTask>;
  calls: { args: string[]; fmHome: string; inheritedOverride: boolean }[];
  trace: { action: string; task: FirstMateTask; ready: string[]; mappingSaved: boolean }[];
  failure?: { action: string; when: 'before' | 'after' | 'timeout' | 'wrong-receipt' | 'bad-read'; used?: boolean };
}
export function fakeTaskWrapper(directory: string, atomic: boolean, database: string) {
  const statePath = join(directory, 'fake-state.json');
  const executable = join(directory, 'fm-tasks-fake.cjs');
  const initial: FakeState = { atomic, tasks: { 'permanent-guard': fakeTask('permanent-guard', {
    kind: 'captain', hold: { reason: 'Permanent toolkit guard', kind: 'external', until: null }, held: true,
  }) }, calls: [], trace: [] };
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(executable, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const file = join(__dirname, 'fake-state.json');
const database = ${JSON.stringify(database)};
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const [action, id] = args;
s.calls.push({ args, fmHome: process.env.FM_HOME, inheritedOverride: Boolean(process.env.FM_DATA_OVERRIDE || process.env.TASKS_AXI_FILE) });
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const fail = (code, message) => { save(); process.stdout.write('error: ' + JSON.stringify(message) + '\ncode: ' + code + '\n'); process.exit(2); };
const flag = name => args[args.indexOf(name) + 1];
const projection = task => {
  task.blocked_by = task.deps.filter(d => d.type === 'blocked-by' && s.tasks[d.id] && s.tasks[d.id].state !== 'done').map(d => d.id);
  task.blocked = task.state !== 'done' && task.blocked_by.length > 0;
  task.held = Boolean(task.state !== 'done' && task.hold && !task.hold.until);
  return task;
};
const failure = s.failure && !s.failure.used && s.failure.action === action ? s.failure : undefined;
if (failure && failure.when === 'before') { failure.used = true; fail('EXTERNAL_FAILURE', 'Injected before write'); }
if (action === 'add' && id === '--help') { save(); process.stdout.write('usage: tasks-axi add <id> <title>\n' + (s.atomic ? '  --hold-reason <text>\n' : '  --blocked-by <id>\n')); process.exit(0); }
let task = s.tasks[id];
if (action === 'show') {
  if (failure && failure.when === 'bad-read') { failure.used = true; save(); process.stdout.write('incomplete result'); process.exit(0); }
  if (!task) fail('NOT_FOUND', 'Task "' + id + '" not found in this backlog');
  task = projection(task);
  const fields = { id: task.id, title: task.title, state: task.state, blocked: task.blocked ? 'yes' : 'no',
    blocked_by: task.blocked_by.join(',') || 'none', held: task.held ? 'yes' : 'no', hold_reason: task.hold?.reason ?? '-',
    hold_kind: task.hold?.kind ?? '-', hold_until: task.hold?.until ?? '-', kind: task.kind ?? 'task', repo: task.repo ?? '-',
    priority: task.priority ?? '-', created: task.created ?? '-', closed: task.closed ?? '-',
    deps: task.deps.map(d => d.type + ':' + d.id).join(',') || 'none', links: task.links.map(l => l.kind + ':' + l.url).join(',') || 'none', body: task.body ?? '' };
  save(); process.stdout.write('task:\n' + Object.entries(fields).map(([k,v]) => '  ' + k + ': ' + JSON.stringify(v)).join('\n') + '\nhelp[1]:\n  - ignored suggestion\n'); process.exit(0);
}
let already = false;
let changed = [];
if (action === 'add') {
  if (task) already = true;
  else {
    const deps = args.flatMap((a,i) => a === '--blocked-by' ? [{ type: 'blocked-by', id: args[i+1] }] : []);
    if (deps.some(d => !s.tasks[d.id])) fail('VALIDATION_ERROR', 'Missing blocker');
    task = { id, title: args[2], state: 'queued', kind: flag('--kind'), repo: flag('--repo'), priority: args.includes('--priority') ? Number(flag('--priority')) : null,
      created: '2026-11-11', closed: null, deps, hold: args.includes('--hold-reason') ? { reason: flag('--hold-reason'), kind: null, until: null } : null,
      links: [], body: flag('--body'), blocked: false, blocked_by: [], held: false };
    s.tasks[id] = task;
  }
} else {
  if (!task) fail('NOT_FOUND', 'Task missing');
  if (action === 'hold') task.hold = { reason: flag('--reason'), kind: flag('--kind'), until: null };
  else if (action === 'unhold') task.hold = null;
  else if (action === 'block') { if (!s.tasks[flag('--by')]) fail('VALIDATION_ERROR', 'Missing blocker'); if (!task.deps.some(d => d.id === flag('--by'))) task.deps.push({ type: 'blocked-by', id: flag('--by') }); else already = true; }
  else if (action === 'unblock') { const before = task.deps.length; task.deps = task.deps.filter(d => d.id !== flag('--by')); already = before === task.deps.length; }
  else if (action === 'update') { for (const key of ['title','body','repo','kind','priority']) if (args.includes('--'+key)) {
    const value = key === 'priority' ? Number(flag('--'+key)) : flag('--'+key);
    if (task[key] !== value) changed.push(key);
    task[key] = value;
  } }
  else if (id === 'exit') fail('VALIDATION_ERROR', 'Bad control arguments');
  else fail('VALIDATION_ERROR', 'Unexpected operation ' + action);
}
for (const value of Object.values(s.tasks)) projection(value);
const db = new DatabaseSync(database);
const rows = db.prepare("SELECT body FROM record_history WHERE kind = 'task_mapping'").all();
const mappingSaved = rows.some(row => JSON.parse(row.body).firstMateTaskId === task.id);
db.close();
s.trace.push({ action, task: structuredClone(task), ready: Object.values(s.tasks).filter(t => t.state === 'queued' && !t.blocked && !t.held).map(t => t.id), mappingSaved });
save();
if (failure && ['after','timeout'].includes(failure.when)) {
  failure.used = true; save();
  if (failure.when === 'timeout') { setTimeout(() => process.exit(2), 10000); return; }
  process.exit(2);
}
const receipt = { ok: true, action, ...(already ? { already: true } : {}), ...(action === 'update' ? { changed } : {}),
  ...(['block','unblock'].includes(action) ? { blocked_by: flag('--by') } : {}), task };
if (failure && failure.when === 'wrong-receipt') { failure.used = true; save(); receipt.task = { ...task, id: 'wrong-task' }; }
process.stdout.write(JSON.stringify(receipt));
`);
  chmodSync(executable, 0o755);
  const read = (): FakeState => JSON.parse(readFileSync(statePath, 'utf8'));
  const edit = (fn: (state: FakeState) => void) => { const state = read(); fn(state); writeFileSync(statePath, JSON.stringify(state)); };
  return { executable, statePath, read, edit };
}
