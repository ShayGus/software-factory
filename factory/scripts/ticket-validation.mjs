#!/usr/bin/env node
// Start the existing no-mistakes driver with the reviewed Factory ticket.
// Check the raw body of its PR after reading it from the forge.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { repositoryIdentity } from '../dist/src/factory-locks.js';
import { digestText } from '../dist/src/instruction-context.js';
import { CommitSchema } from '../dist/src/review-contracts.js';
import { parseStrictJson } from '../dist/src/strict-json.js';

const usage = 'usage: ticket-validation.mjs <start|check-pr> /absolute/ticket-delivery.json\n' +
  'Start from the reviewed ticket branch. For check-pr, pass the full PR body on stdin.';
const [action, deliveryPath] = process.argv.slice(2);
try {
  if (action === '--help') process.stdout.write(`${usage}\n`);
  else {
    if (!['start', 'check-pr'].includes(action) || !deliveryPath || !isAbsolute(deliveryPath) || process.argv.length !== 4) throw new Error(usage);
    const delivery = z.object({ mode: z.literal('no-mistakes'), branch: z.string().startsWith('fm/ticket/'),
      repository: z.string().refine(isAbsolute), commit: CommitSchema, intentFile: z.string().refine(isAbsolute),
      intentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }).parse(parseStrictJson(readFileSync(deliveryPath, 'utf8')));
    const intent = readFileSync(delivery.intentFile, 'utf8');
    if (!intent.trim() || digestText(intent) !== delivery.intentDigest) throw new Error('Factory ticket intent is empty or changed. Read back the reviewed handoff.');
    if (action === 'check-pr') {
      const body = readFileSync(0, 'utf8').replaceAll('\r\n', '\n');
      const section = `\n## Intent\n\n${intent.replaceAll('\r\n', '\n').trim()}\n`;
      if (!`\n${body}\n`.includes(section)) throw new Error('The PR body does not contain the full Factory ticket in its Intent section. Check the effective no-mistakes intent publication settings.');
      process.stdout.write('Verified the full Factory ticket in the PR body.\n');
    } else {
      const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 15_000 }).trim();
      const checkout = git('rev-parse', '--show-toplevel');
      if (repositoryIdentity(checkout) !== repositoryIdentity(delivery.repository) ||
        git('symbolic-ref', '--quiet', '--short', 'HEAD') !== delivery.branch || git('rev-parse', 'HEAD') !== delivery.commit) {
        throw new Error('Start validation from the reviewed ticket repository, branch and commit.');
      }
      const result = spawnSync('no-mistakes', ['axi', 'run', '--intent-file', delivery.intentFile], { stdio: 'inherit' });
      if (result.error || result.signal) throw new Error(result.error?.message ?? `no-mistakes stopped on ${result.signal}`);
      process.exitCode = result.status ?? 1;
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
