#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runFeature } from '../dist/src/feature-run.js';
import { parseStrictJson } from '../dist/src/strict-json.js';
try {
  const [phase, configPath] = process.argv.slice(2);
  if (!['bootstrap', 'prepare', 'start', 'review'].includes(phase) || !configPath || process.argv.length !== 4) {
    throw new Error('usage: run-feature.mjs <bootstrap|prepare|start|review> /absolute/run.json');
  }
  process.stdout.write(JSON.stringify(runFeature(parseStrictJson(readFileSync(configPath, 'utf8')), phase), null, 2) + '\n');
} catch (error) {
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
}
