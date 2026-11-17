import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../../../services/', import.meta.url));
const legacy = fileURLToPath(new URL('../../scripts/setup-firstmate-home.mjs', import.meta.url));
const linux = { skip: process.platform !== 'linux' && 'Installer requires Linux Unix sockets; portable parsing/help is tested separately' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sf-install-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(home, 'factory/scripts'), { recursive: true });
  mkdirSync(bin);
  // Container-conflict refusal must not depend on tmux being installed on CI.
  // This preflight only checks executability and never invokes the placeholder.
  for (const name of ['tmux', 'gh', 'treehouse', 'no-mistakes', 'gh-axi', 'chrome-devtools-axi', 'quota-axi']) symlinkSync(process.execPath, join(bin, name));
  cpSync(source, join(home, 'services'), { recursive: true });
  for (const name of ['home-acceptance.mjs', 'claude-acceptance-evidence.mjs', 'folder-services.mjs', 'scotty-spike-reader.mjs', 'scotty-service.mjs', 'tailnet.mjs']) {
    cpSync(join(dirname(legacy), name), join(home, 'factory/scripts', name));
  }
  writeFileSync(join(home, '.gitignore'), 'config/\nstate/\ndata/\nbeads/\n.tools/\n.claude/settings.local.json\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', home, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('add', '.'); git('commit', '-m', 'Fixture');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const log = join(root, 'docker.jsonl');
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='info') console.log('27.0');
else if(a[0]==='container'&&a[1]==='ls') console.log(process.env.SF_TEST_CONTAINER||'');
else {console.error('Unexpected Docker mutation');process.exitCode=99;}
`, { mode: 0o755 });
  const invoke = (args: string[] = [], command = 'setup', container = '') => spawnSync(process.execPath, [join(home, `services/${command}.mjs`), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SF_TEST_CONTAINER: container }
  });
  const marker = join(home, 'config/software-factory.install.json');
  const installed = () => { mkdirSync(join(home, 'config')); mkdirSync(join(home, 'state')); writeFileSync(marker, '{}\n'); };
  return { root, home, bin, log, invoke, git, marker, installed, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('monorepo and compatibility help need no Docker or authenticated clients', () => {
  for (const entry of [join(source, 'setup.mjs'), join(source, 'update.mjs'), legacy]) {
    const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', env: { PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
});

test('invalid ports, duplicates and obsolete external-source arguments fail before resources', () => {
  for (const args of [['--ui-port', '65536'], ['--scotty-port', '0'], ['--docker', 'docker', '--docker', 'auto'], ['--fork-source', '/unused']]) {
    const result = spawnSync(process.execPath, [join(source, 'setup.mjs'), ...args], { encoding: 'utf8', env: { PATH: '' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid|duplicate|Unknown/);
  }
});

test('dirty clone is refused before Docker and private allocation', linux, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, 'unfinished'), 'keep');
    const result = f.invoke();
    assert.match(result.stderr, /Refusing dirty/);
    assert.equal(existsSync(f.log), false);
    assert.equal(existsSync(join(f.home, 'beads')), false);
    assert.equal(readFileSync(join(f.home, 'unfinished'), 'utf8'), 'keep');
  } finally { f.close(); }
});

test('existing factory resources without a transaction are never overwritten', linux, () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, 'beads')); writeFileSync(join(f.home, 'beads/keep'), 'original');
    const result = f.invoke();
    assert.match(result.stderr, /Refusing existing factory path without a setup checkpoint: beads/);
    assert.equal(readFileSync(join(f.home, 'beads/keep'), 'utf8'), 'original');
    assert.equal(existsSync(f.marker), false);
  } finally { f.close(); }
});

test('unrecognized completion marker cannot authorize modifying resources', linux, () => {
  const f = fixture();
  try {
    f.installed(); const before = readFileSync(f.marker, 'utf8');
    const result = f.invoke();
    assert.match(result.stderr, /Invalid\/incomplete installation record/);
    assert.equal(readFileSync(f.marker, 'utf8'), before);
    assert.equal(existsSync(join(f.home, 'beads')), false);
  } finally { f.close(); }
});

test('an existing home-owned-name container is refused before downloads or allocation', linux, () => {
  const f = fixture();
  try {
    const id = createHash('sha256').update(f.home).digest('hex').slice(0, 12);
    // Client overrides need only be executable for this preflight refusal.
    const result = f.invoke(['--claude', process.execPath, '--codex', process.execPath], 'setup', `sf-${id}-dolt`);
    assert.match(result.stderr, /Refusing existing container:/);
    assert.equal(existsSync(join(f.home, 'beads')), false);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(args => args[0] === 'info' || args[0] === 'container'));
  } finally { f.close(); }
});

test('update refuses unfinished workers before Docker or source change', linux, () => {
  const f = fixture();
  try {
    f.installed(); writeFileSync(join(f.home, 'state/build.meta'), 'task');
    const before = f.git('rev-parse', 'HEAD');
    const result = f.invoke([], 'update');
    assert.match(result.stderr, /Refusing unfinished workers/);
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    assert.equal(existsSync(f.log), false);
  } finally { f.close(); }
});

test('update refuses unlanded branches and invalid pending transactions without discarding either', linux, () => {
  const f = fixture();
  try {
    f.installed(); f.git('checkout', '-b', 'feature');
    writeFileSync(join(f.home, 'change'), 'unlanded'); f.git('add', 'change'); f.git('commit', '-m', 'Unlanded');
    const branch = f.git('rev-parse', 'HEAD'); f.git('checkout', 'main');
    assert.match(f.invoke([], 'update').stderr, /Refusing unlanded local branches: feature/);
    assert.equal(f.git('rev-parse', 'feature'), branch);
    f.git('branch', '-D', 'feature');
    writeFileSync(join(f.home, 'state/software-factory.update.pending.json'), '{}');
    assert.match(f.invoke([], 'update').stderr, /Invalid factory update transaction/);
    assert.equal(existsSync(f.log), false);
  } finally { f.close(); }
});

test('update resumes a valid pending transaction after a committed fast-forward fix', linux, () => {
  const f = fixture();
  try {
    f.installed();
    const before = f.git('rev-parse', 'HEAD');
    f.git('commit', '--allow-empty', '-m', 'Failed update target');
    const target = f.git('rev-parse', 'HEAD');
    const pending = join(f.home, 'state/software-factory.update.pending.json');
    const transaction = { home: f.home, before, target, local: false, started: Date.now() };
    writeFileSync(pending, JSON.stringify(transaction));
    f.git('commit', '--allow-empty', '-m', 'Approved fix');
    const result = f.invoke([], 'update');
    // The deliberately invalid completion record stops verify, after all resume
    // guards passed but before builds or mutations can run in this fixture.
    assert.match(result.stderr, /Invalid\/incomplete installation record/);
    assert.deepEqual(JSON.parse(readFileSync(pending, 'utf8')), transaction);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { f.close(); }
});

test('pending update refuses a foreign home or divergent target before Docker', linux, () => {
  const f = fixture();
  try {
    f.installed();
    const before = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-b', 'other');
    f.git('commit', '--allow-empty', '-m', 'Other lineage');
    const target = f.git('rev-parse', 'HEAD');
    f.git('checkout', 'main');
    f.git('branch', '-D', 'other');
    const pending = join(f.home, 'state/software-factory.update.pending.json');
    for (const home of ['/foreign/home', f.home]) {
      const transaction = { home, before, target, local: false, started: Date.now() };
      writeFileSync(pending, JSON.stringify(transaction));
      const result = f.invoke([], 'update');
      assert.equal(result.status, 1);
      assert.match(result.stderr, home === f.home ? /transaction\/source mismatch/ : /Invalid factory update transaction/);
      assert.equal(existsSync(f.log), false);
      assert.deepEqual(JSON.parse(readFileSync(pending, 'utf8')), transaction);
    }
  } finally { f.close(); }
});

test('setup and update refuse a concurrent installer before Docker or pending-state changes', linux, async () => {
  const f = fixture();
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    f.installed();
    const pending = join(f.home, 'state/software-factory.update.pending.json');
    writeFileSync(pending, '{}');
    holder = spawn('flock', ['--no-fork', join(f.home, 'state/software-factory.setup.lock'), 'bash', '-c', 'printf ready; exec sleep 60']);
    await once(holder.stdout!, 'data');
    for (const command of ['setup', 'update']) {
      const result = f.invoke([], command);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Another setup(?:\/update)? is running/);
      assert.equal(existsSync(f.log), false);
      assert.equal(readFileSync(pending, 'utf8'), '{}');
    }
  } finally {
    if (holder && holder.exitCode === null) { const exited = once(holder, 'exit'); holder.kill(); await exited; }
    f.close();
  }
});

test('executable install replaces a busy binary atomically and skips identical bytes', linux, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-busy-'));
  const source = join(root, 'download');
  const destination = join(root, 'bd');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const { installExecutable } = await import(new URL('../../../services/install-executable.mjs', import.meta.url).href);
    copyFileSync('/bin/sleep', source);
    installExecutable(source, destination);
    assert.equal(statSync(destination).mode & 0o777, 0o755);
    child = spawn(destination, ['60']);
    await once(child, 'spawn');
    // Reproduce the old installer failure on a real kernel-executed ELF file.
    assert.throws(() => copyFileSync(source, destination), { code: 'ETXTBSY' });
    const inode = statSync(destination).ino;
    chmodSync(destination, 0o700);
    installExecutable(source, destination);
    assert.equal(statSync(destination).ino, inode);
    assert.equal(statSync(destination).mode & 0o777, 0o755);
    // ELF executables tolerate trailing data, so this remains executable while
    // ensuring replacement is tested as well as the identical-byte fast path.
    writeFileSync(source, Buffer.concat([readFileSync(source), Buffer.from('new version')]));
    installExecutable(source, destination);
    assert.notEqual(statSync(destination).ino, inode);
    assert.deepEqual(readFileSync(destination), readFileSync(source));
    assert.equal(spawnSync(destination, ['0']).status, 0);
    assert.equal(child.exitCode, null);
    assert.equal(statSync(destination).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(root).sort(), ['bd', 'download']);
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('executable install refuses an unreadable destination without leaving temporary files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-install-failure-'));
  try {
    const { installExecutable } = await import(new URL('../../../services/install-executable.mjs', import.meta.url).href);
    const source = join(root, 'download');
    const destination = join(root, 'bd');
    writeFileSync(source, 'new version');
    mkdirSync(destination);
    assert.throws(() => installExecutable(source, destination), { code: 'EISDIR' });
    assert.equal(statSync(destination).isDirectory(), true);
    assert.deepEqual(readdirSync(root).sort(), ['bd', 'download']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('an existing checkout retains its home data and does not need origin/HEAD', linux, () => {
  const f = fixture();
  try {
    f.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    mkdirSync(join(f.home, 'config')); mkdirSync(join(f.home, 'data'));
    writeFileSync(join(f.home, 'config/crew-harness'), 'claude\n');
    writeFileSync(join(f.home, 'data/preferences'), 'retained');
    f.git('config', 'remote.origin.url', '/existing/remote');
    const id = createHash('sha256').update(f.home).digest('hex').slice(0, 12);
    const result = f.invoke(['--claude', process.execPath, '--codex', process.execPath], 'setup', `sf-${id}-dolt`);
    assert.match(result.stderr, /Refusing existing container:/);
    assert.equal(readFileSync(join(f.home, 'config/crew-harness'), 'utf8'), 'claude\n');
    assert.equal(readFileSync(join(f.home, 'data/preferences'), 'utf8'), 'retained');
    assert.equal(f.git('config', 'remote.origin.url'), '/existing/remote');
    assert.equal(existsSync(f.marker), false);
  } finally { f.close(); }
});

test('resume refuses a transaction from a different source without changing it', linux, () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, 'state'));
    const pending = join(f.home, 'state/software-factory.setup.pending.json');
    const original = JSON.stringify({ version: 1, home: f.home, commit: 'different' });
    writeFileSync(pending, original);
    const result = f.invoke();
    assert.match(result.stderr, /checkpoint belongs to a different home or source commit/);
    assert.equal(readFileSync(pending, 'utf8'), original);
    assert.equal(existsSync(join(f.home, 'beads')), false);
  } finally { f.close(); }
});

test('an owned partial setup reuses its built images and inspects existing containers', linux, () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, 'state'));
    const id = createHash('sha256').update(f.home).digest('hex').slice(0, 12);
    const container = `sf-${id}-dolt`;
    mkdirSync(join(f.home, 'config')); mkdirSync(join(f.home, 'data'));
    const checkpoint = { version: 1, home: f.home, commit: f.git('rev-parse', 'HEAD'),
      args: { home: f.home, container }, images: { dolt: 'owned-image', runtime: 'owned-runtime' } };
    const pending = join(f.home, 'state/software-factory.setup.pending.json');
    writeFileSync(pending, JSON.stringify(checkpoint));
    const result = f.invoke(['--claude', process.execPath, '--codex', process.execPath], 'setup', container);
    assert.match(result.stdout, /Resuming with the already-built service images/);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.some(args => args[0] === 'inspect'));
    assert.ok(calls.every(args => ['info', 'container', 'inspect'].includes(args[0])));
    assert.deepEqual(JSON.parse(readFileSync(pending, 'utf8')), checkpoint);
    assert.equal(existsSync(f.marker), false);
  } finally { f.close(); }
});

test('checkpoint replacement tolerates a temporary file left by an interrupted save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-checkpoint-'));
  try {
    const path = join(root, 'checkpoint.json');
    writeFileSync(path, '{"previous":true}');
    writeFileSync(path + '.tmp', 'interrupted write');
    const { writeJson } = await import(new URL('../../../services/setup.mjs', import.meta.url).href);
    writeJson(path, { resumed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { resumed: true });
    assert.equal(readFileSync(path + '.tmp', 'utf8'), 'interrupted write');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// Exercise the actual rebuild and Docker command boundary. Only expensive image
// compilation and Claude acceptance are substituted; full scratch proof uses both.
async function updateFixture(sameImage = false) {
  const f = fixture();
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => res.end('{}'));
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [out] = await once(server.stdout!, 'data');
  const port = Number(String(out).trim());
  const oldImage = 'sha256:' + '1'.repeat(64);
  const newImage = sameImage ? oldImage : 'sha256:' + '2'.repeat(64);
  const doltImage = 'sha256:' + '3'.repeat(64);
  const pins = JSON.parse(readFileSync(join(f.home, 'services/dependencies.json'), 'utf8'));
  const services = { names: { scotty: 'test-scotty', ui: 'test-ui' }, uiPort: port, scottyPort: port,
    uiOrigin: `http://127.0.0.1:${port}`, scottyOrigin: `http://127.0.0.1:${port}`, runtimeImage: oldImage };
  const installed = { version: 2, state: 'complete', home: f.home, commit: f.git('rev-parse', 'HEAD'),
    args: { home: f.home, container: 'test', factoryRoot: join(f.home, 'factory'), database: 'test' },
    services, images: { runtime: oldImage, dolt: doltImage }, pins, executables: { claude: process.execPath } };
  for (const path of ['beads/bin/bd', 'beads/workspace/.beads/metadata.json', '.tools/bin/tasks-axi', 'factory/dist/src/index.js',
    'tools/tasks-axi/dist/bin/tasks-axi.js', 'config/software-factory.agents.json', 'config/software-factory.projects.json',
    'data/software-factory.acceptance.jsonl', '.claude/settings.local.json']) {
    mkdirSync(dirname(join(f.home, path)), { recursive: true }); writeFileSync(join(f.home, path), '{}');
  }
  mkdirSync(join(f.home, 'state'));
  mkdirSync(join(f.home, 'factory/skills/software-factory'), { recursive: true });
  mkdirSync(join(f.home, '.claude/skills'), { recursive: true });
  symlinkSync(join(f.home, 'factory/skills/software-factory'), join(f.home, '.claude/skills/software-factory'));
  writeFileSync(join(f.home, 'config/software-factory.json'), JSON.stringify({ home: f.home, factoryRoot: join(f.home, 'factory'),
    uiOrigin: services.uiOrigin, scottyOrigin: services.scottyOrigin }));
  writeFileSync(join(f.home, 'config/hooks.json'), JSON.stringify({ version: 1, hooks: [{ id: 'software-factory-instruction-check',
    event: 'worker.start.before', timeout_seconds: 300, argv: [join(f.home, 'factory/scripts/worker-start-before.mjs'), join(f.home, 'config/software-factory.projects.json')] }] }));
  writeFileSync(f.marker, JSON.stringify(installed));
  const containers = Object.fromEntries(['dolt', 'ui', 'scotty'].map(kind => [kind === 'dolt' ? 'test' : `test-${kind}`, {
    Id: (kind === 'ui' ? '4' : kind === 'scotty' ? '5' : '6').repeat(64),
    Config: { Labels: { 'com.software-factory.home': f.home } }, Image: kind === 'dolt' ? doltImage : oldImage,
    State: { Running: true }, HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'none',
      PortBindings: kind === 'dolt' ? {} : { [`${kind === 'ui' ? port : 3000}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] } },
    Mounts: [{ Type: 'bind', Source: kind === 'dolt' ? join(f.home, 'beads') : f.home,
      Destination: kind === 'dolt' ? join(f.home, 'beads') : f.home, RW: kind !== 'scotty' }],
  }]));
  const state = join(f.root, 'containers.json');
  writeFileSync(state, JSON.stringify(containers));
  writeFileSync(join(f.bin, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(f.bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs'), a=process.argv.slice(2), path=${JSON.stringify(state)};
const containers=JSON.parse(fs.readFileSync(path,'utf8'));
fs.appendFileSync(${JSON.stringify(f.log)},JSON.stringify(a)+'\\n');
if(a[0]==='info') console.log('27.0');
else if(a[0]==='container') console.log(Object.keys(containers).join('\\n'));
else if(a[0]==='inspect') console.log(JSON.stringify([containers[a[1]]]));
else if(a[0]==='image') console.log(a[2]);
else {
  if(a[0]==='stop') containers[a.at(-1)].State.Running=false;
  else if(a[0]==='rm') delete containers[a[1]];
  else if(a[0]==='start') containers[a[1]].State.Running=true;
  else if(a[0]==='run') {
    const name=a[a.indexOf('--name')+1], kind=name.endsWith('-ui')?'ui':'scotty';
    containers[name]=${JSON.stringify(containers)}[name];
    containers[name].Image=${JSON.stringify(newImage)};
    containers[name].Id=(kind==='ui'?'7':'8').repeat(64);
    containers[name].Mounts=a.flatMap((v,i)=>v==='-v'?[a[i+1]]:[]).map(v=>{const [source,destination,mode]=v.split(':');return {Type:'bind',Source:source,Destination:destination,RW:mode!=='ro'}});
    containers[name].Config.Env=a.flatMap((v,i)=>v==='-e'?[a[i+1]]:[]);
  } else throw Error('Unexpected Docker command '+a);
  fs.writeFileSync(path,JSON.stringify(containers));
  if((a[0]==='rm' && process.env.SF_TEST_FAIL==='partial') ||
     (a[0]==='stop' && process.env.SF_TEST_FAIL==='stopped') ||
     (a[0]==='run' && process.env.SF_TEST_FAIL==='created')) throw Error('Injected partial replacement failure');
}
`, { mode: 0o755 });
  writeFileSync(join(f.home, 'services/test-rebuild.mjs'), `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { rebuild, verifyUpdate, preflight } from './update.mjs';
import { dockerRunner, json } from '../factory/scripts/home-acceptance.mjs';
const docker = dockerRunner('docker');
try {
  // The public entrypoint and the fresh rebuild both use this validation.
  await verifyUpdate(json(${JSON.stringify(f.marker)}), docker, preflight());
  await rebuild(docker, {
    buildImages: async () => { appendFileSync(${JSON.stringify(join(f.root, 'builds'))}, 'build\\n'); return { runtime: ${JSON.stringify(newImage)}, dolt: ${JSON.stringify(doltImage)} }; },
    acceptance: async () => {
      if (process.env.SF_TEST_FAIL === 'accept') throw Error('Injected failure after replacement');
      writeFileSync(${JSON.stringify(join(f.root, 'accepted'))}, 'accepted');
    },
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  f.git('add', '.'); f.git('commit', '-m', 'Update fixture');
  const pending = join(f.home, 'state/software-factory.update.pending.json');
  writeFileSync(pending, JSON.stringify({ home: f.home, before: installed.commit, target: f.git('rev-parse', 'HEAD'), local: true, started: Date.now() }));
  const invoke = (failure = '') => spawnSync(process.execPath, [join(f.home, 'services/test-rebuild.mjs')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, SF_TEST_FAIL: failure },
  });
  return { ...f, state, pending, invoke, newImage, close: async () => {
    const exited = once(server, 'exit'); server.kill(); await exited; f.close();
  } };
}

test('update checkpoints replacement identities and reruns after partial or completed replacement', linux, async () => {
  for (const [failure, sameImage] of [['accept', false], ['partial', false], ['stopped', false], ['created', false], ['accept', true]] as const) {
    const f = await updateFixture(sameImage);
    try {
      const before = readFileSync(f.marker, 'utf8');
      const first = f.invoke(failure);
      assert.equal(first.status, 1, first.stderr);
      assert.match(first.stderr, /Injected.*replacement/);
      assert.equal(readFileSync(f.marker, 'utf8'), before);
      assert.equal(existsSync(f.pending), true);
      const retry = f.invoke();
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(existsSync(f.pending), false);
      assert.equal(readFileSync(join(f.root, 'accepted'), 'utf8'), 'accepted');
      assert.equal(readFileSync(join(f.root, 'builds'), 'utf8'), 'build\n', 'Reuse the exact checkpointed images');
      const installed = JSON.parse(readFileSync(f.marker, 'utf8'));
      assert.equal(installed.commit, f.git('rev-parse', 'HEAD'));
      assert.equal(installed.images.runtime, f.newImage);
      assert.equal(installed.home, f.home);
      const containers = JSON.parse(readFileSync(f.state, 'utf8'));
      assert.equal(containers['test-ui'].Id, '7'.repeat(64), 'Restart old services even when image IDs match');
      assert.equal(containers['test-scotty'].Id, '8'.repeat(64));
      assert.equal(f.git('status', '--porcelain'), '');
    } finally { await f.close(); }
  }
});

test('replacement recovery rejects changed images, ports, mounts, ownership, home and target before mutations', linux, async () => {
  const f = await updateFixture();
  try {
    assert.match(f.invoke('accept').stderr, /Injected failure after replacement/);
    const state = JSON.parse(readFileSync(f.state, 'utf8'));
    const pending = JSON.parse(readFileSync(f.pending, 'utf8'));
    const marker = readFileSync(f.marker, 'utf8');
    const mutations = () => readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(a => ['stop', 'rm', 'run', 'start'].includes(a[0])).length;
    const count = mutations();
    const changed = [
      (s: any, _t: any) => { s['test-ui'].Image = 'sha256:' + '9'.repeat(64); },
      (s: any, _t: any) => { Object.values(s['test-ui'].HostConfig.PortBindings as any).forEach((b: any) => { b[0].HostPort = '9'; }); },
      (s: any, _t: any) => { s['test-ui'].HostConfig.PortBindings['9/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '9' }]; },
      (s: any, _t: any) => { s['test-ui'].Mounts[0].RW = false; },
      (s: any, _t: any) => { s['test-ui'].Mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/foreign', RW: true }); },
      (s: any, _t: any) => { s['test-ui'].Config.Labels['com.software-factory.home'] = '/foreign'; },
      (_s: any, t: any) => { t.replacement.home = '/foreign'; },
      (_s: any, t: any) => { t.replacement.target = 'a'.repeat(40); },
      (_s: any, t: any) => { t.replacement.next.commit = 'b'.repeat(40); },
      (_s: any, t: any) => { t.replacement.next.services.uiPort = 9; },
      (s: any, _t: any) => { s.test.HostConfig.PortBindings = { '9/tcp': [{ HostIp: '127.0.0.1', HostPort: '9' }] }; },
      (s: any, _t: any) => { s.test.Mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/foreign', RW: true }); },
    ];
    for (const change of changed) {
      const s = structuredClone(state), t = structuredClone(pending);
      change(s, t);
      writeFileSync(f.state, JSON.stringify(s)); writeFileSync(f.pending, JSON.stringify(t));
      const result = f.invoke();
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /foreign|changed|checkpoint|candidate/);
      assert.equal(mutations(), count);
      assert.equal(readFileSync(f.marker, 'utf8'), marker);
    }
    writeFileSync(f.state, JSON.stringify(state)); writeFileSync(f.pending, JSON.stringify(pending));
    writeFileSync(f.marker, JSON.stringify({ ...JSON.parse(marker), commit: 'b'.repeat(40) }));
    assert.match(f.invoke().stderr, /installation mismatch/);
    assert.equal(mutations(), count);
    writeFileSync(f.marker, marker);
    // Also recover a crash after the completion marker write but before the
    // pending transaction rename, without accepting an arbitrary changed marker.
    writeFileSync(f.marker, JSON.stringify(pending.replacement.next));
    assert.equal(f.invoke().status, 0);
    writeFileSync(f.pending, JSON.stringify(pending));
    f.git('commit', '--allow-empty', '-m', 'Later source');
    assert.match(f.invoke().stderr, /exact recorded target/);
    assert.equal(mutations(), count);
  } finally { await f.close(); }
});


test('update accepts a recreated legacy Scotty with its viewer flag removed and regenerates its launch files', linux, async () => {
  const f = await updateFixture();
  try {
    const containers = JSON.parse(readFileSync(f.state, 'utf8'));
    containers['test-scotty'].Id = '9'.repeat(64);
    containers['test-scotty'].Config.Env = ['POSTHOG_KEY='];
    writeFileSync(f.state, JSON.stringify(containers));
    const directory = join(f.home, 'config/software-factory-services');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'scotty-launch.mjs'), 'throw new Error("Hand-unlocked launcher must be replaced")');
    writeFileSync(join(directory, 'scotty-bd.cjs'), 'throw new Error("Hand-unlocked bd bridge must be replaced")');
    const result = f.invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(f.state, 'utf8'))['test-scotty'].Id, '8'.repeat(64));
    assert.equal(spawnSync(process.execPath, ['--check', join(directory, 'scotty-launch.mjs')]).status, 0);
    assert.equal(JSON.parse(readFileSync(f.marker, 'utf8')).services.editable, true);
  } finally { await f.close(); }
});
