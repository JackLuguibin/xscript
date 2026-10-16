import shutil
import sys
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1] / "packaging"


def test_build_script_names_app_xscript():
    s = (PKG / "build_macos_app.sh").read_text()
    assert "--name XScript" in s and "--icon" in s and "--windowed" in s


@pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("iconutil"), reason="macOS iconutil only")
def test_make_icns(tmp_path, qapp):
    sys.path.insert(0, str(PKG))
    try:
        from make_icns import make_icns
    finally:
        sys.path.pop(0)
    out = make_icns(tmp_path / "XScript.icns")
    assert out.read_bytes()[:4] == b"icns"
