#!/usr/bin/env bash
# LCM hook runner - dispatches stdin to the appropriate Node.js hook handler
# Usage: run-hook.sh <hook-name>
#   hook-name: session-start | user-prompt-submit | stop | pre-compact | post-compact

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${PLUGIN_ROOT}/dist/hook-handlers"

HOOK_NAME="${1:-}"
if [ -z "$HOOK_NAME" ]; then
  echo "Usage: run-hook.sh <hook-name>" >&2
  exit 1
fi

HOOK_SCRIPT="${DIST_DIR}/${HOOK_NAME}.js"

if [ ! -f "$HOOK_SCRIPT" ]; then
  # Plugin not built yet — silently exit so Claude Code isn't blocked
  exit 0
fi

exec node "$HOOK_SCRIPT"
