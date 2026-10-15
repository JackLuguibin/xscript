#!/usr/bin/env bash
# Install the vsix into an isolated Cursor / VS Code profile and run scripts/host-test inside the real extension host.
#   scripts/cursor-host-test.sh [/path/to/Cursor|Code binary]   (needs `npm run package` first)
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${1:-}"
if [ -z "$BIN" ]; then
  for c in "/Applications/Cursor.app/Contents/MacOS/Cursor" "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"; do [ -x "$c" ] && BIN="$c" && break; done
fi
[ -x "$BIN" ] || { echo "no Cursor / VS Code binary found"; exit 2; }
# the `code` CLI wrapper next to the app installs extensions headlessly (the Electron binary itself would open a window)
CLI="$(cd "$(dirname "$BIN")/../Resources/app/bin" 2>/dev/null && pwd)/code"
[ -x "$CLI" ] || { echo "no CLI wrapper at $CLI"; exit 2; }
VSIX=$(ls -t xscript-vscode-*.vsix 2>/dev/null | head -1); [ -n "$VSIX" ] || { echo "run: npm run package"; exit 2; }
T=$(mktemp -d); mkdir -p "$T/ud" "$T/ext" "$T/ws"; echo 'print("hi")' > "$T/ws/__init__.py"
"$CLI" --user-data-dir "$T/ud" --extensions-dir "$T/ext" --install-extension "$PWD/$VSIX" >/dev/null 2>&1
ls "$T/ext" | grep -q xscript || { echo "vsix did not install"; exit 1; }
echo "installed: $(ls "$T/ext" | grep xscript)"
XS_HOST_TEST_OUT="$T/result.json" "$BIN" --user-data-dir "$T/ud" --extensions-dir "$T/ext" --disable-workspace-trust --disable-gpu \
  --extensionDevelopmentPath="$T/ext/$(ls "$T/ext" | grep '^xscript\.')" --extensionTestsPath="$PWD/scripts/host-test/index.js" "$T/ws" >"$T/host.log" 2>&1 &
PID=$!
for _ in $(seq 1 90); do [ -s "$T/result.json" ] && break; sleep 1; done
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
