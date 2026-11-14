#!/usr/bin/env bash
# Claude's factory session-open adapter. Provision a standalone factory before
# the normal FirstMate digest; other hosts, worktrees and acceptance children
# retain the ordinary run adapter. The installed path makes no service calls.
# Usage: fm-factory-sessionstart.sh (Claude SessionStart JSON on stdin)
# services/session-start.mjs owns setup progress, diagnostics and hook output.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=bin/fm-gate-refuse-lib.sh
. "$SCRIPT_DIR/fm-gate-refuse-lib.sh"
# shellcheck source=bin/fm-hook-host-lib.sh
. "$SCRIPT_DIR/fm-hook-host-lib.sh"

PAYLOAD=$(cat)
if fm_hook_payload_is_foreign_host "$PAYLOAD" || fm_is_gate_agent "$ROOT" \
  || [ ! -f "$ROOT/services/session-start.mjs" ] || [ ! -d "$ROOT/.git" ] || [ "${FM_HOME:-$ROOT}" != "$ROOT" ] \
  || [ "${SF_FACTORY_SETUP_ACTIVE:-}" = "$ROOT" ]; then
  exec "$SCRIPT_DIR/fm-sessionstart-run.sh" <<< "$PAYLOAD"
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '{"systemMessage":"Software Factory needs Node.js >=22.13. Install it from https://nodejs.org/en/download, then start claude again.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Factory setup could not start: Node.js >=22.13 is missing. Report the prerequisite and do not dispatch factory work until the next startup completes setup."}}'
  exit 0
fi
exec node "$ROOT/services/session-start.mjs" <<< "$PAYLOAD"
