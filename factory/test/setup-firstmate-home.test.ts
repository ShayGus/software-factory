import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const setup = fileURLToPath(new URL('../../scripts/setup-firstmate-home.mjs', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sf-home-'));
  const home = join(root, 'home');
  const log = join(root, 'docker.jsonl');
  const docker = join(root, 'docker');
  writeFileSync(docker, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'info') console.log('27.0');
else if (args[0] === 'container' && args[1] === 'ls') console.log(process.env.SF_TEST_CONTAINER ?? '');
else { console.error('Unexpected Docker mutation'); process.exitCode = 99; }
`, { mode: 0o755 });
  // Make the fake Docker executable an ESM program even without an extension.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const args = ['--home', home, '--name', 'test', '--container', 'test-dolt', '--database', 'test_db',
    '--fork-source', '/unused/fork', '--tasks-source', '/unused/tasks', '--factory-source', '/unused/factory'];
  const invoke = (options: string[] = args, container = '') => spawnSync(process.execPath, [setup, ...options], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SF_TEST_CONTAINER: container }
  });
  return { root, home, log, args, invoke, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('setup help is available without Docker or source repositories', () => {
  const result = spawnSync(process.execPath, [setup, '--help'], { encoding: 'utf8', env: { PATH: '' } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--fork-source/);
  assert.match(result.stdout, /--crew-dispatch/);
  assert.match(result.stdout, /claude -p/);
});

test('existing directories and dangling symlinks are refused without touching Docker', () => {
  const f = fixture();
  try {
    mkdirSync(f.home);
    const sentinel = join(f.home, 'keep'); writeFileSync(sentinel, 'unchanged');
    const result = f.invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing existing home/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
    assert.equal(existsSync(f.log), false);
    rmSync(f.home, { recursive: true });
    symlinkSync(join(f.root, 'absent'), f.home);
    assert.match(f.invoke().stderr, /Refusing existing home/);
    assert.equal(existsSync(f.log), false);
  } finally { f.close(); }
});

for (const container of ['test-dolt', 'test-dolt-bd-extract', 'test-dolt-scotty', 'test-dolt-ui']) {
  test(`existing ${container} is refused before a home is created or Docker mutates`, () => {
    const f = fixture();
    try {
      const result = f.invoke(f.args, container);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`Refusing existing container: ${container}`));
      assert.equal(existsSync(f.home), false);
      const calls = readFileSync(f.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(calls.length > 0);
      assert.ok(calls.every((args) => args[0] === 'info' || (args[0] === 'container' && args[1] === 'ls')));
    } finally { f.close(); }
  });
}

test('invalid database and duplicate arguments are refused before resource allocation', () => {
  const f = fixture();
  try {
    const invalid = [...f.args]; invalid[invalid.indexOf('--database') + 1] = 'db;drop';
    assert.match(f.invoke(invalid).stderr, /Invalid --database/);
    assert.match(f.invoke([...f.args, '--home', f.home]).stderr, /duplicate/);
    assert.match(f.invoke([...f.args, '--ui-port', '65536']).stderr, /Invalid --ui-port/);
    assert.match(f.invoke([...f.args, '--scotty-port', '0']).stderr, /Invalid --scotty-port/);
    assert.equal(existsSync(f.home), false);
    assert.equal(existsSync(f.log), false);
  } finally { f.close(); }
});

test('completion records with different inputs cannot authorize changing an existing home', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, 'config'), { recursive: true });
    const marker = join(f.home, 'config/software-factory.install.json');
    const body = '{"version":1,"state":"complete","inputs":{}}\n';
    writeFileSync(marker, body);
    const result = f.invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /different setup inputs/);
    assert.equal(readFileSync(marker, 'utf8'), body);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.every((args) => args[0] === 'info'));
  } finally { f.close(); }
});
