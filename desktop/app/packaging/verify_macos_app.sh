#!/usr/bin/env bash
# Check an XScript.app (or a .dmg containing one) has a valid, consistent deep ad-hoc signature, so a downloaded
# (quarantined) copy gets Gatekeeper's normal "unidentified developer" prompt instead of "is damaged".
#   packaging/verify_macos_app.sh dist/XScript.app | path/to/xscript-desktop-vX.Y.Z-macos-arm64.dmg
set -euo pipefail
target=$1
if [[ $target == *.dmg ]]; then
  hdiutil verify -quiet "$target"
  mnt=$(mktemp -d)
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$target" >/dev/null
  trap 'hdiutil detach -quiet "$mnt"; rmdir "$mnt"' EXIT
  app=$mnt/XScript.app
else
  app=$target
fi
codesign --verify --deep --strict -vv "$app"
info=$(codesign -dvv "$app" 2>&1)
grep -q "Info.plist entries=" <<<"$info" || { echo "Info.plist is not bound to the signature" >&2; exit 1; }
grep -q "^Sealed Resources" <<<"$info" || { echo "resources are not sealed" >&2; exit 1; }
arch=$(lipo -archs "$app/Contents/MacOS/XScript")
[ "$arch" = arm64 ] || { echo "expected an arm64 executable, got: $arch" >&2; exit 1; }
# nothing executable may live outside the sealed places, and every nested Mach-O must verify on its own
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q Mach-O; then codesign --verify --strict "$f" || { echo "bad nested signature: $f" >&2; exit 1; }; fi
done < <(find "$app/Contents" -type f \( -perm -u+x -o -name '*.so' -o -name '*.dylib' \) -print0)
echo "signature ok: $app ($arch, ad-hoc, deep+strict)"
