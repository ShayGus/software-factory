#!/usr/bin/env node
// plan RUN --resume continues an interrupted, already mapped feature.
// A completed, applicable plan check is reused before queueing held tasks.
// --references accepts a JSON array of approved HTTPS source and digest pairs.
// Place the exact text at <run-directory>/sources/cited-<sha256 hex>.txt.
// Requires its unchanged config snapshot. Once planned.json exists, only its
// recorded operations are reconciled; authoring and queueing are never repeated.
// Attempt-specific evidence preserves the original failure; never delete markers.
import { readFileSync } from 'node:fs';
import { runFeature } from '../dist/src/feature-run.js';
import { parseStrictJson } from '../dist/src/strict-json.js';
try {
  const [phase, configPath, taskId, referencesFlag, referencesPath] = process.argv.slice(2);
  const references = referencesFlag === '--references' && referencesPath && phase === 'plan' && taskId === '--resume' && process.argv.length === 7;
  if (!['bootstrap', 'prepare', 'plan', 'prepare-task', 'start', 'review', 'review-all'].includes(phase) || !configPath ||
    (process.argv.length > 5 && !references)) {
    throw new Error('usage: run-feature.mjs <bootstrap|prepare|plan|prepare-task|start|review|review-all> /absolute/run.json [planned-task-id|--resume] [--references /absolute/references.json (plan resume only)]');
  }
  const approved = references ? parseStrictJson(readFileSync(referencesPath, 'utf8')) : undefined;
  process.stdout.write(JSON.stringify(runFeature(parseStrictJson(readFileSync(configPath, 'utf8')), phase, taskId, approved), null, 2) + '\n');
} catch (error) {
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
}
