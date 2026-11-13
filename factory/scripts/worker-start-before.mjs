#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkStartingWorker } from '../dist/src/worker-start-hook.js';
import { parseStrictJson } from '../dist/src/strict-json.js';

try {
  if (process.argv.length !== 3) throw new Error('usage: worker-start-before.mjs /absolute/hook-projects.json');
  const report = checkStartingWorker(parseStrictJson(readFileSync(process.argv[2], 'utf8')),
    parseStrictJson(readFileSync(0, 'utf8')));
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
  process.exitCode = 1;
}
