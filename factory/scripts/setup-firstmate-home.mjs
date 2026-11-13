#!/usr/bin/env node
// Compatibility entry point: the source clone itself is now the complete home.
import { main } from '../../services/setup.mjs';
main().catch(error => { console.error(`Setup refused/failed: ${error.message}`); process.exitCode = 1; });
