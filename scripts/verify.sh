#!/usr/bin/env bash
# Local checks for every part of the repo:
#   android/  -> python-runtime tests, Web IDE node + headless-Chrome tests, Kotlin JVM unit tests, APK presence
#   backend/  -> 管理后台 tests; web console type-check + build (if node_modules)
#   ide/      -> MCP tests, stubs up to date, VS Code extension compile + tests, mock vertical slice
# .venv     -> MCP client/server (httpx, mcp) and backend (pip install -e backend)
# .venv-rt  -> python-runtime tests (numpy, opencv, pillow); falls back to python3
# .venv310  -> backend + MCP tests on the minimum supported Python (3.10), created with uv on first use;
#              skipped with a message when uv/network is unavailable or XS_SKIP_PY310=1
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Device/backend integration tests use loopback servers, even when the host has a proxy.
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"
export no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost"

if [ -x "$ROOT/.venv-rt/bin/python" ]; then
  RT_PY="$ROOT/.venv-rt/bin/python"
else
  RT_PY=python3
fi
if [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
else
  PY=python3
fi
RUNTIME=android/python-runtime
MCP=ide/mcp-server
EXT=ide/vscode-extension

echo "== android: python-runtime ($RT_PY) =="
PYTHONPATH=$RUNTIME:$RUNTIME/tests "$RT_PY" -m unittest discover -s $RUNTIME/tests
echo "== backend ($PY) =="
PYTHONPATH=backend "$PY" -m unittest discover -s backend/tests
echo "== backend: web console =="
if command -v npm >/dev/null 2>&1 && [ -d backend/web/node_modules ]; then
  (cd backend/web && npm test --silent && npm run --silent build >/dev/null && echo "console built: backend/web/dist")
else
  echo "skipped (run 'npm ci' in backend/web first)"
fi
echo "== ide: mcp ($PY) =="
PYTHONPATH=$MCP "$PY" -m unittest discover -s $MCP/tests
echo "== release: App and extension versions agree =="
bash scripts/release.sh check
echo "== backend + mcp on the minimum Python (3.10) =="
if [ "${XS_SKIP_PY310:-}" = "1" ]; then
  echo "skipped (XS_SKIP_PY310=1)"
else
  PY310="$ROOT/.venv310/bin/python"
  if [ ! -x "$PY310" ] && command -v uv >/dev/null 2>&1; then
    uv venv -q --python 3.10 "$ROOT/.venv310" >/dev/null 2>&1 \
      && uv pip install -q --python "$PY310" -e "$ROOT/backend[test]" -e "$ROOT/$MCP" >/dev/null 2>&1 \
      || { echo "could not create .venv310 (uv python 3.10 / network)"; rm -rf "$ROOT/.venv310"; }
  fi
  if [ -x "$PY310" ]; then
    "$PY310" --version
    PYTHONPATH=backend "$PY310" -m unittest discover -s backend/tests
    PYTHONPATH=$MCP "$PY310" -m unittest discover -s $MCP/tests
  else
    echo "skipped (no Python 3.10 venv: install uv, or create .venv310 with python3.10)"
  fi
fi
echo "== ide: stubs up to date =="
"$PY" "$ROOT/scripts/gen_stubs.py" --check
echo "== android: Web IDE completion index up to date =="
"$PY" "$ROOT/scripts/gen_completions.py" --check
echo "== android: Web IDE state + HTTP contract + browser UI (headless Chrome if found) =="
if command -v node >/dev/null 2>&1; then
  node --test scripts/tests/*.test.cjs
else
  echo "skipped (node is required for Web IDE tests)"
fi
echo "== android: Kotlin unit tests (JVM) =="
JBR="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
if [ "${XS_SKIP_GRADLE:-}" = "1" ]; then
  echo "skipped (XS_SKIP_GRADLE=1)"
elif [ -n "${JAVA_HOME:-}" ] || [ -d "$JBR" ] || command -v java >/dev/null 2>&1; then
  (cd android && JAVA_HOME="${JAVA_HOME:-$([ -d "$JBR" ] && echo "$JBR")}" ./gradlew -q --offline :app:testDebugUnitTest --console=plain)
  echo "kotlin unit tests ok"
else
  echo "skipped (no JDK; set JAVA_HOME)"
fi
echo "== ide: vscode extension =="
if command -v npm >/dev/null 2>&1 && [ -d "$EXT/node_modules" ]; then
  (cd "$EXT" && npm run --silent compile && npm test --silent)
else
  echo "skipped (run 'npm ci' in $EXT first)"
fi
echo "== vertical slice (mock) =="
PYTHONPATH=$MCP "$PY" "$ROOT/scripts/vertical_slice.py" --mock
echo "== android: apk =="
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  ls -lh "$APK"
else
  echo "debug APK not built yet (run android/build.sh)"
fi
echo "verify ok"
