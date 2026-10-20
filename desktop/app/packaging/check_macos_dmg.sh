#!/usr/bin/env bash
# Prove a dmg really opens on this Mac: verify the ad-hoc signature inside the image, copy XScript.app out of it into a
# temp folder (never /Applications), then start it
#   1. directly (Contents/MacOS/XScript --selftest), and
#   2. through LaunchServices (`open -n -W`, as a double-click does) with --selftest,
#   3. with --gui: a normal windowed launch through LaunchServices; passes when the process is still up after a few
#      seconds and its log shows the page loaded, then the app is stopped by its pid.
# Every launch uses a temp --data-dir, so the user's own profile, saved devices and an installed copy stay untouched.
#   packaging/check_macos_dmg.sh dist/xscript-desktop-vX.Y.Z-macos-arm64.dmg [--gui] [expected-version]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dmg=$1; shift
gui=0
if [ "${1:-}" = --gui ]; then gui=1; shift; fi
want=${1:-$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/../pyproject.toml")}
bash "$here/verify_macos_app.sh" "$dmg"
root=$(cd "$(mktemp -d)" && pwd -P)  # /private/var/...: the path the process really runs from
mnt=$root/mnt
mkdir "$mnt"
cleanup() { hdiutil detach -quiet "$mnt" 2>/dev/null || true; rm -rf "$root"; }
trap cleanup EXIT
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
[ -L "$mnt/Applications" ] || { echo "the dmg has no Applications shortcut" >&2; exit 1; }
ditto "$mnt/XScript.app" "$root/XScript.app"
hdiutil detach -quiet "$mnt"
app=$root/XScript.app
v=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist")
id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist")
[ "$v" = "$want" ] || { echo "Info.plist version $v, expected $want" >&2; exit 1; }
[ "$id" = com.xscript.desktop ] || { echo "bundle id $id" >&2; exit 1; }
codesign --verify --deep --strict "$app"

ok() { grep -q '"selftest": "ok"' "$1" && grep -q "\"version\": \"$want\"" "$1"; }
"$app/Contents/MacOS/XScript" --selftest --timeout 90 --data-dir "$root/d1" --report "$root/direct.json" >/dev/null
ok "$root/direct.json" || { echo "direct selftest failed" >&2; cat "$root/direct.json" >&2; exit 1; }
echo "direct launch: $(cat "$root/direct.json")"
open -n -W "$app" --args --selftest --timeout 90 --data-dir "$root/d2" --report "$root/open.json"
ok "$root/open.json" || { echo "LaunchServices selftest failed" >&2; cat "$root/open.json" >&2 2>/dev/null; exit 1; }
echo "LaunchServices launch: $(cat "$root/open.json")"

if [ $gui = 1 ]; then
  open -n "$app" --args --data-dir "$root/d3" --size 1100x720
  pid=""
  for _ in $(seq 1 30); do
    pid=$(pgrep -f "^$app/Contents/MacOS/XScript" | head -1 || true)
    [ -n "$pid" ] && break; sleep 0.5
  done
  [ -n "$pid" ] || { echo "the app did not start" >&2; exit 1; }
  sleep 8
  kill -0 "$pid" 2>/dev/null || { echo "the app exited within 8 s" >&2; exit 1; }
  [ -d "$root/d3/web" ] || { echo "no web profile was created: the page did not load" >&2; kill "$pid"; exit 1; }
  echo "windowed launch: pid $pid still running after 8 s, page profile created"
  kill "$pid"
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
fi
echo "dmg opens ok: $dmg ($want, ad-hoc signed, not notarized)"
