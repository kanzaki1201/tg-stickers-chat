#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(echo ~/.npm-global/lib/node_modules/openclaw/dist/telegram-ingress-drain-factory-*.js)"
  if [ ! -f "$TARGET" ]; then
    echo "ERROR: no telegram-ingress-drain-factory-*.js found in dist" >&2
    exit 1
  fi
fi

if [ ! -f "$TARGET" ]; then
  echo "ERROR: file not found: $TARGET" >&2
  exit 1
fi

SENTINEL="/* patched: animated-sticker-frame-extraction */"

if grep -qF "$SENTINEL" "$TARGET"; then
  echo "ALREADY PATCHED: $TARGET"
  exit 0
fi

SKIP_PATTERN='if (sticker.is_animated || sticker.is_video) {'
if ! grep -qF "$SKIP_PATTERN" "$TARGET"; then
  echo "ERROR: skip pattern not found in $TARGET — file structure changed" >&2
  exit 1
fi

BACKUP="${TARGET}.orig-$(date +%Y%m%d)"
if [ ! -f "$BACKUP" ]; then
  cp "$TARGET" "$BACKUP"
  echo "BACKUP: $BACKUP"
fi

node "$(dirname "$0")/patch-animated-stickers.mjs" "$TARGET"
echo "PATCHED: $TARGET"
