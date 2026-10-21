#!/usr/bin/env bash
# Regenerates the README screenshots (docs/images/vscode-*.png) from the real VS Code in the hardened throw-away profile
# (scripts/vscode-env.sh), connected to a device (emulator / phone) through adb forward, using a clean demo project.
# No Screen Recording permission needed: the pictures come from the DevTools protocol (--remote-debugging-port).
#   adb -s emulator-5554 forward tcp:19860 tcp:9860
#   XS_SHOT_DEVICE=127.0.0.1:19860 scripts/vscode-screenshots.sh [out-dir]      (needs `npm run package` first)
# XS_SHOT_NAMES picks the pictures (default "run debug"). "connect" is the step-by-step connection check: force-stop
# XScript on the device first (adb shell am force-stop <app id>) so the check stops at "XScript app answers". "capture" is
# the status bar warning for a lost screen-recording grant: turn accessibility off, force-stop XScript and open it again.
# A device that needs its pairing code: set XS_SHOT_CODE (typed into the Pair box through DevTools; the throw-away
# profile uses a mock keychain, and the code is not passed to VS Code's environment).
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPTS/.."
OUT="${1:-$PWD/../../docs/images}"; set --   # vscode-env.sh reads $1 as the VS Code binary; use XS_VSCODE here
source "$SCRIPTS/vscode-env.sh"
: "${XS_SHOT_DEVICE:?set XS_SHOT_DEVICE=127.0.0.1:<forwarded port of the device>}"
VSIX=$(ls -t xscript-vscode-*.vsix 2>/dev/null | head -1); [ -n "$VSIX" ] || { echo "run: npm run package"; exit 2; }
env "${VSC_ENV[@]}" "$CLI" --user-data-dir "$T/ud" --extensions-dir "$T/ext" --install-extension "$PWD/$VSIX" >/dev/null 2>&1
# clean demo project (the folder name is the project name on the device)
P="$T/xs_demo"; mkdir -p "$P"
cat > "$P/__init__.py" <<'PY'
import time


def greet(name):
    return "你好，" + name


print(greet("XScript"))
total = 0
for i in range(1, 31):
    total += i
    print("第 %d 秒，累计 %d" % (i, total), flush=True)
    time.sleep(1)
print("完成", flush=True)
PY
printf '# XScript 演示工程\n' > "$P/build.as"
# window look: dark theme, no minimap / breadcrumbs, bigger text so it stays readable at README width
python3 - "$T/ud/User/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s.update({"workbench.colorTheme": "Default Dark Modern", "editor.minimap.enabled": False, "breadcrumbs.enabled": False,
          "editor.fontSize": 14, "workbench.layoutControl.enabled": False, "window.commandCenter": False,
          "workbench.statusBar.visible": True, "terminal.integrated.fontSize": 13, "debug.toolBarLocation": "docked",
          "explorer.openEditors.visible": 0, "workbench.activityBar.location": "default"})
json.dump(s, open(p, "w"), indent=2)
PY
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
mkdir -p "$T/shots"
NAMES="${XS_SHOT_NAMES:-run debug}"
PAIR=0; [ -n "${XS_SHOT_CODE:-}" ] && PAIR=1
XS_SHOT_PAIR="$PAIR" XS_SHOT_NAMES="$NAMES" XS_SHOT_DIR="$T/shots" XS_SHOT_DEVICE="$XS_SHOT_DEVICE" env -u XS_SHOT_CODE "${VSC_ENV[@]}" "$BIN" "${VSC_FLAGS[@]}" --remote-debugging-port="$PORT" \
  --extensionDevelopmentPath="$T/ext/$(ls "$T/ext" | grep '^xscript\.')" --extensionTestsPath="$SCRIPTS/screenshots/driver.js" "$P" >"$T/host.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; pkill -f "$T/ud" 2>/dev/null || true' EXIT
CAPTURE_NAMES="$NAMES"; [ "$PAIR" = 1 ] && CAPTURE_NAMES="type-pair $NAMES"
# shellcheck disable=SC2086
node "$SCRIPTS/screenshots/capture.js" "$PORT" "$T/shots" $CAPTURE_NAMES
for _ in $(seq 1 60); do [ -s "$T/shots/result" ] && break; sleep 1; done
cat "$T/shots/result"; echo
mkdir -p "$OUT"
for n in $NAMES; do cp "$T/shots/$n.png" "$OUT/vscode-$n.png"; echo "wrote $OUT/vscode-$n.png"; done
[ -z "${XS_HOST_TEST_KEEP:-}" ] && { sleep 1; rm -rf "$T"; } || echo "kept $T"
