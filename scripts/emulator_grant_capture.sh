#!/usr/bin/env bash
# Grant XScript's screen-capture (图色) permission on an emulator without touching the screen:
#   scripts/emulator_grant_capture.sh [adb-serial] [package]     package defaults to com.xscript.app; another build id
#   (e.g. com.xscript.app.perf) works too: the launcher activity keeps its class name com.xscript.app.LauncherActivity.
# The system MediaProjection consent dialog cannot be pre-granted with `appops`/`pm grant`, so this opens
# the app, taps the 图色权限 row and answers whatever dialog this Android version shows
# ("Start now", or "Share one app" -> "Share entire screen" -> "Share screen"). Needs adb + python3.
set -euo pipefail
SERIAL="${1:-}"
PKG="${2:-com.xscript.app}"
ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

# tap_text TEXT [exact]: tap the first UI node whose text contains (or equals) TEXT; non-zero when absent.
tap_text() {
  "${ADB[@]}" shell uiautomator dump /sdcard/xs_ui.xml >/dev/null 2>&1
  "${ADB[@]}" shell cat /sdcard/xs_ui.xml | python3 -c '
import html, re, subprocess, sys
want, exact, adb = sys.argv[1], sys.argv[2] == "1", sys.argv[3:]
xml = sys.stdin.read()
for m in re.finditer(r"<node [^>]*>", xml):
    n = m.group(0)
    text = html.unescape(re.search(r"text=\"([^\"]*)\"", n).group(1))
    if (text == want) if exact else (want in text):
        x1, y1, x2, y2 = map(int, re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", n).groups())
        subprocess.run(adb + ["shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2)], check=True)
        sys.exit(0)
sys.exit(1)
' "$1" "${2:-0}" "${ADB[@]}"
}

"${ADB[@]}" shell am start -n "$PKG/com.xscript.app.LauncherActivity" >/dev/null
sleep 3
# the row can sit below the fold (e.g. on a fresh install): scroll down a few times to find it
found=0
for _ in 1 2 3 4 5; do
  sleep 1
  tap_text 图色权限 && { found=1; break; }
  "${ADB[@]}" shell input swipe 540 1600 540 700 300
done
[ "$found" = 1 ] || { echo "图色权限 row not found (is $PKG the XScript home screen?)" >&2; exit 1; }
sleep 3
if tap_text "Start now" 1; then
  :
elif tap_text "Share one app" 1; then
  sleep 1
  tap_text "Share entire screen" || tap_text "entire screen"
  sleep 1
  tap_text "Share screen" 1
else
  echo "no consent dialog found: already granted, or an unknown Android version" >&2
fi
sleep 3
echo "done; check: curl http://127.0.0.1:<forwarded port>/status  ->  capture: true"
