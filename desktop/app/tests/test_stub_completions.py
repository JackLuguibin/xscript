"""The Monaco completion data (desktop/frontend/src/generated/stub-completions.json) is generated from ide/python-stubs and must not be stale."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "frontend" / "scripts" / "gen_stub_completions.py"


def test_stub_completions_up_to_date():
    r = subprocess.run([sys.executable, str(SCRIPT), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
