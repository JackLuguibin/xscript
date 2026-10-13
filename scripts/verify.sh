#!/usr/bin/env bash
# Local checks for every part of the repo:
#   android/  -> python-runtime tests, APK presence
#   backend/  -> 管理后台 tests; web console type-check + build (if node_modules)
#   ide/      -> MCP tests, stubs up to date, VS Code extension compile + tests, mock vertical slice
# .venv     -> MCP client/server (httpx, mcp) and backend (pip install -e backend)
# .venv-rt  -> python-runtime tests (numpy, opencv, pillow); falls back to python3
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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
  (cd backend/web && npm run --silent build >/dev/null && echo "console built: backend/web/dist")
else
  echo "skipped (run 'npm ci' in backend/web first)"
fi
echo "== ide: mcp ($PY) =="
PYTHONPATH=$MCP "$PY" -m unittest discover -s $MCP/tests
echo "== ide: stubs up to date =="
"$PY" "$ROOT/scripts/gen_stubs.py" --check
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
