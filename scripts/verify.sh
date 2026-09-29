#!/usr/bin/env bash
# Local checks: PC runtime tests, MCP tests, mock vertical slice, APK presence.
# .venv     -> MCP client/server (httpx, mcp)
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

echo "== python-runtime ($RT_PY) =="
PYTHONPATH=python-runtime:python-runtime/tests "$RT_PY" -m unittest discover -s python-runtime/tests
echo "== mcp ($PY) =="
PYTHONPATH=mcp-server "$PY" -m unittest discover -s mcp-server/tests
echo "== stubs up to date =="
"$PY" "$ROOT/scripts/gen_stubs.py" --check
echo "== vertical slice (mock) =="
PYTHONPATH=mcp-server "$PY" "$ROOT/scripts/vertical_slice.py" --mock
echo "== apk =="
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  ls -lh "$APK"
else
  echo "debug APK not built yet (run scripts/build_android.sh)"
fi
echo "verify ok"
