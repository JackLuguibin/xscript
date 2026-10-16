"""Screenshot regression helpers: per-platform baselines under tests/baselines/<platform>/, QImage pixel diff with a tolerance.

Baselines are NOT shared across OSes (font rasterisation differs: macOS vs. Linux vs. Windows). A missing baseline skips the test;
`XSCRIPT_UPDATE_BASELINES=1 pytest -m visual` (re)writes them. On mismatch the actual image and a diff image go to tests/_visual_out/.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from PySide6.QtGui import QImage, qRgb

HERE = Path(__file__).resolve().parent
PLATFORM = {"darwin": "darwin", "win32": "win32"}.get(sys.platform, "linux")
BASE = HERE / "baselines" / PLATFORM
OUT = HERE / "_visual_out"


def diff_ratio(a: QImage, b: QImage, per_channel: int = 12) -> float:
    """Fraction of pixels whose any channel differs by more than `per_channel` (0..1). Different sizes => 1.0."""
    if a.size() != b.size():
        return 1.0
    a, b = a.convertToFormat(QImage.Format.Format_RGB32), b.convertToFormat(QImage.Format.Format_RGB32)
    bad = 0
    for y in range(a.height()):
        for x in range(a.width()):
            p, q = a.pixel(x, y), b.pixel(x, y)
            if p != q and (abs(((p >> 16) & 255) - ((q >> 16) & 255)) > per_channel or abs(((p >> 8) & 255) - ((q >> 8) & 255)) > per_channel or abs((p & 255) - (q & 255)) > per_channel):
                bad += 1
    return bad / float(a.width() * a.height())


def diff_image(a: QImage, b: QImage) -> QImage:
    out = QImage(a.size(), QImage.Format.Format_RGB32)
    out.fill(qRgb(255, 255, 255))
    if a.size() != b.size():
        return out
    for y in range(a.height()):
        for x in range(a.width()):
            if a.pixel(x, y) != b.pixel(x, y):
                out.setPixel(x, y, qRgb(255, 0, 0))
    return out


def check(name: str, actual: QImage, tolerance: float = 0.002):
    """Return None when it matches, "skip: ..." when there is no baseline, else a failure string."""
    base = BASE / (name + ".png")
    if os.environ.get("XSCRIPT_UPDATE_BASELINES") == "1":
        BASE.mkdir(parents=True, exist_ok=True)
        actual.save(str(base))
        return None
    if not base.exists():
        return "skip: no baseline for %s on %s (run XSCRIPT_UPDATE_BASELINES=1 pytest -m visual)" % (name, PLATFORM)
    expected = QImage(str(base))
    r = diff_ratio(actual, expected)
    if r <= tolerance:
        return None
    OUT.mkdir(exist_ok=True)
    actual.save(str(OUT / (name + ".actual.png")))
    diff_image(actual, expected).save(str(OUT / (name + ".diff.png")))
    return "%s differs from the baseline in %.3f%% of pixels (tolerance %.3f%%); see %s" % (name, r * 100, tolerance * 100, OUT)
