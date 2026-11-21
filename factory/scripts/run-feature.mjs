#!/usr/bin/env node
// plan RUN --resume continues an interrupted, already mapped feature.
// A completed, applicable plan check is reused before queueing held tasks.
// --references accepts a JSON array of approved HTTPS source and digest pairs.
// Place the exact text at <run-directory>/sources/cited-<sha256 hex>.txt.
// Requires its unchanged config snapshot. Once planned.json exists, only its
// recorded operations are reconciled; authoring and queueing are never repeated.
// Attempt-specific evidence preserves the original failure; never delete markers.
// Each planning call writes live *-progress.json and final *-timing.json evidence.
import { readFileSync } from 'node:fs';
import { runFeature } from '../dist/src/feature-run.js';
import { parseStrictJson } from '../dist/src/strict-json.js';
try {
  const [phase, configPath, ...args] = process.argv.slice(2);
  const usage = 'usage: run-feature.mjs <bootstrap|prepare|plan|prepare-task|start|review|review-all> /absolute/run.json [planned-task-id|--resume] [--references /absolute/references.json (plan resume only)]\n' +
    '       run-feature.mjs review-pr /absolute/run.json <canonical-pr-url> <verified-head>';
  const references = phase === 'plan' && args.length === 3 && args[0] === '--resume' && args[1] === '--references';
  if (!configPath || (phase === 'review-pr' ? args.length !== 2 :
    !['bootstrap', 'prepare', 'plan', 'prepare-task', 'start', 'review', 'review-all'].includes(phase) || (args.length > 1 && !references))) {
    throw new Error(usage);
  }
  const config = parseStrictJson(readFileSync(configPath, 'utf8'));
  const approved = references ? parseStrictJson(readFileSync(args[2], 'utf8')) : undefined;
  const result = phase === 'review-pr' ? runFeature(config, phase, undefined, { url: args[0], head: args[1] }) :
    runFeature(config, phase, args[0], approved);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (phase === 'review-pr' && result.review?.outcome !== 'passed') process.exitCode = 1;
} catch (error) {
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
}
