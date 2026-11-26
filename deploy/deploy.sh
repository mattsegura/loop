#!/bin/sh
# Ship the current checkout to the production server and restart Loop.
set -eu
SCRIPT_DIR=$(dirname "$0")
if [ -z "${LOOP_DEPLOY_HOST:-}" ] && [ -f "$SCRIPT_DIR/.env.deploy" ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env.deploy"
fi
HOST=${LOOP_DEPLOY_HOST:?Set LOOP_DEPLOY_HOST (for example in deploy/.env.deploy)}
cd "$SCRIPT_DIR/.."
# Keep the running release so a bad deploy can be undone with: sh deploy/rollback.sh
ssh "$HOST" 'rm -rf /opt/loop/app.prev && cp -a /opt/loop/app /opt/loop/app.prev'
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '.env*' --exclude test \
  --exclude dev --exclude eval --exclude .sms-sim --exclude reports --exclude research_notes --exclude .claude \
  ./ "$HOST:/opt/loop/app/"
ssh "$HOST" 'set -e
  cd /opt/loop/app && npm ci --omit=dev --no-audit --no-fund >/dev/null
  chown -R root:loop /opt/loop/app && chmod -R g+rX,o-rwx /opt/loop/app
  systemctl restart loop
  for i in $(seq 1 30); do curl -fsS -o /dev/null -H "Host: useloop.sh" -H "X-Forwarded-Proto: https" http://127.0.0.1:8799/ && break; sleep 1; done
  systemctl is-active loop'
