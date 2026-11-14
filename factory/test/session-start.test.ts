import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../../../', import.meta.url));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sf-session-'));
  for (const dir of ['services', 'factory/scripts', 'bin']) mkdirSync(join(home, dir), { recursive: true });
  cpSync(join(source, 'services/session-start.mjs'), join(home, 'services/session-start.mjs'));
  for (const file of ['home-acceptance.mjs', 'claude-acceptance-evidence.mjs']) cpSync(join(source, 'factory/scripts', file), join(home, 'factory/scripts', file));
  writeFileSync(join(home, 'bin/fm-lock.sh'), '#!/bin/bash\nexit 0\n');
  writeFileSync(join(home, 'bin/fm-sessionstart-run.sh'), '#!/bin/bash\ncat >/dev/null\nprintf "digest:%s\\n" "$PATH"\n', { mode: 0o755 });
  const setup = (fail = false) => writeFileSync(join(home, 'services/setup.mjs'), fail
    ? "console.error('Missing jq. Run: sudo apt-get install jq'); process.exitCode=1;"
    : `import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
const home=${JSON.stringify(home)};
mkdirSync(home+'/config',{recursive:true});
appendFileSync(home+'/calls','setup\\n');
if(process.env.SF_FACTORY_SETUP_ACTIVE!==home) throw new Error('Missing acceptance recursion guard');
console.log('Building services');
writeFileSync(home+'/config/software-factory.install.json',JSON.stringify({version:2,state:'complete',home,
services:{uiOrigin:'http://127.0.0.1:10001',scottyOrigin:'http://127.0.0.1:10002',tailnet:{enabled:true,
uiOrigin:'https://test.tailnet.ts.net:10001',scottyOrigin:'https://test.tailnet.ts.net:10002'}}}));`);
  setup();
  const envFile = join(home, 'env');
  writeFileSync(envFile, 'export EXISTING=preserved\n');
  const invoke = () => spawnSync(process.execPath, [join(home, 'services/session-start.mjs')], {
    input: '{"source":"startup"}', encoding: 'utf8', env: { ...process.env, CLAUDE_ENV_FILE: envFile },
  });
  return { home, setup, invoke, envFile, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('first startup installs before the digest and supplies this session PATH and addresses', () => {
  const f = fixture();
  try {
    const result = f.invoke();
    assert.equal(result.status, 0, result.stderr);
    const hook = JSON.parse(result.stdout);
    assert.match(hook.systemMessage, /ready in \d+s/);
    assert.match(hook.systemMessage, /https:\/\/test.tailnet.ts.net:10001/);
    assert.match(hook.systemMessage, /http:\/\/127.0.0.1:10002\/p\/factory/);
    assert.ok(hook.hookSpecificOutput.additionalContext.includes(`digest:${f.home}/.tools/bin:`));
    assert.equal(readFileSync(join(f.home, 'calls'), 'utf8'), 'setup\n');
    assert.match(readFileSync(f.envFile, 'utf8'), /export EXISTING=preserved/);
    assert.ok(readFileSync(f.envFile, 'utf8').includes(`export PATH='${f.home}/.tools/bin':"$PATH"`));
    assert.match(readFileSync(join(f.home, 'data/software-factory.setup.log'), 'utf8'), /Building services/);
  } finally { f.close(); }
});

test('completed startup never invokes setup, Docker or acceptance again', () => {
  const f = fixture();
  try {
    assert.equal(f.invoke().status, 0);
    const marker = join(f.home, 'config/software-factory.install.json');
    const before = readFileSync(marker, 'utf8');
    const log = readFileSync(join(f.home, 'data/software-factory.setup.log'), 'utf8');
    f.setup(true);
    const result = f.invoke();
    assert.equal(result.status, 0);
    assert.match(JSON.parse(result.stdout).systemMessage, /Software Factory ready\./);
    assert.equal(readFileSync(marker, 'utf8'), before);
    assert.equal(readFileSync(join(f.home, 'data/software-factory.setup.log'), 'utf8'), log);
    assert.equal(readFileSync(join(f.home, 'calls'), 'utf8'), 'setup\n');
  } finally { f.close(); }
});

test('a missing prerequisite is shown, gates the digest and retries on the next start', () => {
  const f = fixture();
  try {
    f.setup(true);
    const hook = JSON.parse(f.invoke().stdout);
    assert.match(hook.systemMessage, /Missing jq\. Run: sudo apt-get install jq/);
    assert.match(hook.systemMessage, /start claude again/);
    assert.ok(!hook.hookSpecificOutput.additionalContext.includes('digest:'));
    assert.equal(existsSync(join(f.home, 'config/software-factory.install.json')), false);
    f.setup();
    assert.match(JSON.parse(f.invoke().stdout).systemMessage, /ready in/);
  } finally { f.close(); }
});

test('failed home-lock acquisition never runs setup', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, 'bin/fm-lock.sh'), '#!/bin/bash\necho "another live firstmate session holds the lock" >&2\nexit 1\n');
    const hook = JSON.parse(f.invoke().stdout);
    assert.match(hook.systemMessage, /another live firstmate session holds the lock/);
    assert.equal(existsSync(join(f.home, 'calls')), false);
  } finally { f.close(); }
});

test('Claude wrapper preserves normal startup in worktrees, other homes and acceptance children', () => {
  for (const mode of ['worktree', 'other-home', 'acceptance', 'gate', 'foreign-host']) {
    const f = fixture();
    try {
      for (const name of ['fm-factory-sessionstart.sh', 'fm-gate-refuse-lib.sh', 'fm-hook-host-lib.sh']) {
        cpSync(join(source, 'bin', name), join(f.home, 'bin', name));
      }
      if (mode === 'worktree') writeFileSync(join(f.home, '.git'), 'gitdir: /not-a-primary');
      else mkdirSync(join(f.home, '.git'));
      const env = { ...process.env, FM_HOME: mode === 'other-home' ? '/another/home' : f.home,
        SF_FACTORY_SETUP_ACTIVE: mode === 'acceptance' ? f.home : '', NO_MISTAKES_GATE: mode === 'gate' ? '1' : '' };
      const result = spawnSync('bash', [join(f.home, 'bin/fm-factory-sessionstart.sh')], {
        env, input: mode === 'foreign-host' ? '{"cursor_version":"fixture"}' : '{"source":"startup"}', encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^digest:/, mode);
      assert.equal(existsSync(join(f.home, 'calls')), false, mode);
    } finally { f.close(); }
  }
});
