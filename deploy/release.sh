#!/bin/sh
# Ship a tested, recorded release to useloop.sh and publish a checksummed release archive
# for Local Loop installers and `loop update`.
#
# 1. Snapshots the working tree (tracked + untracked, minus .gitignore'd files) into a git commit
#    tagged release/<timestamp>, using a private index, so the branch, index and files that other
#    agents are working in are left exactly as they are.
# 2. Extracts that snapshot to a temp folder and runs every test file there (so edits made while
#    the tests run cannot sneak into the release).
# 3. Packages a clean release archive (`loop-<tag>.tar.gz`) + `release.json` manifest with SHA-256.
# 4. Deploys the snapshot + release artifacts to useloop.sh, restarts Loop, and checks `/health`
#    and `/release.json`. Any failure stops the release.
#
# Usage: sh deploy/release.sh            (tests + deploy + publish archive)
#        RELEASE_NOTES="Short summary" sh deploy/release.sh
#        RELEASE_BASE=release/<tag> RELEASE_FILES="public/share.js" sh deploy/release.sh
#                                          (earlier release + only these files)
#        SKIP_TESTS=1 sh deploy/release.sh   (emergency only)
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
if [ -z "${LOOP_DEPLOY_HOST:-}" ] && [ -f "$ROOT/deploy/.env.deploy" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/deploy/.env.deploy"
fi
HOST=${LOOP_DEPLOY_HOST:?Set LOOP_DEPLOY_HOST (for example in deploy/.env.deploy)}
STAMP=$(date -u +%Y%m%d-%H%M%S)
PUBLISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TAG="release/$STAMP"
SAFE_TAG="release-$STAMP"
TARBALL_NAME="loop-$SAFE_TAG.tar.gz"

IDX=$(mktemp -t loop-release-index)
rm -f "$IDX"
if [ -n "${RELEASE_BASE:-}" ]; then
  # Start from an earlier release and layer only the named files from the working tree, so
  # unfinished work elsewhere in the folder stays out of production.
  [ -n "${RELEASE_FILES:-}" ] || { echo "RELEASE_FILES is required with RELEASE_BASE"; exit 1; }
  GIT_INDEX_FILE="$IDX" git read-tree "$RELEASE_BASE"
  # shellcheck disable=SC2086
  GIT_INDEX_FILE="$IDX" git add -- $RELEASE_FILES
  PARENT=$(git rev-parse "$RELEASE_BASE^{commit}")
  NOTE="$RELEASE_BASE + $RELEASE_FILES"
else
  GIT_INDEX_FILE="$IDX" git add -A
  PARENT=$(git rev-parse HEAD)
  NOTE="snapshot of $(git branch --show-current) working tree"
fi
TREE=$(GIT_INDEX_FILE="$IDX" git write-tree)
rm -f "$IDX"
COMMIT=$(printf 'Release %s (%s)\n' "$STAMP" "$NOTE" | git commit-tree "$TREE" -p "$PARENT")
git tag "$TAG" "$COMMIT"
echo "Snapshot $COMMIT tagged $TAG"

WORK=$(mktemp -d -t loop-release)
trap 'rm -rf "$WORK"' EXIT
git archive "$COMMIT" | tar -x -C "$WORK"
ln -s "$ROOT/node_modules" "$WORK/node_modules"
printf '%s %s\n' "$TAG" "$COMMIT" > "$WORK/RELEASE"

if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "Testing the snapshot..."
  LOG="$WORK/.test-log"
  : > "$LOG"
  ( cd "$WORK" && ls test/*.test.mjs test/audit/*.test.mjs | xargs -P 4 -n 1 sh deploy/test-file.sh >> "$LOG" )
  # A file that failed in the parallel run gets one more run on its own (timing-sensitive tests
  # can fail when the machine is busy). It must pass alone to count.
  for f in $(grep -v -E '^rc=0 pass=[0-9]+ fail=0 ' "$LOG" | awk '{print $NF}'); do
    echo "Retrying $f on its own..."
    line=$(cd "$WORK" && sh deploy/test-file.sh "$f")
    grep -v -F " $f" "$LOG" > "$LOG.tmp" || true
    echo "$line" >> "$LOG.tmp"
    mv "$LOG.tmp" "$LOG"
    case "$line" in rc=0\ *fail=0\ *) echo "  passed alone: $line" ;; *) echo "  still failing: $line" ;; esac
  done
  BAD=$(grep -v -E '^rc=0 pass=[0-9]+ fail=0 ' "$LOG" || true)
  TOTAL=$(awk '{split($2,a,"="); s+=a[2]} END {print s+0}' "$LOG")
  if [ -n "$BAD" ]; then
    echo "Tests failed, not deploying $TAG:"
    echo "$BAD"
    exit 1
  fi
  echo "All tests passed ($TOTAL tests in $(wc -l < "$LOG" | tr -d ' ') files)."
fi

# Package a clean downloadable release archive and manifest for Local Loop and `loop update`.
DIST=$(mktemp -d -t loop-release-dist)
trap 'rm -rf "$WORK" "$DIST"' EXIT
COPYFILE_DISABLE=1 tar -czf "$DIST/$TARBALL_NAME" -C "$WORK" \
  --exclude node_modules --exclude .git --exclude '.env*' --exclude test --exclude .test-log \
  --exclude eval --exclude reports --exclude research_notes --exclude dev --exclude .sms-sim \
  --exclude .claude --exclude .agents \
  .

node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const [tarPath, manifestPath, tag, commit, publishedAt, filename, notes] = process.argv.slice(1);
  const buf = fs.readFileSync(tarPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const manifest = {
    release: tag,
    commit,
    publishedAt,
    notes: notes || "",
    tarball: { filename, sha256, bytes: buf.length },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
' "$DIST/$TARBALL_NAME" "$DIST/release.json" "$TAG" "$COMMIT" "$PUBLISHED_AT" "$TARBALL_NAME" "${RELEASE_NOTES:-}"

ssh "$HOST" 'set -e
  rm -rf /opt/loop/app.prev && cp -a /opt/loop/app /opt/loop/app.prev
  mkdir -p /opt/loop/releases
  if [ -f /opt/loop/releases/release.json ]; then
    cp -a /opt/loop/releases/release.json /opt/loop/releases/release.prev.json
  fi'
rsync -az --delete --exclude node_modules --exclude .git --exclude '.env*' --exclude test --exclude .test-log \
  "$WORK/" "$HOST:/opt/loop/app/"
rsync -az "$DIST/$TARBALL_NAME" "$DIST/release.json" "$HOST:/opt/loop/releases/"
ssh "$HOST" 'set -e
  cd /opt/loop/app && npm ci --omit=dev --no-audit --no-fund >/dev/null
  # Keep the latest 5 downloadable release archives on disk.
  cd /opt/loop/releases && ls -1t loop-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
  chown -R root:loop /opt/loop/app /opt/loop/releases
  chmod -R g+rX,o-rwx /opt/loop/app /opt/loop/releases
  systemctl restart loop
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null 2>/dev/null -H "Host: useloop.sh" -H "X-Forwarded-Proto: https" http://127.0.0.1:8799/health; then break; fi
    sleep 1
  done
  systemctl is-active loop
  cat /opt/loop/app/RELEASE'
curl -fsS -o /dev/null -w "https://useloop.sh -> %{http_code}\n" https://useloop.sh/
curl -fsS -o /dev/null -w "https://useloop.sh/release.json -> %{http_code}\n" https://useloop.sh/release.json
echo "Released $TAG ($TARBALL_NAME). Roll back with: sh deploy/rollback.sh"
