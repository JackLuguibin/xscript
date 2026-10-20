#!/usr/bin/env bash
# Package dist/XScript.app (from build_macos_app.sh) into dist/xscript-desktop-vX.Y.Z-macos-arm64.dmg and verify
# the signature inside the finished image. ditto keeps the bundle byte-for-byte (no re-sign, no xattrs).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml)
APP=dist/XScript.app
DMG=dist/xscript-desktop-v$VERSION-macos-arm64.dmg
bash packaging/verify_macos_app.sh "$APP"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto --norsrc --noextattr "$APP" "$stage/XScript.app"
ln -s /Applications "$stage/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname "XScript $VERSION" -srcfolder "$stage" -format UDZO "$DMG"
bash packaging/verify_macos_app.sh "$DMG"
echo "built $PWD/$DMG"
