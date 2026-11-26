#!/bin/bash
# Start the private workspace, or open the existing Hub if it's already serving.
set -eu
cd "$(dirname "$0")"

validate_port() {
  raw="$1"
  trimmed="$raw"
  while [ "${trimmed# }" != "$trimmed" ] || [ "${trimmed#	}" != "$trimmed" ]; do
    trimmed="${trimmed# }"
    trimmed="${trimmed#	}"
  done
  while [ "${trimmed% }" != "$trimmed" ] || [ "${trimmed%	}" != "$trimmed" ]; do
    trimmed="${trimmed% }"
    trimmed="${trimmed%	}"
  done
  if [ -z "$trimmed" ]; then
    printf '%s\n' '8799'
    return 0
  fi
  case "$trimmed" in
    *[!0-9]*)
      safe_raw=$(printf '%s' "$raw" | tr '\r\n' '  ')
      printf 'Invalid LOOP_HUB_PORT "%s": must be an integer between 1 and 65535.\n' "$safe_raw" >&2
      return 1
      ;;
  esac
  normalized="$trimmed"
  while [ "${normalized#0}" != "$normalized" ]; do
    normalized="${normalized#0}"
  done
  if [ -z "$normalized" ] || [ "${#normalized}" -gt 5 ] || [ "$normalized" -lt 1 ] || [ "$normalized" -gt 65535 ]; then
    safe_raw=$(printf '%s' "$raw" | tr '\r\n' '  ')
    printf 'Invalid LOOP_HUB_PORT "%s": must be an integer between 1 and 65535.\n' "$safe_raw" >&2
    return 1
  fi
  printf '%s\n' "$normalized"
}

PORT=$(validate_port "${LOOP_HUB_PORT:-}")
export LOOP_HUB_PORT="$PORT"
URL="http://127.0.0.1:$PORT"
if curl -fsS --connect-timeout 1 --max-time 2 "$URL/health" 2>/dev/null | grep -Fq '"app":"loop-hub"'; then
  if [ "${LOOP_NO_OPEN:-0}" != 1 ]; then open "$URL/"; fi
  echo "Loop Hub is already running at $URL/"; exit 0
fi
if curl -sS --connect-timeout 1 --max-time 2 -o /dev/null "$URL/" 2>/dev/null; then echo "Another application owns port $PORT. It was left untouched. Choose another LOOP_HUB_PORT or stop the old app."; exit 1; fi
NODE=''
for CANDIDATE in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.aside/runtime/node/bin/node"; do
  if [ -x "$CANDIDATE" ] && "$CANDIDATE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13))process.exit(1); require("node:sqlite")' >/dev/null 2>&1; then NODE="$CANDIDATE"; break; fi
done
if [ -z "$NODE" ]; then echo 'Loop Hub needs Node.js 22.13 or newer.'; read -r -p 'Press Return to close.' _ || true; exit 1; fi
if [ "${LOOP_NO_OPEN:-0}" != 1 ]; then
 (for _ in $(seq 1 40); do if curl -fsS --max-time 1 "$URL/health" 2>/dev/null | grep -Fq '"app":"loop-hub"'; then open "$URL/"; break; fi; sleep 0.2; done) &
fi
echo "Loop Hub: $URL/  (Ctrl-C to stop this server.)"
exec "$NODE" server.mjs
