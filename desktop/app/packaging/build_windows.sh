#!/usr/bin/env bash
# Build dist/XScript (PyInstaller onedir) and dist/xscript-desktop-vX.Y.Z-windows-x64-setup.exe (Inno Setup).
# Runs in Git Bash on Windows (CI: windows-latest). Needs Python 3.10+, Node (frontend), Inno Setup 6 (ISCC.exe).
# Not code-signed (no certificate); see docs: SmartScreen shows "unknown publisher" on first run.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$PWD
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml)
(cd ../frontend && npm run build)
PY=${PYTHON:-python}
[ -x .venv-build/Scripts/python.exe ] || "$PY" -m venv .venv-build
BPY=.venv-build/Scripts/python.exe
"$BPY" -m pip install -q -e . "pyinstaller>=6.10"
mkdir -p build
"$BPY" packaging/make_ico.py build/XScript.ico
"$BPY" -m PyInstaller --noconfirm --clean --windowed \
  --name XScript --icon "$APP_DIR/build/XScript.ico" \
  --paths "$APP_DIR" --collect-submodules xscript_desktop --collect-data xscript_desktop \
  --distpath dist --workpath build/pyinstaller --specpath build \
  "$APP_DIR/packaging/launch.py"
ISCC=${ISCC:-}
for c in "$ISCC" "/c/Program Files (x86)/Inno Setup 6/ISCC.exe" "/c/Program Files/Inno Setup 6/ISCC.exe"; do
  if [ -n "$c" ] && [ -x "$c" ]; then ISCC=$c; break; fi
done
[ -x "$ISCC" ] || { echo "ISCC.exe (Inno Setup 6) not found; set ISCC=" >&2; exit 1; }
# MSYS would rewrite the /D switches into paths
MSYS2_ARG_CONV_EXCL='*' "$ISCC" /Qp "/DAppVersion=$VERSION" "/DSourceDir=$(cygpath -w "$APP_DIR/dist/XScript")" \
  "/DOutputDir=$(cygpath -w "$APP_DIR/dist")" "/DIconFile=$(cygpath -w "$APP_DIR/build/XScript.ico")" \
  "$(cygpath -w "$APP_DIR/packaging/xscript.iss")"
SETUP=dist/xscript-desktop-v$VERSION-windows-x64-setup.exe
[ -f "$SETUP" ] || { echo "ISCC did not produce $SETUP" >&2; exit 1; }
# Code signing (P5.3): there is no certificate, so nothing is signed. With one, sign dist/XScript/XScript.exe before ISCC
# runs and the setup.exe after it (signtool sign /fd sha256 /tr <timestamp-url> /td sha256 ...), with the certificate
# from GitHub Secrets only; check_windows_install.sh would then also run `signtool verify /pa`.
echo "built $APP_DIR/$SETUP"
