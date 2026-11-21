#!/usr/bin/env node
// Native start configuration and exact-head merge locks. No model calls.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkFactoryMerge, requireFactoryStartHook } from '../dist/src/factory-locks.js';
import { parseStrictJson } from '../dist/src/strict-json.js';

try {
  const [action, registryPath, home, repository, taskId, head] = process.argv.slice(2);
  const config = parseStrictJson(readFileSync(registryPath, 'utf8'));
  if (action === 'start') {
    requireFactoryStartHook(config, registryPath, home, repository,
      fileURLToPath(new URL('./worker-start-before.mjs', import.meta.url)));
  } else if (action === 'merge') {
    process.stdout.write(JSON.stringify(checkFactoryMerge(config, home, repository, taskId, head)) + '\n');
  } else throw new Error('expected start or merge');
} catch (error) {
  process.stderr.write(`factory refused: ${error.message}\n`);
  process.exitCode = 1;
}
