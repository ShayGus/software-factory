#!/usr/bin/env bash
# Required factory locks for registered homes. No registry preserves Firstmate's
# existing path. A present registry with an unavailable checker fails closed.
# fm_factory_lock <start|merge|steer> <repository> <task-id> [<verified-head|worker-questions>]
# The steer action reads the exact message from stdin.
fm_factory_lock() {
  local registry="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}/software-factory.projects.json"
  local factory_root="$SCRIPT_DIR/../factory" settings="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}/software-factory.json"
  if [ -e "$settings" ] || [ -L "$settings" ]; then
    factory_root=$(jq -er '.factoryRoot | select(type == "string" and startswith("/"))' "$settings") || {
      echo 'error: factory checker location unavailable' >&2
      return 1
    }
    registry=$(jq -er --arg fallback "$registry" '(.hookRegistry // $fallback) | select(type == "string" and startswith("/"))' "$settings") || return 1
  fi
  if [ ! -e "$registry" ] && [ ! -L "$registry" ]; then
    if [ -e "$settings" ] || [ -L "$settings" ]; then
      echo 'error: installed factory registry unavailable' >&2
      return 1
    fi
    return 0
  fi
  node "$factory_root/scripts/factory-lock.mjs" "$1" "$registry" "$FM_HOME" "$2" "$3" "${4:-}"
}
