#!/usr/bin/env bash
# Install the vsix into an isolated VS Code profile and run scripts/host-test inside the real extension host.
#   scripts/vscode-host-test.sh [/path/to/VS Code binary]   (needs `npm run package` first)
# The command flows (add/scan/edit devices, new project, run + re-run, stop, pull) talk to scripts/mock_device.py by
# default. Against a real phone / emulator instead:
#   adb -s emulator-5554 forward tcp:19860 tcp:9860
#   XS_HOST_TEST_DEVICE=127.0.0.1:19860 XS_HOST_TEST_REAL=1 XS_HOST_TEST_ADB=1 scripts/vscode-host-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${1:-}"
if [ -z "$BIN" ]; then
  # Real VS Code only (stable build from https://code.visualstudio.com/Download; unzip it anywhere and point
  # XS_VSCODE at ".../Visual Studio Code.app/Contents/MacOS/Code"). Everything runs in an isolated profile.
  for c in "${XS_VSCODE:-}" "/tmp/vscode-real/Visual Studio Code.app/Contents/MacOS/Code" "/Applications/Visual Studio Code.app/Contents/MacOS/Code"; do
    [ -n "$c" ] && [ -x "$c" ] && BIN="$c" && break
  done
fi
[ -x "$BIN" ] || { echo "no VS Code binary found: download it (curl -L -o vscode.zip https://update.code.visualstudio.com/latest/darwin-arm64/stable), unzip, and pass the Contents/MacOS/Code path or set XS_VSCODE"; exit 2; }
# the `code` CLI wrapper next to the app installs extensions headlessly (the Electron binary itself would open a window)
CLI="$(cd "$(dirname "$BIN")/../Resources/app/bin" 2>/dev/null && pwd)/code"
[ -x "$CLI" ] || { echo "no CLI wrapper at $CLI"; exit 2; }
VSIX=$(ls -t xscript-vscode-*.vsix 2>/dev/null | head -1); [ -n "$VSIX" ] || { echo "run: npm run package"; exit 2; }
T=$(mktemp -d); mkdir -p "$T/ud" "$T/ext" "$T/ws"; echo 'print("hi")' > "$T/ws/__init__.py"
MOCK_PID=""
if [ -z "${XS_HOST_TEST_DEVICE:-}" ]; then
  REPO="$(cd ../.. && pwd)"
  PYBIN="$REPO/.venv/bin/python"; [ -x "$PYBIN" ] || PYBIN=python3
  # port 9860 (the default) lets the LAN-scan check find the mock at 127.0.0.1; fall back to a free port without it
  for P in 9860 0; do
    "$PYBIN" -c "import sys, threading; sys.path.insert(0, sys.argv[1]); import mock_device; s = mock_device.serve('127.0.0.1', int(sys.argv[2])); print(s.server_address[1], flush=True); threading.Event().wait()" "$REPO/scripts" "$P" >"$T/mock.port" 2>"$T/mock.err" &
    MOCK_PID=$!
    for _ in $(seq 1 50); do [ -s "$T/mock.port" ] && break; sleep 0.1; done
    [ -s "$T/mock.port" ] && break
    kill "$MOCK_PID" 2>/dev/null || true
  done
  [ -s "$T/mock.port" ] || { echo "mock device did not start"; cat "$T/mock.err"; exit 2; }
  MOCK_PORT="$(cat "$T/mock.port")"
  export XS_HOST_TEST_DEVICE="127.0.0.1:$MOCK_PORT"
  [ "$MOCK_PORT" = "9860" ] && export XS_HOST_TEST_LAN_HOSTS="127.0.0.1"
fi
trap '[ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true' EXIT
"$CLI" --user-data-dir "$T/ud" --extensions-dir "$T/ext" --install-extension "$PWD/$VSIX" >/dev/null 2>&1
ls "$T/ext" | grep -q xscript || { echo "vsix did not install"; exit 1; }
echo "installed: $(ls "$T/ext" | grep xscript)"
XS_HOST_TEST_OUT="$T/result.json" "$BIN" --user-data-dir "$T/ud" --extensions-dir "$T/ext" --disable-workspace-trust --disable-gpu \
  --extensionDevelopmentPath="$T/ext/$(ls "$T/ext" | grep '^xscript\.')" --extensionTestsPath="$PWD/scripts/host-test/index.js" "$T/ws" >"$T/host.log" 2>&1 &
PID=$!
for _ in $(seq 1 180); do [ -s "$T/result.json" ] && break; sleep 1; done
kill "$PID" 2>/dev/null || true; pkill -f "$T/ud" 2>/dev/null || true
if [ -s "$T/result.json" ]; then
  python3 - "$T/result.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
for x in c: print(("PASS " if x["ok"] else "FAIL ") + x["what"] + ("  [" + str(x["extra"]) + "]" if x.get("extra") else ""))
sys.exit(0 if all(x["ok"] for x in c) else 1)
PY
else
  echo "no result written; host log tail:"; tail -20 "$T/host.log"; exit 1
fi
