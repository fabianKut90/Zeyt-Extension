#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DIST_DIR="$ROOT_DIR/dist"
ZIP_PATH="$ROOT_DIR/extension-upload.zip"

if [ ! -f "$DIST_DIR/manifest.json" ]; then
  echo "dist/manifest.json fehlt. Fuehre zuerst npm run build aus." >&2
  exit 1
fi

rm -f "$ZIP_PATH"

(
  cd "$DIST_DIR"
  zip -qr "$ZIP_PATH" . -x "*.DS_Store" "__MACOSX/*"
)

echo "Created $ZIP_PATH"
