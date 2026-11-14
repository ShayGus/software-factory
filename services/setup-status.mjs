#!/usr/bin/env node
// Temporary Claude status line, installed only while first-start setup runs.
// The session adapter restores the previous statusLine without changing its
// other settings. No service calls or model usage occur here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
try {
  const home = join(dirname(fileURLToPath(import.meta.url)), '..');
  const progress = JSON.parse(readFileSync(join(home, 'state/software-factory.setup-progress.json'), 'utf8'));
  console.log(`Software Factory: ${progress.phase} | ${Math.max(0, Math.floor((Date.now() - progress.started) / 1000))}s elapsed | first setup usually 5-15 minutes`);
} catch { console.log('Software Factory: preparing first-start setup'); }
