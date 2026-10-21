#!/usr/bin/env bash
# Install a setup.exe silently into a temporary folder (per user), run --selftest from the installed XScript.exe,
# check the Start-menu shortcut and the version, then uninstall silently and check the folder is gone.
#   packaging/check_windows_install.sh dist/xscript-desktop-vX.Y.Z-windows-x64-setup.exe [expected-version]
# Git Bash on Windows (CI). Never installs into Program Files and leaves nothing behind.
set -euo pipefail
setup=$1
want=${2:-$(sed -n 's/^version = "\(.*\)"/\1/p' "$(dirname "$0")/../pyproject.toml")}
root=$(mktemp -d)
dir=$root/XScript
export MSYS2_ARG_CONV_EXCL='*'
"$setup" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER "/DIR=$(cygpath -w "$dir")" "/LOG=$(cygpath -w "$root/install.log")"
[ -x "$dir/XScript.exe" ] || { echo "XScript.exe missing after install" >&2; cat "$root/install.log" >&2 || true; exit 1; }
lnk="$APPDATA/Microsoft/Windows/Start Menu/Programs/XScript.lnk"
[ -f "$lnk" ] || { echo "Start-menu shortcut missing: $lnk" >&2; exit 1; }
"$dir/XScript.exe" --selftest --timeout 90 --report "$(cygpath -w "$root/selftest.json")"
cat "$root/selftest.json"; echo
grep -q '"selftest": "ok"' "$root/selftest.json" || { echo "selftest did not pass" >&2; exit 1; }
grep -q "\"version\": \"$want\"" "$root/selftest.json" || { echo "installed version is not $want" >&2; exit 1; }
# the bundled adb (issue #213) is installed, is the one the app picks, and runs; its server must not block the uninstall
adb="$dir/_internal/platform-tools/adb.exe"
[ -x "$adb" ] && [ -f "$dir/_internal/platform-tools/NOTICE.txt" ] || { echo "bundled adb / NOTICE.txt missing" >&2; exit 1; }
grep -q 'platform-tools\\\\adb.exe"' "$root/selftest.json" || { echo "the app does not use the bundled adb" >&2; exit 1; }
"$adb" version
"$adb" start-server
du -sh "$dir" || true
"$dir/unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
# the uninstaller re-launches itself from %TEMP% and returns at once: wait for it to finish
for _ in $(seq 1 60); do [ -e "$dir/XScript.exe" ] || break; sleep 1; done
[ ! -e "$dir/XScript.exe" ] || { echo "uninstall left XScript.exe behind" >&2; exit 1; }
for _ in $(seq 1 30); do [ -e "$adb" ] || break; sleep 1; done
[ ! -e "$adb" ] || { echo "uninstall left the bundled adb.exe behind (adb server still running?)" >&2; exit 1; }
[ ! -f "$lnk" ] || { echo "uninstall left the Start-menu shortcut" >&2; exit 1; }
rm -rf "$root"
echo "install / selftest / uninstall ok: $setup ($want)"
