#!/bin/sh
# Loop installer and updater for macOS and Linux.
#
# Usage:
#   curl -fsSL https://useloop.sh/install.sh | sh
#   LOOP_AGENTS_ONLY=1 curl -fsSL https://useloop.sh/install.sh | sh
#
# Environment variables:
#   LOOP_ORIGIN       Release server origin (default: https://useloop.sh)
#   LOOP_HOME         Install base directory (default: $HOME/.loop)
#   LOOP_BIN_DIR      CLI shim directory (default: $HOME/.local/bin)
#   LOOP_AGENTS_ONLY  Set to 1 to refresh only hosted agent skill and hook files
set -eu

DEFAULT_ORIGIN='__DEFAULT_LOOP_ORIGIN__'
case "$DEFAULT_ORIGIN" in
  http://*|https://*) ;;
  *) DEFAULT_ORIGIN='https://useloop.sh' ;;
esac

LOOP_ORIGIN="${LOOP_ORIGIN:-$DEFAULT_ORIGIN}"
LOOP_HOME="${LOOP_HOME:-$HOME/.loop}"
LOOP_BIN_DIR="${LOOP_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Error: %s is required to install Loop.\n' "$1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd node

if [ "${LOOP_AGENTS_ONLY:-0}" = "1" ]; then
  exec sh -c 'curl -fsSL "$1/connect.mjs" | node - --url "$1" --update' _ "$LOOP_ORIGIN"
fi

need_cmd tar
need_cmd npm

# Verify Node.js >= 22.13.0
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`Error: Loop requires Node.js 22.13.0 or newer (found ${process.versions.node}).`);
    process.exit(1);
  }
'

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loop-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

MANIFEST="$TMP/release.json"
printf 'Fetching release manifest from %s...\n' "$LOOP_ORIGIN"
curl -fsSL "$LOOP_ORIGIN/release.json" -o "$MANIFEST"

META=$(node -e '
  const fs = require("node:fs");
  const origin = new URL(process.argv[1]).origin;
  const m = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (!m.tarball || !m.tarball.url || !/^[0-9a-f]{64}$/i.test(String(m.tarball.sha256 || ""))) {
    console.error("Error: release.json does not include a verifiable release archive.");
    process.exit(1);
  }
  const u = new URL(m.tarball.url, origin);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    console.error("Error: release archive URL must use https://.");
    process.exit(1);
  }
  if (u.origin !== origin) {
    console.error("Error: release archive origin does not match LOOP_ORIGIN.");
    process.exit(1);
  }
  const tag = String(m.release || m.version || "latest")
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "latest";
  process.stdout.write(`${u.href}\n${m.tarball.sha256.toLowerCase()}\n${tag}\n${m.release || m.version || tag}\n`);
' "$LOOP_ORIGIN" "$MANIFEST")

TARBALL_URL=$(printf '%s\n' "$META" | sed -n '1p')
EXPECTED_SHA=$(printf '%s\n' "$META" | sed -n '2p')
SAFE_TAG=$(printf '%s\n' "$META" | sed -n '3p')
RELEASE_LABEL=$(printf '%s\n' "$META" | sed -n '4p')

ARCHIVE="$TMP/loop.tar.gz"
printf 'Downloading Loop %s...\n' "$RELEASE_LABEL"
curl -fsSL "$TARBALL_URL" -o "$ARCHIVE"

ACTUAL_SHA=$(node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(process.argv[1]));
  process.stdout.write(h.digest("hex"));
' "$ARCHIVE")

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  printf 'Error: SHA-256 mismatch (expected %s, got %s).\n' "$EXPECTED_SHA" "$ACTUAL_SHA" >&2
  exit 1
fi
printf 'Verified SHA-256 (%s).\n' "$ACTUAL_SHA"

APP_ROOT="$LOOP_HOME/app"
RELEASES_DIR="$APP_ROOT/releases"
STAGE_DIR="$RELEASES_DIR/.staging-$$"
mkdir -p "$STAGE_DIR"
tar -xzf "$ARCHIVE" -C "$STAGE_DIR"

printf 'Installing production dependencies...\n'
( cd "$STAGE_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

printf 'Verifying release loads cleanly...\n'
(
  cd "$STAGE_DIR"
  LOOP_NO_AGENT_HOOKS=1 LOOP_EMBEDDING_PROVIDER=off node --input-type=module -e 'await import("./server.mjs"); process.exit(0);'
)

DEST_DIR="$RELEASES_DIR/$SAFE_TAG"
if [ -e "$DEST_DIR" ]; then
  DEST_DIR="$RELEASES_DIR/${SAFE_TAG}-$(date +%s)"
fi
mv "$STAGE_DIR" "$DEST_DIR"

CURRENT_LINK="$APP_ROOT/current"
PREV_LINK="$APP_ROOT/previous"
if [ -L "$CURRENT_LINK" ]; then
  OLD_TARGET=$(node -e 'const fs = require("node:fs"); console.log(fs.realpathSync(process.argv[1]));' "$CURRENT_LINK" 2>/dev/null || true)
  if [ -n "$OLD_TARGET" ] && [ "$OLD_TARGET" != "$DEST_DIR" ]; then
    ln -sfn "$OLD_TARGET" "$PREV_LINK.tmp.$$"
    mv -f "$PREV_LINK.tmp.$$" "$PREV_LINK"
  fi
fi
ln -sfn "$DEST_DIR" "$CURRENT_LINK.tmp.$$"
mv -f "$CURRENT_LINK.tmp.$$" "$CURRENT_LINK"

mkdir -p "$LOOP_BIN_DIR"
SHIM="$LOOP_BIN_DIR/loop"
cat > "$SHIM.tmp.$$" <<EOF
#!/bin/sh
exec node "$CURRENT_LINK/scripts/loop-cli.mjs" "\$@"
EOF
chmod 755 "$SHIM.tmp.$$"
mv -f "$SHIM.tmp.$$" "$SHIM"

# Refresh hooks only in agents where Loop hooks are already enabled.
node "$CURRENT_LINK/scripts/loop-cli.mjs" status >/dev/null 2>&1 || true
if [ "$(uname -s)" = "Darwin" ] && launchctl print "gui/$(id -u)/local.loop-gateway" >/dev/null 2>&1; then
  printf 'Restarting Local Loop service gracefully...\n'
  sh "$CURRENT_LINK/scripts/restart-loop.sh" --when-idle || true
fi

printf '\nInstalled Loop %s into %s\n' "$RELEASE_LABEL" "$CURRENT_LINK"
printf 'CLI installed at: %s\n' "$SHIM"
case ":${PATH:-}:" in
  *":$LOOP_BIN_DIR:"*) ;;
  *) printf 'Add %s to your PATH: export PATH="%s:$PATH"\n' "$LOOP_BIN_DIR" "$LOOP_BIN_DIR" ;;
esac
printf 'Next steps: loop start | loop connect | loop update | loop rollback\n'
