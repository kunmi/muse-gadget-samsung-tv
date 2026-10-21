#!/usr/bin/env bash
# Build dist/muse-gadget-tv.wgt from the static Tizen web app in app/.
#
# A .wgt is a zip with config.xml at the archive root. The package is NOT
# signed here: Apps2Samsung (and Tizen Studio's package manager) apply the
# Samsung developer certificate at install time. See BUILD.md.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP_DIR="$ROOT/app"
DIST_DIR="$ROOT/dist"
OUT="$DIST_DIR/muse-gadget-tv.wgt"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is required to build the .wgt" >&2
  exit 1
fi

# Syntax-check every app script before packaging (when Node is available).
if command -v node >/dev/null 2>&1; then
  for f in "$APP_DIR"/js/*.js; do
    node --check "$f"
  done
fi

# Zip the CONTENTS of app/ so config.xml lands at the .wgt root.
( cd "$APP_DIR" && zip -q -r "$OUT" . -x '*.DS_Store' )

echo "built $OUT"
unzip -l "$OUT" | grep -E 'config.xml|index.html' || true
