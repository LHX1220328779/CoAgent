#!/usr/bin/env bash
set -euo pipefail
COAGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$COAGENT_ROOT"
COAGENT_NODE="$(command -v node || true)"
if [[ -z "$COAGENT_NODE" ]] || [[ "$("$COAGENT_NODE" -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  COAGENT_NODE=""
  for COAGENT_CANDIDATE in "$HOME"/.nvm/versions/node/v24*/bin/node; do
    if [[ -x "$COAGENT_CANDIDATE" ]]; then COAGENT_NODE="$COAGENT_CANDIDATE"; fi
  done
fi
if [[ -z "$COAGENT_NODE" ]]; then
  if command -v zenity >/dev/null 2>&1; then zenity --error --text='CoAgent 需要 Node.js 24，请先安装后重试。'; fi
  echo 'CoAgent ACP 需要 Node.js 24' >&2
  exit 1
fi
export PATH="$(dirname -- "$COAGENT_NODE"):$PATH"
umask 077
exec "$COAGENT_NODE" --env-file-if-exists=.env src/cli.ts acp
