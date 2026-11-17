import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('screen acceptance requires both exact ticket IDs and the exact blocking edge', async () => {
  const { screenProbeObserved } = await import(new URL('../../scripts/folder-services.mjs', import.meta.url).href);
  const payload = { meta: { readOnly: false }, beads: [
    { id: 'fm-probe', dependencies: [] },
    { id: 'fm-probe-dep', dependencies: [{ depends_on_id: 'fm-probe', type: 'blocks' }] },
  ] };
  assert.equal(screenProbeObserved(payload, 'probe', 'probe-dep'), true);
  for (const beads of [
    [payload.beads[1]],
    [payload.beads[0]],
    [payload.beads[0], { id: 'fm-probe-dep', dependencies: [] }],
    [payload.beads[0], { id: 'fm-probe-dep', dependencies: [{ depends_on_id: 'fm-probe-other', type: 'blocks' }] }],
    [payload.beads[0], { id: 'fm-probe-dep', dependencies: [{ depends_on_id: 'fm-probe', type: 'related' }] }],
  ]) assert.equal(screenProbeObserved({ ...payload, beads }, 'probe', 'probe-dep'), false);
  assert.equal(screenProbeObserved({ ...payload, meta: { readOnly: true } }, 'probe', 'probe-dep'), false);
});


test('screen acceptance survives server idle expiry across synchronous backlog calls without retrying mutations', async () => {
  const { acceptScreens } = await import(new URL('../../scripts/folder-services.mjs', import.meta.url).href);
  const home = mkdtempSync(join(tmpdir(), 'sf-screen-http-'));
  mkdirSync(join(home, 'data'));
  const tasks = join(home, 'tasks.json');
  const requests = join(home, 'requests.jsonl');
  writeFileSync(tasks, '[]');
  // A different process keeps serving and expiring sockets while the client's
  // event loop is blocked by the actual synchronous backlog command pattern.
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    const server = createServer((req, res) => {
      appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ method: req.method, path: req.url }) + '\\n');
      res.setHeader('Keep-Alive', 'timeout=600');
      let body=''; req.on('data', chunk=>{body+=chunk}); req.on('end',()=>{
        const beads=JSON.parse(readFileSync(${JSON.stringify(tasks)},'utf8'));
        const id=req.url.split('/')[5], bead=beads.find(b=>b.id===id);
        const input=body?JSON.parse(body):{};
        let result;
        if(req.url==='/api/p/factory/beads' && req.method==='POST') {
          result={...input,id:'fm-native',dependencies:[],comments:[],labels:[],status:'open'};beads.push(result);res.statusCode=201;
        } else if(req.method==='PATCH') {Object.assign(bead,input);result=bead;}
        else if(req.url.endsWith('/deps')) {bead.dependencies.push({depends_on_id:input.depends_on_id,type:input.type});result=bead;}
        else if(req.url.endsWith('/comments')) {bead.comments.push({text:input.text});result=bead;}
        else if(req.url.endsWith('/status')) {bead.status=input.status;result=bead;}
        else if(req.url==='/api/p/factory/beads') result={meta:{readOnly:false,humanActor:'Shay'},beads};
        else if(bead) result=bead;
        if(result) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}
        else {res.setHeader('Content-Type','text/html');res.end('Projects <a href="http://127.0.0.1:'+server.address().port+'/p/factory">Scotty</a>');}
        writeFileSync(${JSON.stringify(tasks)},JSON.stringify(beads));
      });
    });
    // Deliberately advertise a longer lifetime than the server actually gives
    // sockets, making the production timing window fast and repeatable.
    server.keepAliveTimeout = 30;
    server.keepAliveTimeoutBuffer = 0;
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const [out] = await once(server.stdout!, 'data');
    const origin = `http://127.0.0.1:${String(out).trim()}`;
    const calls: string[][] = [];
    const wrapper = (args: string[]) => {
      calls.push(args);
      const beads: any[] = JSON.parse(readFileSync(tasks, 'utf8'));
      const found=beads.find(b=>b.id==='fm-'+args[1]);
      if(args[0]==='add') beads.push({id:'fm-'+args[1],dependencies:args.includes('--blocked-by')?[{depends_on_id:'fm-'+args.at(-1),type:'blocks'}]:[]});
      if(args[0]==='update') found.title=args.at(-1);
      if(args[0]==='rm') beads.splice(beads.indexOf(found),1);
      writeFileSync(tasks,JSON.stringify(beads));
      const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 120)']);
      assert.equal(result.status, 0);
      return JSON.stringify(found ?? beads);
    };
    await acceptScreens(home, { uiOrigin: origin, scottyOrigin: origin }, wrapper);
    assert.deepEqual(calls.map(args => args[0]), ['add', 'add', 'show', 'show', 'update', 'rm', 'rm', 'rm']);
    assert.deepEqual(JSON.parse(readFileSync(tasks, 'utf8')), []);
    const seen: { method: string; path: string }[] = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(seen.filter(req => req.method !== 'GET').map(req => req.method), ['POST', 'PATCH', 'POST', 'POST', 'POST']);
    assert.equal(seen.filter(req => req.path === '/p/factory').length, 1);
  } finally {
    const exited = once(server, 'exit'); server.kill(); await exited;
    rmSync(home, { recursive: true, force: true });
  }
});
