#!/usr/bin/env bash
# Install the vsix into an isolated VS Code profile and run scripts/host-test inside the real extension host.
#   scripts/vscode-host-test.sh [/path/to/VS Code binary]   (needs `npm run package` first)
# The command flows (add/scan/edit devices, new project, run + re-run, stop, pull) talk to scripts/mock_device.py by
# default. Against a real phone / emulator instead:
#   adb -s emulator-5554 forward tcp:19860 tcp:9860
#   XS_HOST_TEST_DEVICE=127.0.0.1:19860 XS_HOST_TEST_REAL=1 XS_HOST_TEST_ADB=1 scripts/vscode-host-test.sh
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPTS/.."
# shellcheck source=vscode-env.sh
source "$SCRIPTS/vscode-env.sh"
VSIX=$(ls -t xscript-vscode-*.vsix 2>/dev/null | head -1); [ -n "$VSIX" ] || { echo "run: npm run package"; exit 2; }
MOCK_PID=""
if [ -z "${XS_HOST_TEST_DEVICE:-}" ]; then
  REPO="$(cd ../.. && pwd)"
  PYBIN="$REPO/.venv/bin/python"; [ -x "$PYBIN" ] || PYBIN=python3
  # with debugpy available (e.g. python3 -m venv .venv && .venv/bin/pip install debugpy, here in ide/vscode-extension)
  # the mock also serves the debug bridge, so the VS Code debug-session checks run without a phone
  MOCK="import mock_device as m"
  for C in "$PWD/.venv/bin/python" "$PYBIN"; do
    if [ -x "$C" ] && "$C" -c "import debugpy" 2>/dev/null; then
      PYBIN="$C"; MOCK="sys.path.insert(0, '$SCRIPTS/host-test'); import debug_mock as m"; export XS_HOST_TEST_DEBUG=1; break
    fi
  done
  [ -n "${XS_HOST_TEST_DEBUG:-}" ] || echo "note: no debugpy found, the debug-session checks are skipped (see the comment above)"
  # port 9860 (the default) lets the LAN-scan check find the mock at 127.0.0.1; fall back to a free port without it
  for P in 9860 0; do
    "$PYBIN" -c "import sys, threading; sys.path.insert(0, sys.argv[1]); $MOCK; s = m.serve('127.0.0.1', int(sys.argv[2])); print(s.server_address[1], flush=True); threading.Event().wait()" "$REPO/scripts" "$P" >"$T/mock.port" 2>"$T/mock.err" &
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
trap '[ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; pkill -f "debugpy --listen 127.0.0.1:[0-9]* --wait-for-client .*xs-remote-" 2>/dev/null || true' EXIT
env "${VSC_ENV[@]}" "$CLI" --user-data-dir "$T/ud" --extensions-dir "$T/ext" --install-extension "$PWD/$VSIX" >/dev/null 2>&1
ls "$T/ext" | grep -q xscript || { echo "vsix did not install"; exit 1; }
echo "installed: $(ls "$T/ext" | grep xscript)"
XS_HOST_TEST_OUT="$T/result.json" env "${VSC_ENV[@]}" "$BIN" "${VSC_FLAGS[@]}" \
  --extensionDevelopmentPath="$T/ext/$(ls "$T/ext" | grep '^xscript\.')" --extensionTestsPath="$PWD/scripts/host-test/index.js" "$T/ws" >"$T/host.log" 2>&1 &
PID=$!
for _ in $(seq 1 180); do [ -s "$T/result.json" ] && break; sleep 1; done
kill "$PID" 2>/dev/null || true; pkill -f "$T/ud" 2>/dev/null || true
if [ -s "$T/result.json" ]; then
  RC=0
  python3 - "$T/result.json" <<'PY' || RC=$?
import json, sys
c = json.load(open(sys.argv[1]))
for x in c: print(("PASS " if x["ok"] else "FAIL ") + x["what"] + ("  [" + str(x["extra"]) + "]" if x.get("extra") else ""))
sys.exit(0 if all(x["ok"] for x in c) else 1)
PY
  [ "$RC" = 0 ] && [ -z "${XS_HOST_TEST_KEEP:-}" ] && rm -rf "$T"; exit $RC
else
  echo "no result written; host log tail:"; tail -20 "$T/host.log"; exit 1
fi
