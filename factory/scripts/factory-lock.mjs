#!/usr/bin/env node
// Native Factory start, steer and exact-head merge checks.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkFactoryMerge, requireFactoryStartHook } from '../dist/src/factory-locks.js';
import { checkFactorySteer } from '../dist/src/worker-steer.js';
import { parseStrictJson } from '../dist/src/strict-json.js';

try {
  const [action, registryPath, home, repository, taskId, head] = process.argv.slice(2);
  const config = parseStrictJson(readFileSync(registryPath, 'utf8'));
  if (action === 'start') {
    requireFactoryStartHook(config, registryPath, home, repository,
      fileURLToPath(new URL('./worker-start-before.mjs', import.meta.url)));
  } else if (action === 'merge') {
    process.stdout.write(JSON.stringify(checkFactoryMerge(config, home, repository, taskId, head)) + '\n');
  } else if (action === 'steer') {
    checkFactorySteer(config, home, repository, taskId, readFileSync(0, 'utf8'), head);
  } else throw new Error('expected start, steer or merge');
} catch (error) {
  process.stderr.write(`factory refused: ${error.message}\n`);
  process.exitCode = 1;
}
