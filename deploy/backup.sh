#!/bin/sh
# Nightly consistent snapshot of Loop data onto the root disk so Hetzner's daily server
# backups include it (server backups do not cover attached volumes).
# Uses Node.js SQLite VACUUM INTO for consistent online SQLite snapshots and excludes
# plaintext vault.key by default (set LOOP_BACKUP_INCLUDE_KEY=1 only if you intentionally
# store keys in the same backup archive).
set -eu
# Set LOOP_DATA_DIR in the server environment if your Loop data lives on a mounted volume.
SRC="${LOOP_DATA_DIR:-/var/lib/loop/data}"
DST="${LOOP_BACKUP_DIR:-/var/backups/loop}"
mkdir -p "$DST" && chmod 700 "$DST"
STAGE=$(mktemp -d "${DST%/}/.stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
chmod 700 "$STAGE"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# Copy non-SQLite files first (skip live SQLite WAL/SHM files and, by default, vault.key)
KEY_EXCL="--exclude=vault.key"
if [ "${LOOP_BACKUP_INCLUDE_KEY:-0}" = "1" ]; then
  KEY_EXCL=""
fi
# shellcheck disable=SC2086
rsync -a \
  --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' \
  --exclude='*.tmp' $KEY_EXCL \
  "$SRC/" "$STAGE/"

# Take atomic online snapshots of every SQLite database via Node 22 node:sqlite VACUUM INTO
node -e '
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const [src, stage] = process.argv.slice(1);
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (ent.isFile() && ent.name.endsWith(".sqlite")) {
      const rel = path.relative(src, full);
      const dest = path.join(stage, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(full);
      try {
        db.exec("PRAGMA busy_timeout=5000;");
        db.exec(`VACUUM INTO \x27${dest.replace(/\x27/g, "\x27\x27")}\x27`);
      } finally {
        db.close();
      }
    }
  }
}
walk(src);
' "$SRC" "$STAGE"

tar -C "$STAGE" -czf "$DST/loop-data-$STAMP.tar.gz" .
chmod 600 "$DST/loop-data-$STAMP.tar.gz"
# keep 14 days
find "$DST" -name 'loop-data-*.tar.gz' -mtime +14 -delete
