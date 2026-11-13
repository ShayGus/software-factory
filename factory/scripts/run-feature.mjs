#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runFeature } from '../dist/src/feature-run.js';
import { parseStrictJson } from '../dist/src/strict-json.js';
try {
  const [phase, configPath, taskId] = process.argv.slice(2);
  if (!['bootstrap', 'prepare', 'plan', 'prepare-task', 'start', 'review', 'review-all'].includes(phase) || !configPath || process.argv.length < 4 || process.argv.length > 5) {
    throw new Error('usage: run-feature.mjs <bootstrap|prepare|plan|prepare-task|start|review|review-all> /absolute/run.json [planned-task-id]');
  }
  process.stdout.write(JSON.stringify(runFeature(parseStrictJson(readFileSync(configPath, 'utf8')), phase, taskId), null, 2) + '\n');
} catch (error) {
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
}
