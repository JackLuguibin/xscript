"""Build xs-metrics.ttf: a layout-test font with fixed, known advances for every code point.

Text measured with system fonts differs between machines (a CJK font installed or not changes widths
by a few pixels), so a "does it fit at 400 px" test passes in CI and fails on a desktop. With this font
injected (see test_e2e_ui.metrics_font), widths are the same everywhere: CJK / fullwidth code points
(U+2E80 and up) advance 1 em, everything else 0.6 em, which is a little wider than typical UI fonts.
The glyphs are empty; only the metrics matter. cmap format 13 maps whole ranges to one glyph, so the
file stays tiny and no character ever falls back to a system font.

Regenerate with: python3 make_metrics_font.py   (needs fontTools; only for regenerating)
"""
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

UPM = 1000
NARROW, WIDE = 600, 1000
WIDE_FROM = 0x2E80  # CJK radicals, kana, hangul, ideographs, fullwidth forms, ...


def build(out: Path) -> None:
    fb = FontBuilder(UPM, isTTF=True)
    names = [".notdef", "narrow", "wide"]
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x41: "narrow"})  # replaced below by a format 13 subtable
    empty = TTGlyphPen(None).glyph()
    fb.setupGlyf({n: empty for n in names})
    fb.setupHorizontalMetrics({".notdef": (NARROW, 0), "narrow": (NARROW, 0), "wide": (WIDE, 0)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "XS Metrics", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    sub = CmapSubtable.newSubtable(13)
    sub.platformID, sub.platEncID, sub.language = 3, 10, 0
    sub.cmap = {cp: ("narrow" if cp < WIDE_FROM else "wide") for cp in range(0x20, 0x110000)
                if not 0xD800 <= cp <= 0xDFFF}
    fb.font["cmap"].tables = [sub]
    fb.save(str(out))


if __name__ == "__main__":
    target = Path(__file__).with_name("xs-metrics.ttf")
    build(target)
    print(target, target.stat().st_size, "bytes")
