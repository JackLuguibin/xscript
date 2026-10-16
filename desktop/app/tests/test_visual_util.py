"""The visual-regression helper itself: identical → pass, changed → fail with artefacts, no baseline → skip, update flag → writes."""
from __future__ import annotations

from PySide6.QtGui import QColor, QImage

from . import visual_util as vu


def img(color="#336699", w=40, h=30) -> QImage:
    i = QImage(w, h, QImage.Format.Format_RGB32)
    i.fill(QColor(color))
    return i


def test_diff_ratio_basics():
    assert vu.diff_ratio(img(), img()) == 0
    assert vu.diff_ratio(img(), img(w=41)) == 1.0  # different size
    b = img()
    for x in range(10):
        b.setPixelColor(x, 0, QColor("#ffffff"))
    assert 0 < vu.diff_ratio(img(), b) < 0.01
    near = img("#336699")
    near.setPixelColor(0, 0, QColor(0x33 + 5, 0x66, 0x99))  # below the per-channel threshold: font-AA noise is ignored
    assert vu.diff_ratio(img(), near) == 0


def test_check_skip_pass_fail_and_update(tmp_path, monkeypatch):
    monkeypatch.setattr(vu, "BASE", tmp_path / "base")
    monkeypatch.setattr(vu, "OUT", tmp_path / "out")
    monkeypatch.delenv("XSCRIPT_UPDATE_BASELINES", raising=False)
    assert vu.check("x", img()).startswith("skip")
    monkeypatch.setenv("XSCRIPT_UPDATE_BASELINES", "1")
    assert vu.check("x", img()) is None and (tmp_path / "base" / "x.png").exists()
    monkeypatch.delenv("XSCRIPT_UPDATE_BASELINES")
    assert vu.check("x", img()) is None
    msg = vu.check("x", img("#ff0000"))
    assert msg and "differs" in msg and (tmp_path / "out" / "x.actual.png").exists() and (tmp_path / "out" / "x.diff.png").exists()
    assert vu.check("x", img(w=50)) is not None
