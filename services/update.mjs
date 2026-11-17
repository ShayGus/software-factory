#!/usr/bin/env node
// Factory update: refuse unfinished work, use fm-update.sh, then rebuild with
// the UPDATED installer in a fresh Node process. No force/reset/stash or DB migration.
// Usage: node services/update.mjs [--docker auto|docker|sg-docker] [--local] [--help]
// Private config, projects, databases and settings remain authoritative.
// A rebuild failure before service replacement resumes through this command,
// including a clean fast-forward fix. Foreign/divergent checkpoints refuse.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { home, marker, pins, assertClone, build, verify, inspectOwned, accept, report, writeJson } from './setup.mjs';
import { cleanEnv, dockerRunner, executable, json, run } from '../factory/scripts/home-acceptance.mjs';
import { installFolderServices } from '../factory/scripts/folder-services.mjs';

function refuseUnfinished() {
  const meta = readdirSync(join(home, 'state')).filter(name => name.endsWith('.meta'));
  if (meta.length) throw new Error(`Refusing unfinished workers or secondmates: ${meta.join(', ')}; finish their delivery first`);
  const unmerged = run('git', ['-C', home, 'branch', '--format=%(refname:short)', '--no-merged', 'HEAD']);
  if (unmerged) throw new Error(`Refusing unlanded local branches: ${unmerged}`);
}

export function preflight() {
  assertClone();
  if (!existsSync(marker)) throw new Error('Run setup before updating');
  refuseUnfinished();
  const pending = join(home, 'state/software-factory.update.pending.json');
  if (!existsSync(pending)) return;
  const transaction = json(pending);
  if (!transaction || transaction.home !== home || !/^[a-f0-9]{40}$/.test(transaction.before) || !/^[a-f0-9]{40}$/.test(transaction.target) ||
    typeof transaction.local !== 'boolean' || !Number.isSafeInteger(transaction.started) || transaction.started <= 0) {
    throw new Error('Invalid factory update transaction; inspect state/software-factory.update.pending.json');
  }
  // Also covers a crash after the guarded fast-forward but before its checkpoint.
  try {
    run('git', ['-C', home, 'merge-base', '--is-ancestor', transaction.before, transaction.target]);
    run('git', ['-C', home, 'merge-base', '--is-ancestor', transaction.target, 'HEAD']);
  } catch { throw new Error('Update transaction/source mismatch; pending target must be an ancestor of the clean current source'); }
  return transaction;
}

async function rebuild(docker) {
  const pending = join(home, 'state/software-factory.update.pending.json');
  if (!existsSync(pending)) throw new Error('Missing factory update transaction');
  const transaction = json(pending);
  const installed = json(marker);
  if (transaction.home !== home || transaction.target !== run('git', ['-C', home, 'rev-parse', 'HEAD'])) throw new Error('Update transaction/source mismatch');
  refuseUnfinished();
  await verify(installed, docker);
  if (installed.pins.dolt !== pins.dolt || installed.pins.beads.version !== pins.beads.version || installed.pins.scotty.commit !== pins.scotty.commit) {
    throw new Error('Service/database dependency pins changed; an explicit migration is required before replacing a running service');
  }
  // Build before stopping anything. Validate every old container before mutation.
  const images = await build(docker);
  for (const name of Object.values(installed.services.names)) inspectOwned(docker, name);
  for (const name of Object.values(installed.services.names)) {
    console.log(docker(['stop', '--time', '30', name]));
    console.log(docker(['rm', name]));
  }
  const services = await installFolderServices({ ...installed.args, tailnet: true }, docker, images.runtime, installed.services);
  const next = { ...installed, images, services, pins, commit: transaction.target, updatedAt: new Date().toISOString() };
  await accept(next, { isolatedState: true });
  await verify(next, docker);
  writeJson(marker, next);
  // Retain the completed transaction as evidence; renaming removes the pending gate.
  const { renameSync } = await import('node:fs');
  renameSync(pending, join(home, `data/software-factory.update.${transaction.started}.json`));
  report(next);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node services/update.mjs [--docker auto|docker|sg-docker] [--local]\n--local rebuilds an approved committed local landing without fetching.\nGuarded source update, rebuild and real Claude acceptance. Refuses unfinished work; never discards private data.');
    return;
  }
  const internal = argv[0] === '--rebuild';
  const local = !internal && argv.includes('--local');
  const args = (internal ? argv.slice(1) : argv).filter(value => value !== '--local');
  let mode = 'auto';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--docker' || !['auto', 'docker', 'sg-docker'].includes(args[1])) throw new Error('Invalid update options; run --help');
    mode = args[1];
  }
  if (internal) { assertClone(); await rebuild(dockerRunner(mode)); return; }
  const previous = preflight();
  const docker = dockerRunner(mode);
  const installed = json(marker);
  await verify(installed, docker);
  const before = run('git', ['-C', home, 'rev-parse', 'HEAD']);
  const pending = join(home, 'state/software-factory.update.pending.json');
  const transaction = previous ?? { home, before, target: before, local, started: Date.now() };
  if (previous) console.log('Resuming incomplete factory update');
  else writeJson(pending, transaction);
  if (!local && !transaction.local) {
    const output = run('bash', [join(home, 'bin/fm-update.sh')], { cwd: home, env: { ...cleanEnv(), FM_HOME: home } });
    console.log(output);
    if (!/^firstmate: (updated |already current)/m.test(output) || /^secondmate .*: skipped:/m.test(output)) throw new Error('FirstMate updater refused part of the source update; inspect its output');
  }
  transaction.target = run('git', ['-C', home, 'rev-parse', 'HEAD']);
  writeJson(pending, transaction);
  // exec via a fresh process so code and dependency pins come from the new commit.
  console.log(run(process.execPath, [join(home, 'services/update.mjs'), '--rebuild', '--docker', mode], { cwd: home, timeout: 1800000, maxBuffer: 64 * 1024 * 1024 }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const entry = async () => {
    const argv = process.argv.slice(2);
    if ((argv.length === 1 && argv[0] === '--help') || process.env.SF_FACTORY_SETUP_LOCK === home) return main(argv);
    assertClone();
    executable(undefined, 'flock');
    mkdirSync(join(home, 'state'), { recursive: true });
    // Share setup's kernel-owned lock across the source update and fresh-process
    // rebuild. A crash releases it, allowing the same transaction to resume.
    const result = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', join(home, 'state/software-factory.setup.lock'),
      process.execPath, fileURLToPath(import.meta.url), ...argv], { stdio: 'inherit', env: { ...process.env, SF_FACTORY_SETUP_LOCK: home } });
    if (result.status === 75) throw new Error('Another setup/update is running for this folder; wait for it to finish, then retry');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  };
  entry().catch(error => { console.error(`Factory update refused/failed: ${error.message}\nSource and private data were retained; inspect the pending transaction and dedicated services.`); process.exitCode = 1; });
}
