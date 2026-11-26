#!/bin/sh
# Copy the agent feedback of the production server to this computer, to triage it here
# (docs/agent-feedback.md). It changes nothing on the server.
#
# Usage: sh deploy/feedback.sh [--data <folder>]
set -eu
SCRIPT_DIR=$(dirname "$0")
if [ -z "${LOOP_DEPLOY_HOST:-}" ] && [ -f "$SCRIPT_DIR/.env.deploy" ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env.deploy"
fi
HOST=${LOOP_DEPLOY_HOST:?Set LOOP_DEPLOY_HOST (for example in deploy/.env.deploy)}
cd "$SCRIPT_DIR/.."
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
ssh "$HOST" 'cd /opt/loop/app && DATA=$(sed -n "s/^LOOP_HUB_DATA=//p" /etc/loop/loop.env | tail -n 1) \
  && runuser -u loop -- node scripts/feedback.mjs export - --data "${DATA:?no LOOP_HUB_DATA in loop.env}"' > "$DIR/export.json"
node scripts/feedback.mjs import "$DIR/export.json" "$@"
