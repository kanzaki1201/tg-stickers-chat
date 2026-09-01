#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
FAILED=0

# --- Target 1: telegram-ingress-drain-factory (animated stickers) ---

TARGET1="${1:-}"
if [ -z "$TARGET1" ]; then
  TARGET1="$(echo ~/.npm-global/lib/node_modules/openclaw/dist/telegram-ingress-drain-factory-*.js)"
  if [ ! -f "$TARGET1" ]; then
    echo "ERROR: no telegram-ingress-drain-factory-*.js found in dist" >&2
    exit 1
  fi
fi

if [ ! -f "$TARGET1" ]; then
  echo "ERROR: file not found: $TARGET1" >&2
  exit 1
fi

SENTINEL1="/* patched: animated-sticker-frame-extraction */"

if grep -qF "$SENTINEL1" "$TARGET1"; then
  echo "ALREADY PATCHED: $TARGET1"
else
  SKIP_PATTERN='if (sticker.is_animated || sticker.is_video) {'
  if ! grep -qF "$SKIP_PATTERN" "$TARGET1"; then
    echo "ERROR: skip pattern not found in $TARGET1 — file structure changed" >&2
    FAILED=1
  else
    BACKUP1="${TARGET1}.orig-$(date +%Y%m%d)"
    if [ ! -f "$BACKUP1" ]; then
      cp "$TARGET1" "$BACKUP1"
      echo "BACKUP: $BACKUP1"
    fi
    if node "$SCRIPT_DIR/patch-animated-stickers.mjs" "$TARGET1"; then
      echo "PATCHED: $TARGET1"
    else
      FAILED=1
    fi
  fi
fi

# --- Target 2: sticker-cache (describe budget) ---

TARGET2="${2:-}"
if [ -z "$TARGET2" ]; then
  TARGET2=""
  for f in ~/.npm-global/lib/node_modules/openclaw/dist/sticker-cache-*.js; do
    case "$f" in
      *sticker-cache-store*) continue ;;
    esac
    TARGET2="$f"
    break
  done
  if [ -z "$TARGET2" ] || [ ! -f "$TARGET2" ]; then
    echo "ERROR: no sticker-cache-*.js (excluding store) found in dist" >&2
    exit 1
  fi
fi

if [ ! -f "$TARGET2" ]; then
  echo "ERROR: file not found: $TARGET2" >&2
  exit 1
fi

SENTINEL2="/* patched: sticker-describe-budget */"

if grep -qF "$SENTINEL2" "$TARGET2"; then
  echo "ALREADY PATCHED: $TARGET2"
else
  BACKUP2="${TARGET2}.orig-$(date +%Y%m%d)"
  if [ ! -f "$BACKUP2" ]; then
    cp "$TARGET2" "$BACKUP2"
    echo "BACKUP: $BACKUP2"
  fi
  if node "$SCRIPT_DIR/patch-sticker-describe.mjs" "$TARGET2"; then
    echo "PATCHED: $TARGET2"
  else
    FAILED=1
  fi
fi

exit "$FAILED"
