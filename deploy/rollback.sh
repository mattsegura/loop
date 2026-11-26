#!/bin/sh
# Put the previous release and its release.json manifest back and restart Loop.
set -eu
SCRIPT_DIR=$(dirname "$0")
if [ -z "${LOOP_DEPLOY_HOST:-}" ] && [ -f "$SCRIPT_DIR/.env.deploy" ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env.deploy"
fi
HOST=${LOOP_DEPLOY_HOST:?Set LOOP_DEPLOY_HOST (for example in deploy/.env.deploy)}
ssh "$HOST" 'set -e
  test -d /opt/loop/app.prev
  rm -rf /opt/loop/app.bad
  mv /opt/loop/app /opt/loop/app.bad
  mv /opt/loop/app.prev /opt/loop/app
  if [ -f /opt/loop/releases/release.prev.json ]; then
    cp -a /opt/loop/releases/release.prev.json /opt/loop/releases/release.json
    chown root:loop /opt/loop/releases/release.json
    chmod 0640 /opt/loop/releases/release.json
  fi
  systemctl restart loop
  sleep 2
  systemctl is-active loop'
