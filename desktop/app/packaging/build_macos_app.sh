#!/usr/bin/env bash
# Build dist/XScript.app (own name + icon in Dock/menu bar). Needs: uv, Node (frontend), macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$PWD
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml)
(cd ../frontend && npm run build)
[ -x .venv-build/bin/python ] || uv venv -q -p 3.10 .venv-build
uv pip install -q -p .venv-build/bin/python -e . "pyinstaller>=6.10"
mkdir -p build
.venv-build/bin/python packaging/make_icns.py build/XScript.icns
.venv-build/bin/pyinstaller --noconfirm --clean --windowed \
  --name XScript --icon "$APP_DIR/build/XScript.icns" \
  --osx-bundle-identifier com.xscript.desktop \
  --paths "$APP_DIR" --collect-submodules xscript_desktop --collect-data xscript_desktop \
  --distpath dist --workpath build/pyinstaller --specpath build \
  "$APP_DIR/packaging/launch.py"
PLIST=dist/XScript.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string XScript" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSHighResolutionCapable bool true" "$PLIST" 2>/dev/null || true
# Editing Info.plist breaks the ad-hoc signature PyInstaller applied, and macOS then reports the quarantined
# app as "damaged". Re-seal the bundle as the very last step: nested binaries keep PyInstaller's ad-hoc
# signatures, the outer seal is redone over the final Info.plist/resources. Nothing may touch the bundle after this.
APP=dist/XScript.app
xattr -cr "$APP"
codesign --force --sign - --timestamp=none "$APP"
bash "$APP_DIR/packaging/verify_macos_app.sh" "$APP"
echo "built $APP_DIR/dist/XScript.app"
