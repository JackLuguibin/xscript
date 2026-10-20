"""点阵字库 (Ocr.matrix / Ocr.matrix_detail / OcrX / MatrixFont) on synthetic screens: no device needed."""
import json
import os
import tempfile
import unittest

import cv2
import numpy as np

from ascript.android.screen import Ocr, OcrX
from ascript.android.screen.matrix import MatrixFont

INK = (40, 200, 250)  # BGR of the "game digits" colour (RGB FAC828)


def render(text, color=INK, bg=(30, 30, 30), scale=0.9, size=(60, 260), origin=(8, 40), font=cv2.FONT_HERSHEY_SIMPLEX):
    img = np.full((size[0], size[1], 3), bg, np.uint8)
    cv2.putText(img, text, origin, font, scale, color, 2, cv2.LINE_8)
    return img


def glyph_rects(img, color=INK, tol=40):
    """Column runs of ink: one rect per character (characters are drawn apart)."""
    lo = np.clip(np.array(color) - tol, 0, 255).astype(np.uint8)
    hi = np.clip(np.array(color) + tol, 0, 255).astype(np.uint8)
    mask = cv2.inRange(img, lo, hi) > 0
    cols = mask.any(axis=0)
    rects, x = [], 0
    while x < len(cols):
        if cols[x]:
            s = x
            while x < len(cols) and cols[x]:
                x += 1
            ys = np.nonzero(mask[:, s:x].any(axis=1))[0]
            rects.append([s, int(ys.min()), x, int(ys.max()) + 1])
        x += 1
    return rects


SAMPLE = render("0 1 2 3 4 5 6 7 8 9", size=(60, 400))
CROPS = {}
for _ch, (_l, _t, _r, _b) in zip("0123456789", glyph_rects(SAMPLE)):
    CROPS[_ch] = SAMPLE[_t:_b, _l:_r].copy()


def screen_of(text, size=(60, 260), x=8, y=14, gap=6, bg=(30, 30, 30)):
    """Screen with the sample glyphs pasted (pixel-identical digits, as a game draws them); ' ' adds a wider gap."""
    img = np.full((size[0], size[1], 3), bg, np.uint8)
    rects = []
    for ch in text:
        if ch == " ":
            x += 12
            continue
        c = CROPS[ch]
        h, w = c.shape[:2]
        img[y:y + h, x:x + w] = c
        rects.append([x, y, x + w, y + h])
        x += w + gap
    return img, rects


def build_font(chars="0123456789", **kw):
    font = MatrixFont(colors=["FAC828-282828"], **kw)
    rects = glyph_rects(SAMPLE)
    for ch, r in zip("0123456789", rects):
        if ch in chars:
            font.add(ch, SAMPLE, rect=r)
    return font


class MatrixFontTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.font = build_font()
        cls.dir = tempfile.mkdtemp()
        cls.path = cls.font.save(os.path.join(cls.dir, "res", "font.t"))

    def test_file_round_trip(self):
        doc = json.load(open(self.path, encoding="utf-8"))
        self.assertEqual(doc["format"], "xscript-matrix")
        self.assertEqual(doc["colors"], ["FAC828-282828"])
        self.assertEqual([g["char"] for g in doc["glyphs"]], list("0123456789"))
        g = doc["glyphs"][1]
        self.assertEqual(len(g["bits"]), g["w"] * g["h"])
        again = MatrixFont.load(self.path)
        self.assertEqual(again.chars(), self.font.chars())
        for (c1, m1), (c2, m2) in zip(again.glyphs, self.font.glyphs):
            self.assertTrue(np.array_equal(m1, m2), c1)

    def test_matrix_reads_digits_in_rect(self):
        screen = np.full((300, 400, 3), (30, 30, 30), np.uint8)
        screen[100:160, 50:310] = screen_of("2026 815")[0]
        self.assertEqual(Ocr.matrix(self.path, rect=[50, 100, 310, 160], image=screen), "2026815")
        self.assertEqual(Ocr.matrix(self.path, image=screen), "2026815")  # whole image
        self.assertIsNone(Ocr.matrix(self.path, rect=[0, 0, 40, 40], image=screen))  # no ink there

    def test_detail_coordinates_and_lines(self):
        screen = np.full((200, 300, 3), (30, 30, 30), np.uint8)
        a, ra = screen_of("13")
        b, rb = screen_of("709")
        screen[20:80, 10:270] = a
        screen[110:170, 10:270] = b
        d = Ocr.matrix_detail(self.path, image=screen)
        self.assertEqual(d["text"], "13709")
        self.assertEqual(d["lines"], ["13", "709"])
        self.assertEqual([c["text"] for c in d["chars"]], list("13709"))
        truth = [[x + 10, y + 20, r + 10, q + 20] for x, y, r, q in ra] + [[x + 10, y + 110, r + 10, q + 110] for x, y, r, q in rb]
        for c, t in zip(d["chars"], truth):
            self.assertEqual(c["rect"], t)
            self.assertEqual((c["center_x"], c["center_y"]), ((t[0] + t[2]) // 2, (t[1] + t[3]) // 2))
            self.assertGreaterEqual(c["confidence"], 0.9)

    def test_other_colours_are_not_ink(self):
        screen = np.full((80, 300, 3), (30, 30, 30), np.uint8)
        white, _ = screen_of("88")
        white[np.all(white == INK, axis=2)] = (255, 255, 255)  # white digits: not the library's ink colour
        screen[0:60, 0:260] = white
        self.assertIsNone(Ocr.matrix(self.path, image=screen))

    def test_region_controls_strictness(self):
        noisy, _ = screen_of("47")
        rng = np.random.default_rng(1)
        ys, xs = np.nonzero(cv2.inRange(noisy, np.array(INK) - 1, np.array(INK) + 1))
        pick = rng.choice(len(xs), size=len(xs) // 6, replace=False)
        noisy[ys[pick], xs[pick]] = (30, 30, 30)  # knock out 1/6 of the ink
        self.assertIsNone(Ocr.matrix(self.path, region=0.98, image=noisy))
        self.assertEqual(Ocr.matrix(self.path, region=0.6, image=noisy), "47")

    def test_ocrx_task_and_find_all(self):
        screen, _ = screen_of("5 0")
        res = OcrX(self.path, region=0.9).run(screen)
        self.assertEqual(res.data["text"], "50")
        chars = OcrX.find_all(self.path, image=screen)
        self.assertEqual([c["text"] for c in chars], ["5", "0"])
        self.assertIsNone(OcrX.find_all(self.path, image=np.zeros((40, 40, 3), np.uint8)))

    def test_threshold_rule_and_memory_font(self):
        font = MatrixFont(threshold=128)
        gray = cv2.cvtColor(SAMPLE, cv2.COLOR_BGR2GRAY)
        white = cv2.cvtColor(np.where(gray > 100, 255, 0).astype(np.uint8), cv2.COLOR_GRAY2BGR)  # white on black
        rects = glyph_rects(SAMPLE)
        font.add("1", white, rect=rects[1])
        font.add("7", white, rect=rects[7])
        screen = np.zeros((60, 120, 3), np.uint8)
        for (l, t, r, b), x in ((rects[7], 10), (rects[1], 40)):
            screen[t:b, x:x + r - l] = white[t:b, l:r]
        self.assertEqual(Ocr.matrix(font, image=screen), "71")
        inv = MatrixFont(threshold=128, invert=True)
        self.assertEqual(inv.binarize(np.array([[0, 255]], np.uint8)).tolist(), [[1, 0]])
        self.assertNotIn("colors", font.to_json())
        font.add("1", white, rect=rects[1])  # re-adding replaces
        self.assertEqual(font.chars(), ["7", "1"])

    def test_errors(self):
        with self.assertRaises(ValueError):
            MatrixFont(colors=["nope"])
        with self.assertRaises(ValueError):
            MatrixFont(threshold=300)
        with self.assertRaises(ValueError):
            MatrixFont().add("x", np.zeros((10, 10, 3), np.uint8))  # no ink
        with self.assertRaises(ValueError):
            MatrixFont().add("", render("1"))
        bad = os.path.join(self.dir, "ascript_binary.t")
        open(bad, "wb").write(b"\x00\x01binary")
        with self.assertRaises(ValueError) as e:
            Ocr.matrix(bad, image=render("1"))
        self.assertIn("AScript", str(e.exception))
        with self.assertRaises(ValueError):
            MatrixFont.from_json({"format": "xscript-matrix", "glyphs": [{"char": "a", "w": 2, "h": 2, "bits": "101"}]})
        with self.assertRaises(ValueError):
            MatrixFont.from_json({"format": "xscript-matrix", "glyphs": []})
        with self.assertRaises(ValueError):
            Ocr.matrix(self.path, region=0, image=render("1"))
        with self.assertRaises(ValueError):
            Ocr.matrix(self.path, rect=[50, 50, 10, 10], image=render("1"))

    def test_screen_module_exports_matrix_font(self):
        from ascript.android import screen

        self.assertIs(screen.MatrixFont, MatrixFont)
        with self.assertRaises(AttributeError):
            screen.NoSuchThing  # noqa: B018


if __name__ == "__main__":
    unittest.main()
