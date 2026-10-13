#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# Chaquopy needs a build-machine Python whose minor version matches the embedded one (3.10).
if [ -z "${XSCRIPT_BUILD_PYTHON:-}" ]; then
  if command -v python3.10 >/dev/null 2>&1; then
    XSCRIPT_BUILD_PYTHON="$(command -v python3.10)"
  elif command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ]; then
    UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
    XSCRIPT_BUILD_PYTHON="$("$UV" python find 3.10 2>/dev/null || true)"
    if [ -z "$XSCRIPT_BUILD_PYTHON" ]; then
      "$UV" python install 3.10
      XSCRIPT_BUILD_PYTHON="$("$UV" python find 3.10)"
    fi
  else
    echo "python3.10 not found. Install it (e.g. 'uv python install 3.10') or set XSCRIPT_BUILD_PYTHON." >&2
    exit 1
  fi
fi
export XSCRIPT_BUILD_PYTHON

printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$ROOT/android/local.properties"
cd "$ROOT/android"
# backend/xscript_pack.py sets XSCRIPT_GRADLE_TASK=:app:assembleRelease for signed builds.
exec ./gradlew "${XSCRIPT_GRADLE_TASK:-:app:assembleDebug}" "$@"
