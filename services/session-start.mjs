#!/usr/bin/env node
// Claude-only session adapter. First setup is synchronous (1800s hook budget),
// so no prompt can race an incomplete factory. The normal digest keeps its own
// 180s bound. Setup output streams to verbose hook output and a private log;
// systemMessage displays the result even before the first user prompt.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quote, replaceJson } from '../factory/scripts/home-acceptance.mjs';

const home = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = join(home, 'config/software-factory.install.json');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function installed() {
  const record = read(marker);
  if (record.version !== 2 || record.state !== 'complete' || record.home !== home) throw new Error('Invalid installation record; inspect config/software-factory.install.json before retrying.');
  return record;
}
function addresses(record) {
  const services = record.services;
  return `Factory screens: ${services.uiOrigin}\nScotty (view-only): ${services.scottyOrigin}/p/factory\n` +
    (services.tailnet?.enabled ? `Factory screens (tailnet): ${services.tailnet.uiOrigin}\nScotty (tailnet, view-only): ${services.tailnet.scottyOrigin}/p/factory` : `Tailnet unavailable: ${services.tailnet?.reason ?? 'not configured'}`);
}

const displayBackup = join(home, 'state/software-factory.setup-display.json');
const settingsPath = join(home, '.claude/settings.local.json');
const statusLine = { type: 'command', command: `${quote(process.execPath)} ${quote(join(home, 'services/setup-status.mjs'))}`, refreshInterval: 1 };
function restoreDisplay() {
  if (!existsSync(displayBackup)) return;
  const settings = read(settingsPath);
  if (settings.statusLine?.command !== statusLine.command) return;
  const { original } = read(displayBackup);
  if (original === null) delete settings.statusLine;
  else settings.statusLine = original;
  replaceJson(settingsPath, settings);
  unlinkSync(displayBackup);
}
function showProgress() {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = existsSync(settingsPath) ? read(settingsPath) : {};
  // A killed hook can leave the temporary line active. Keep its original
  // backup when resuming, rather than backing up the temporary line itself.
  if (settings.statusLine?.command !== statusLine.command || !existsSync(displayBackup)) {
    replaceJson(displayBackup, { original: settings.statusLine ?? null });
  }
  replaceJson(settingsPath, { ...settings, statusLine });
}

async function setup() {
  mkdirSync(join(home, 'data'), { recursive: true });
  const log = join(home, 'data/software-factory.setup.log');
  const start = Date.now();
  const progress = phase => replaceJson(join(home, 'state/software-factory.setup-progress.json'), { phase, started: start });
  progress('Checking prerequisites');
  showProgress();
  const write = text => { appendFileSync(log, text, { mode: 0o600 }); process.stderr.write(text); };
  write(`\nSoftware Factory first-start setup/resume: ${new Date().toISOString()}\nBuilding dependencies and dedicated services; usually 5-15 minutes on first use.\n`);
  let tail = '';
  const child = spawn(process.execPath, [join(home, 'services/setup.mjs')], {
    cwd: home, env: { ...process.env, SF_FACTORY_SETUP_ACTIVE: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    const text = chunk.toString(); tail = (tail + text).slice(-6000); write(text);
    for (const line of text.split('\n')) {
      if (/^(Building bundled |Downloading official |Pulling digest-pinned |Building Scotty |Resuming with |Starting\/resuming |Running automatic Claude acceptance|Screen acceptance passed)/.test(line)) progress(line.trim());
    }
  });
  const timer = setInterval(() => write(`Software Factory setup still running (${Math.floor((Date.now() - start) / 1000)}s elapsed).\n`), 15000);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${tail}\nSetup exited ${code ?? signal}. Full log: ${log}`)));
    });
  } finally { clearInterval(timer); restoreDisplay(); }
  return Math.round((Date.now() - start) / 1000);
}

export async function main(payload) {
  let summary;
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js >=22.13 is required. Install it from https://nodejs.org/en/download.');
    const env = { ...process.env, FM_HOME: home, PATH: `${join(home, '.tools/bin')}:${process.env.PATH ?? ''}` };
    if (!existsSync(marker)) {
      // Use the existing home lock before provisioning an existing checkout.
      // The acceptance child uses a separate state directory; the real Claude
      // remains the home owner and its normal digest confirms that same lock.
      const lock = spawnSync('bash', [join(home, 'bin/fm-lock.sh')], { cwd: home, env, encoding: 'utf8' });
      if (lock.status !== 0) throw new Error(`Cannot set up this home while its session lock is unavailable:\n${lock.stdout ?? ''}${lock.stderr ?? ''}`);
      const seconds = await setup();
      summary = `Software Factory ready in ${seconds}s.\n${addresses(installed())}`;
    } else {
      // Also restores a line left by a killed hook after setup saved its marker.
      restoreDisplay();
      summary = `Software Factory ready.\n${addresses(installed())}`;
    }
    // settings.local.json is read before hooks run. Persist PATH explicitly for
    // this very first session as well as supplying it to the startup digest.
    if (process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, `export PATH=${quote(join(home, '.tools/bin'))}:"$PATH"\n`);
    const digest = spawnSync('bash', [join(home, 'bin/fm-sessionstart-run.sh')], { cwd: home, env, input: payload, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    if (digest.error || digest.status !== 0) throw new Error(`Factory services are ready, but FirstMate startup failed: ${digest.error?.message ?? digest.stderr}. Start claude again.`);
    return { systemMessage: summary, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${summary}\n${digest.stdout}` } };
  } catch (error) {
    const message = `Software Factory setup needs attention:\n${error.message}\nAfter fixing the requirement, start claude again; setup will resume without deleting existing data.`;
    return { systemMessage: message, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${message}\nFactory setup/startup is incomplete. Explain the concrete failure above. Do not dispatch factory work or run the normal digest until setup succeeds.` } };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(readFileSync(0, 'utf8')).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
