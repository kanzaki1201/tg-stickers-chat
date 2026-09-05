#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$HOME/.openclaw/openclaw.json"
SNAPSHOT="$HOME/.openclaw/openclaw.json.pre-update-script"
PHASE_FAIL=""

mark_fail() { PHASE_FAIL="${PHASE_FAIL:+$PHASE_FAIL }$1"; }
phase_failed() { [[ " $PHASE_FAIL " == *" $1 "* ]]; }

banner() { printf '\n=== %s ===\n' "$1"; }

check_json() {
  python3 -c "
import sys, json
with open('$CONFIG') as f:
    d = json.load(f)

fails = []

def get(path):
    obj = d
    for k in path.split('.'):
        if isinstance(obj, dict):
            obj = obj.get(k)
        elif isinstance(obj, list):
            try: obj = obj[int(k)]
            except (ValueError, IndexError): return None
        else:
            return None
    return obj

def need_in_list(path, val):
    lst = get(path)
    if not isinstance(lst, list) or val not in lst:
        fails.append(f'  FAIL: {path} must contain \"{val}\"')

def need_eq(path, val):
    actual = get(path)
    if actual != val:
        fails.append(f'  FAIL: {path} == {json.dumps(actual)}, expected {json.dumps(val)}')

def need_nonempty(path):
    v = get(path)
    if not v:
        fails.append(f'  FAIL: {path} is empty or missing')

for name in ['tg-stickers-chat', 'memory-core', 'telegram', 'deepseek', 'openai']:
    need_in_list('plugins.allow', name)

need_in_list('plugins.load.paths', '/home/k/ClaudeCodeRemoteSessions/tg-stickers-chat')

need_eq('plugins.entries.tg-stickers-chat.enabled', True)
need_nonempty('plugins.entries.tg-stickers-chat.config.embeddingApiKey')
need_eq('plugins.entries.tg-stickers-chat.hooks.allowConversationAccess', True)
need_eq('plugins.entries.tg-stickers-chat.hooks.allowPromptInjection', True)

need_in_list('agents.defaults.modelPolicy.allow', 'deepseek/*')
need_in_list('agents.defaults.modelPolicy.allow', 'openai/*')

need_eq('agents.defaults.heartbeat.model', 'deepseek/deepseek-v4-pro')

found_vision = False
models = get('models.providers.deepseek.models') or []
for m in models:
    if isinstance(m, dict) and m.get('id') == 'deepseek-v4-flash-vision-exp':
        found_vision = True
        if m.get('api') != 'openai-completions':
            fails.append(f'  FAIL: vision model api == {json.dumps(m.get(\"api\"))}, expected \"openai-completions\"')
        inp = m.get('input', [])
        if 'image' not in inp:
            fails.append(f'  FAIL: vision model input missing \"image\"')
        thinking_type = (m.get('params') or {}).get('thinking', {}).get('type')
        if thinking_type != 'disabled':
            fails.append(f'  FAIL: vision model params.thinking.type == {json.dumps(thinking_type)}, expected \"disabled\"')
if not found_vision:
    fails.append('  FAIL: models.providers.deepseek.models missing entry deepseek-v4-flash-vision-exp')

need_eq('channels.telegram.actions.sticker', True)

need_nonempty('env.vars.DEEPSEEK_API_KEY')
need_nonempty('env.vars.OPENAI_API_KEY')

need_eq('models.providers.deepseek.baseUrl', 'https://api.deepseek.com')

flash_ids = [m.get('id') for m in models if isinstance(m, dict)]
for want in ['deepseek-v4-flash', 'deepseek-v4-pro']:
    if want not in flash_ids:
        fails.append(f'  FAIL: models.providers.deepseek.models missing entry {want}')

need_eq('plugins.entries.deepseek.enabled', True)
need_eq('plugins.entries.openai.enabled', True)

need_nonempty('memory.search.remote.apiKey')

if fails:
    for f in fails:
        print(f)
    sys.exit(1)
else:
    print('  All invariants passed.')
" 2>&1
}

banner "PRE-UPDATE"
cp "$CONFIG" "$SNAPSHOT"
echo "Snapshot: $SNAPSHOT"
echo "openclaw: $(openclaw --version 2>&1)"
echo "node:     $(node --version 2>&1)"

banner "UPDATE"
systemctl --user stop openclaw-gateway.service 2>/dev/null || true
echo "Gateway stopped for update"
UPDATE_OUT=$(openclaw update --yes --accept-capabilities --no-restart 2>&1) && UPDATE_RC=0 || UPDATE_RC=$?
echo "$UPDATE_OUT"
if [ "$UPDATE_RC" -ne 0 ]; then
  if echo "$UPDATE_OUT" | grep -qF "openclaw doctor"; then
    echo "Running openclaw doctor --fix..."
    if ! openclaw doctor --fix 2>&1; then
      echo "Doctor failed, aborting"
      exit 1
    fi
  else
    echo "Update failed (exit $UPDATE_RC)"
    exit 1
  fi
fi

banner "INVARIANTS"
if ! check_json; then
  mark_fail INVARIANTS
fi

banner "RE-APPLY PATCHES"
PATCH_OUT=$("$SCRIPT_DIR/patch-openclaw-dist.sh" 2>&1) && PATCH_RC=0 || PATCH_RC=$?
echo "$PATCH_OUT"
if [ "$PATCH_RC" -ne 0 ]; then
  if echo "$PATCH_OUT" | grep -qiF "ALREADY PATCHED"; then
    :
  else
    echo "Patch failed (exit $PATCH_RC)"
    mark_fail PATCHES
  fi
fi

if ! (cd "$REPO_ROOT" && node -e "require('better-sqlite3')" 2>/dev/null); then
  echo "better-sqlite3 not loadable, rebuilding..."
  (cd "$REPO_ROOT" && npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3)
  if ! (cd "$REPO_ROOT" && node -e "require('better-sqlite3')" 2>/dev/null); then
    echo "better-sqlite3 still broken after rebuild"
    mark_fail PATCHES
  else
    echo "better-sqlite3 rebuilt OK"
  fi
else
  echo "better-sqlite3 OK"
fi

banner "RESTART + ASSERT"
systemctl --user restart openclaw-gateway.service
echo "Service restarted, waiting for ready..."

READY=0
for i in $(seq 1 18); do
  sleep 5
  LOGS=$(journalctl --user -u openclaw-gateway.service --since "60 seconds ago" --no-pager 2>&1)
  if echo "$LOGS" | grep -qF "[gateway] ready"; then
    READY=1
    echo "Gateway ready after ~$((i * 5))s"
    break
  fi
done

if [ "$READY" -eq 0 ]; then
  echo "Gateway did not become ready within 90s"
  mark_fail RESTART
else
  BOOT_LOGS=$(journalctl --user -u openclaw-gateway.service --since "120 seconds ago" --no-pager 2>&1)
  if echo "$BOOT_LOGS" | grep -qF "4 plugins:" && echo "$BOOT_LOGS" | grep -qF "tg-stickers-chat"; then
    echo "Plugin load confirmed: 4 plugins with tg-stickers-chat"
  else
    echo "Plugin load assertion failed"
    echo "Boot log excerpt:"
    echo "$BOOT_LOGS" | grep -i "plugin" || true
    mark_fail RESTART
  fi

  if echo "$BOOT_LOGS" | grep -qF "[Stickers] Loaded"; then
    echo "Sticker index loaded"
  else
    echo "[Stickers] Loaded not found in boot log"
    mark_fail RESTART
  fi
fi

if ! phase_failed RESTART; then
  echo "Running sticker stats probe..."
  PROBE_OUT=$(openclaw agent --agent main --session-id update-check \
    -m "Call the tool get_sticker_stats and reply with its raw JSON output only. No sticker sending." \
    --json --timeout 120 2>&1) && PROBE_RC=0 || PROBE_RC=$?
  if echo "$PROBE_OUT" | grep -qE "indexed_stickers|张表情包"; then
    echo "Sticker stats probe passed"
  else
    echo "Sticker stats probe failed (exit $PROBE_RC):"
    echo "$PROBE_OUT" | tail -20
    mark_fail RESTART
  fi
fi

banner "REPORT"
echo "--- CONFIG DIFF ---"
DIFF_OUT=$(diff -u --label pre-update "$SNAPSHOT" --label post-update "$CONFIG" 2>&1) && true
if [ -z "$DIFF_OUT" ]; then
  echo "(no config changes)"
else
  echo "$DIFF_OUT"
fi
echo "-------------------"

echo ""
for phase in PRE UPDATE INVARIANTS PATCHES RESTART; do
  if phase_failed "$phase"; then
    printf '  %-12s FAIL\n' "$phase"
  else
    printf '  %-12s PASS\n' "$phase"
  fi
done

echo ""
if [ -n "$PHASE_FAIL" ]; then
  echo "RESULT: FAIL ($PHASE_FAIL)"
  exit 1
else
  echo "RESULT: PASS"
fi
