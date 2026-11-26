#!/bin/sh
set -eu

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

port=$(validate_port "${LOOP_HUB_PORT:-}")

service="gui/$(id -u)/local.loop-gateway"
loop_pid() { launchctl print "$service" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9]*\)$/\1/p' | head -n 1; }

# --when-idle: let agent calls that are running finish (at most 60 s) before Loop stops.
old_pid=$(loop_pid)
if [ "${1:-}" = "--when-idle" ] && [ -n "$old_pid" ] && launchctl kill SIGUSR2 "$service"; then
  waited=0
  while [ "$(loop_pid)" = "$old_pid" ] && [ "$waited" -lt 75 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  [ "$(loop_pid)" != "$old_pid" ] || launchctl kickstart -k "$service"
else
  launchctl kickstart -k "$service"
fi
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$port/health" 2>/dev/null | grep -Fq '"app":"loop-hub","ok":true'; then
    echo "Loop is ready at http://127.0.0.1:$port/"
    exit 0
  fi
  sleep 1
done
echo "Loop did not report healthy on port $port. Check launchctl print $service." >&2
exit 1
