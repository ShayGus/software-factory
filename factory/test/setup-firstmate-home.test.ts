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
  for (const name of ['home-acceptance.mjs', 'claude-acceptance-evidence.mjs', 'folder-services.mjs', 'scotty-spike-reader.mjs', 'tailnet.mjs']) {
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
  return { root, home, log, invoke, git, marker, installed, close: () => rmSync(root, { recursive: true, force: true }) };
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
