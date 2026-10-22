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
# Chaquopy's pip resolves against chaquo.com; when that index times out (it did for minutes at a time on CI) the build
# fails in install*PythonRequirements. Retry only that failure, after a pause: XSCRIPT_PIP_RETRIES attempts in all
# (default 3 on CI, 1 elsewhere), XSCRIPT_PIP_RETRY_WAIT seconds apart (default 60). Other failures stop at once.
attempts="${XSCRIPT_PIP_RETRIES:-$([ -n "${CI:-}" ] && echo 3 || echo 1)}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
for ((i = 1; ; i++)); do
  status=0
  ./gradlew "${XSCRIPT_GRADLE_TASK:-:app:assembleDebug}" "$@" 2>&1 | tee "$log" || status=$?
  [ "$status" -eq 0 ] && exit 0
  if [ "$i" -ge "$attempts" ] || ! grep -Eq 'Task :app:install[A-Za-z]*PythonRequirements FAILED' "$log"; then exit "$status"; fi
  echo "build.sh: pip install failed (package index unreachable?); retry $((i + 1))/$attempts in ${XSCRIPT_PIP_RETRY_WAIT:-60}s" >&2
  sleep "${XSCRIPT_PIP_RETRY_WAIT:-60}"
done
