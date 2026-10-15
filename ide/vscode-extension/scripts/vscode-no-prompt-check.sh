#!/usr/bin/env bash
# Proves the throw-away VS Code profile (scripts/vscode-env.sh) shows nothing that asks for a login: starts VS Code with
# it, waits for the window, then reads what the editor displays (DOM via --remote-debugging-port) and which macOS
# windows exist, and fails on any sign-in / welcome / chat / notification / dialog text or a keychain / Gatekeeper window.
#   scripts/vscode-no-prompt-check.sh [/path/to/VS Code binary]
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPTS/vscode-env.sh"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
env "${VSC_ENV[@]}" "$BIN" "${VSC_FLAGS[@]}" --remote-debugging-port="$PORT" "$T/ws" >"$T/host.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; pkill -f "$T/ud" 2>/dev/null || true; sleep 1; rm -rf "$T"' EXIT
for _ in $(seq 1 60); do curl -s "http://127.0.0.1:$PORT/json" 2>/dev/null | grep -q '"page"' && break; sleep 1; done
sleep 12   # let the workbench, built-in extensions and any startup prompts appear
UI=$(node "$SCRIPTS/host-test/dump-ui.js" "$PORT")
WIN=$(osascript -l JavaScript "$SCRIPTS/host-test/windows.js" 2>&1 | tail -1)
echo "ui:      $UI"; echo "windows: $WIN"
python3 - "$UI" "$WIN" <<'PY'
import json, re, sys
ui = json.loads(sys.argv[1]); win = json.loads(sys.argv[2])
bad = []
for k in ("notifications", "dialogs", "welcome", "chatPanel", "accounts", "visibleSignIn"):
    if ui.get(k): bad.append(f"{k}: {ui[k]}")
if re.search(r"welcome", ui.get("title", ""), re.I): bad.append("welcome tab is open")
bad += [f"macOS window {w}" for w in win if not w.startswith(("Code:", "Electron:"))]
print("FAIL " + "; ".join(bad) if bad else "PASS no sign-in, welcome, chat, notification, dialog, keychain or Gatekeeper window")
sys.exit(1 if bad else 0)
PY
