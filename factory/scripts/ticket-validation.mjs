#!/usr/bin/env node
// Start the existing no-mistakes driver with the reviewed Factory ticket.
// Check the raw body of its PR after reading it from the forge.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { repositoryIdentity } from '../dist/src/factory-locks.js';
import { parseStrictJson } from '../dist/src/strict-json.js';
import { firstMateEnv } from '../dist/src/runtime.js';
import { renderIntentSection, scaffoldParts } from '../dist/src/instructions.js';
import { readTicketDelivery, ticketDeliveryMarker, ticketDeliveryStartCommand, verifyTicketBranch } from '../dist/src/ticket-delivery.js';

const usage = 'usage: ticket-validation.mjs <brief|start|pr-body|check-pr> /absolute/ticket-delivery.json\n' +
  'Brief prints a delivery worker brief. Start from the reviewed ticket branch. For pr-body and check-pr, pass the full PR body on stdin.';

function deliveryBrief(delivery, path, intent) {
  verifyTicketBranch(delivery);
  const { firstMate } = z.object({ firstMate: z.object({ home: z.string(), briefExecutable: z.string(),
    dataDirectory: z.string() }) }).parse(parseStrictJson(readFileSync(join(dirname(path), 'run.json'), 'utf8')));
  const temporary = mkdtempSync(join(tmpdir(), 'factory-delivery-brief-'));
  try {
    execFileSync(firstMate.briefExecutable, [delivery.taskId, basename(delivery.repository),
      '--mode', 'no-mistakes', '--branch-prefix', 'fm/ticket/'], {
      cwd: firstMate.home, env: { ...firstMateEnv(firstMate.home), FM_DATA_OVERRIDE: temporary },
      encoding: 'utf8', timeout: 15_000,
    });
    const scaffold = readFileSync(join(temporary, delivery.taskId, 'brief.md'), 'utf8').replaceAll(temporary, firstMate.dataDirectory);
    const parts = scaffoldParts(scaffold);
    const command = ticketDeliveryStartCommand(fileURLToPath(import.meta.url), path, delivery);
    const notes = delivery.reviewNotes ? ' After the final pipeline update, pipe the full PR body into the same helper with the pr-body action, update the PR body with its output, and verify the saved body with the check-pr action.' : '';
    const setup = /^1\. First action: create your branch:[^\n]*\n2\. Run [^\n]*no-mistakes doctor[^\n]*$/mu;
    const initial = /^The task is complete only when committed on your branch\.[\s\S]*?(?=^One drive call blocks)/mu;
    if (!setup.test(parts.suffix) || !initial.test(parts.suffix)) throw new Error('Factory delivery brief scaffold changed.');
    const suffix = parts.suffix
      .replace(setup, () => `1. In the isolated worktree, check out the existing reviewed branch: \`git switch --no-guess ${delivery.branch}\`.\n2. Confirm HEAD is ${delivery.commit}. Run the full project test suite here and require it to pass before starting validation.`)
      .replace(initial, () => `Start the pipeline once with \`${command}\`. It passes the complete reviewed ticket intent. Follow the pipeline gates.${notes} Report the resulting PR without merging it.\n\n`);
    return renderIntentSection(parts, intent) + ticketDeliveryMarker + path +
      '\n\nDeliver the reviewed ticket without adding product work. Start validation using the command under Definition of done.\n\n' + suffix;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const [action, deliveryPath, expectedCommit, expectedIntentDigest] = process.argv.slice(2);
try {
  if (action === '--help') process.stdout.write(`${usage}\n`);
  else {
    const pinned = action === 'start' && process.argv.length === 6;
    if (!['brief', 'start', 'pr-body', 'check-pr'].includes(action) || !deliveryPath || !isAbsolute(deliveryPath) ||
      (!pinned && process.argv.length !== 4)) throw new Error(usage);
    const { delivery, intent } = readTicketDelivery(deliveryPath);
    if (pinned && (expectedCommit !== delivery.commit || expectedIntentDigest !== delivery.intentDigest)) {
      throw new Error('Factory ticket handoff changed after worker admission.');
    }
    if (action === 'brief') process.stdout.write(deliveryBrief(delivery, deliveryPath, intent));
    else if (action === 'check-pr' || action === 'pr-body') {
      const body = readFileSync(0, 'utf8').replaceAll('\r\n', '\n');
      const section = `\n## Intent\n\n${intent.replaceAll('\r\n', '\n').trim()}\n`;
      if (!`\n${body}\n`.includes(section)) throw new Error('The PR body does not contain the full Factory ticket in its Intent section. Check the effective no-mistakes intent publication settings.');
      const alreadyPresent = !delivery.reviewNotes || `\n${body}\n`.includes(`\n${delivery.reviewNotes}\n`);
      if (action === 'pr-body') {
        process.stdout.write(alreadyPresent ? body : `${body.trimEnd()}\n\n${delivery.reviewNotes}\n`);
      } else {
        if (!alreadyPresent) throw new Error('The PR body does not contain the Factory review notes.');
        process.stdout.write('Verified the full Factory ticket and any review notes in the PR body.\n');
      }
    } else {
      const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 15_000 }).trim();
      const checkout = git('rev-parse', '--show-toplevel');
      if (repositoryIdentity(checkout) !== repositoryIdentity(delivery.repository) ||
        git('symbolic-ref', '--quiet', '--short', 'HEAD') !== delivery.branch || git('rev-parse', 'HEAD') !== delivery.commit) {
        throw new Error('Start validation from the reviewed ticket repository, branch and commit.');
      }
      verifyTicketBranch(delivery);
      const result = spawnSync('no-mistakes', ['axi', 'run', '--intent-file', delivery.intentFile], { stdio: 'inherit' });
      if (result.error || result.signal) throw new Error(result.error?.message ?? `no-mistakes stopped on ${result.signal}`);
      process.exitCode = result.status ?? 1;
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
