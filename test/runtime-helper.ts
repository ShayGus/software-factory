import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function fakeRuntime(directory: string, ids: string[] = []) {
  const statePath = join(directory, 'runtime.json');
  const executable = join(directory, 'snapshot.cjs');
  writeFileSync(statePath, JSON.stringify(ids.map((id) => ({ id, spawn_gen: 'generation-1', project: directory,
    endpoint: { target: 'fake-terminal', exists: true, agent_alive: 'alive', status: 'alive', freshness: 'fresh', observed_at: '' },
    current_state: { state: 'active', freshness: 'fresh', observed_at: '' } }))));
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const home = ${JSON.stringify(directory)};
const now = new Date().toISOString();
const tasks = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
for (const task of tasks) { task.current_state.observed_at = now; if(task.endpoint) { task.endpoint.observed_at = now; task.endpoint.target ??= 'fake-terminal'; task.endpoint.status = task.endpoint.exists === false ? 'absent' : ['alive','dead'].includes(task.endpoint.agent_alive) ? task.endpoint.agent_alive : 'unknown'; } }
fs.appendFileSync(home + '/runtime-reads', 'read\\n');
process.stdout.write(JSON.stringify({schema:'fm-fleet-snapshot.v1', generated:now, fm_home:home,
 backlog:{present:true,records:tasks.map(t=>({id:t.id,state:t.current_state.state==='done'?'done':'in_flight'}))},tasks}));
`, { mode: 0o755 });
  const read = (): { id: string; spawn_gen: string | null; project: string; endpoint?: { exists: boolean; agent_alive: 'alive' | 'dead' | 'unknown' | 'not_checked'; target?: string | null; status?: string; freshness: string; observed_at: string }; current_state: { state: string; freshness: string; observed_at: string } }[] => JSON.parse(readFileSync(statePath, 'utf8'));
  return { executable, statePath, read, save: (value: ReturnType<typeof read>) => writeFileSync(statePath, JSON.stringify(value)),
    trace: (note: string) => appendFileSync(join(directory, 'runtime-reads'), `${note}\n`) };
}
