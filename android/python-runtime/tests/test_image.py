import os
import tempfile
import unittest

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover
    np = None

from xscript.android import image


def frame():
    """120x80 BGR image: white background, red block at (20..30, 10..20), blue dot at (70, 40)."""
    img = np.full((80, 120, 3), 255, np.uint8)
    img[10:20, 20:30] = (0, 0, 255)
    img[40, 70] = (255, 0, 0)
    img[40, 71] = (0, 255, 0)
    return img


@unittest.skipIf(np is None, "numpy/cv2 not installed")
class ColorTest(unittest.TestCase):
    def test_parse(self):
        pts = image.parse_color_points("1,2,#FF0000|3,4,#00FF00-#101010")
        self.assertEqual(pts[0], (1, 2, (255, 0, 0), None))
        self.assertEqual(pts[1], (3, 4, (0, 255, 0), (16, 16, 16)))

    def test_similarity(self):
        self.assertEqual(image.diff_from_similarity(1.0), (0, 0, 0))
        self.assertEqual(image.diff_from_similarity(0.9), (25, 25, 25))
        self.assertEqual(image.diff_from_similarity(0.8), (51, 51, 51))

    def test_pixel(self):
        self.assertEqual(image.get_pixel(25, 15, frame()), (255, 0, 0))
        self.assertIsNone(image.get_pixel(500, 15, frame()))

    def test_compare(self):
        self.assertTrue(image.compare_colors("25,15,#FF0000|70,40,#0000FF", 0.95, frame()))
        self.assertFalse(image.compare_colors("25,15,#00FF00", 0.95, frame()))

    def test_find_multi_point(self):
        hits = image.find_colors("70,40,#0000FF|71,40,#00FF00", sim=0.95, image=frame())
        self.assertEqual([tuple(p) for p in hits], [(70, 40)])

    def test_find_rect_and_space(self):
        hits = image.find_colors("0,0,#FF0000", rect=[0, 0, 60, 60], sim=0.95, space=5, image=frame())
        self.assertEqual(tuple(hits[0]), (20, 10))
        self.assertTrue(all(20 <= p.x < 30 and 10 <= p.y < 20 for p in hits))
        self.assertLess(len(hits), 10)
        self.assertEqual(image.find_colors("0,0,#FF0000", rect=[40, 0, 60, 60], sim=0.95, image=frame()), [])

    def test_count(self):
        self.assertEqual(image.count_color("#FF0000", sim=0.95, image=frame()), 100)


@unittest.skipIf(np is None, "numpy/cv2 not installed")
class TemplateTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(0)
        self.src = rng.integers(0, 255, (200, 300, 3), dtype=np.uint8)
        self.tpl = self.src[50:80, 120:160].copy()
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "模板.png")
        ok, buf = cv2.imencode(".png", self.tpl)
        buf.tofile(self.path)

    def test_find(self):
        hits = image.find_templates(self.path, confidence=0.9, maxcnt=1, image=self.src)
        self.assertEqual(len(hits), 1)
        h = hits[0]
        self.assertEqual(h["rect"], [120, 50, 160, 80])
        self.assertEqual((h["center_x"], h["center_y"]), (140, 65))
        self.assertGreater(h["confidence"], 0.99)

    def test_rect_offset(self):
        hits = image.find_templates(self.path, rect=[100, 40, 200, 100], confidence=0.9, image=self.src)
        self.assertEqual(hits[0]["rect"], [120, 50, 160, 80])
        self.assertEqual(image.find_templates(self.path, rect=[0, 0, 100, 100], confidence=0.9, image=self.src), [])

    def test_multi_template_index(self):
        other = os.path.join(self.dir, "b.png")
        ok, buf = cv2.imencode(".png", self.src[120:150, 10:50].copy())
        buf.tofile(other)
        hits = image.find_templates([self.path, other], confidence=0.9, image=self.src)
        self.assertEqual(sorted(h["index"] for h in hits), [0, 1])

    def test_non_positive_or_too_high_confidence_terminates(self):
        # confidence <= 0 used to loop forever in _extract (every zeroed cell still scored >= threshold).
        for conf in (0, -0.5, 1.5):
            hits = image.find_templates(self.path, confidence=conf, image=self.src)
            self.assertIsInstance(hits, list)
        self.assertTrue(image.find_templates(self.path, confidence=0, image=self.src))
        with self.assertRaises(ValueError):
            image.find_templates(self.path, confidence=float("nan"), image=self.src)

    def test_extract_stops_at_zero_scores(self):
        res = np.random.default_rng(2).random((40, 40)).astype(np.float32)
        hits = image._extract(res, 4, 4, 0.0, 0)
        self.assertTrue(0 < len(hits) <= res.size)
        self.assertTrue(all(h[0] > 0 for h in hits))

    def _scene(self):
        """Large smooth-noise scene so coarse-to-fine paths are eligible."""
        rng = np.random.default_rng(1)
        small = rng.integers(0, 255, (135, 240, 3), dtype=np.uint8)
        return cv2.resize(small, (960, 540), interpolation=cv2.INTER_CUBIC)

    def test_coarse_to_fine_large_template(self):
        scene = self._scene()
        tpl = scene[200:280, 300:420].copy()
        hits = image.find_templates(tpl, confidence=0.9, maxcnt=1, image=scene)
        self.assertEqual(hits[0]["rect"], [300, 200, 420, 280])

    def test_multi_scale_finds_scaled_copy(self):
        scene = self._scene()
        tpl = scene[100:180, 500:620].copy()
        big = cv2.resize(tpl, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_LINEAR)
        canvas = scene.copy()
        canvas[300:300 + big.shape[0], 100:100 + big.shape[1]] = big
        canvas[100:180, 500:620] = 0  # remove the 1.0x original
        hits = image.find_templates(tpl, confidence=0.8, maxcnt=1, scale_range=[0.8, 2.0], image=canvas)
        self.assertEqual(len(hits), 1)
        cx, cy = hits[0]["center_x"], hits[0]["center_y"]
        self.assertLess(abs(cx - (100 + big.shape[1] // 2)), 8)
        self.assertLess(abs(cy - (300 + big.shape[0] // 2)), 8)

    def test_multi_scale_all_hits_match_full_scan(self):
        """Windowed refinement must return the same hits as a full-res scan at that scale."""
        scene = self._scene()
        tpl = scene[40:100, 40:130].copy()
        small = cv2.resize(tpl, None, fx=0.9, fy=0.9, interpolation=cv2.INTER_AREA)
        canvas = scene.copy()
        canvas[40:100, 40:130] = 0
        spots = [(300, 200), (600, 380), (820, 60)]
        for x, y in spots:
            canvas[y:y + small.shape[0], x:x + small.shape[1]] = small
        hits = image.find_templates(tpl, confidence=0.85, maxcnt=0, scale_range=[0.8, 1.05], image=canvas)
        got = sorted((h["rect"][0], h["rect"][1]) for h in hits)
        self.assertEqual(len(got), 3)
        for (gx, gy), (x, y) in zip(got, sorted(spots)):
            self.assertLessEqual(abs(gx - x), 2)
            self.assertLessEqual(abs(gy - y), 2)

    def test_multi_scale_absent_template(self):
        scene = self._scene()
        rng = np.random.default_rng(7)
        other = rng.integers(0, 255, (60, 90, 3), dtype=np.uint8)
        self.assertEqual(image.find_templates(other, confidence=0.85, scale_range=[0.8, 1.05], image=scene), [])

    def test_transparent_template_ignores_masked_pixels(self):
        scene = self._scene()
        patch = scene[50:110, 60:140].copy()
        bgra = cv2.cvtColor(patch, cv2.COLOR_BGR2BGRA)
        bgra[:20, :, :3] = 255  # garbage where alpha is 0
        bgra[:20, :, 3] = 0
        hits = image.find_templates(bgra, confidence=0.9, maxcnt=1, image=scene)
        self.assertEqual(hits[0]["rect"], [60, 50, 140, 110])

    def test_masked_match_leaves_the_mask_untouched(self):
        # OpenCV 4.5.1 (the version on Android) rewrites a uint8 mask to 0/1 in place; the template cache
        # reuses it, so a mutated mask would zero every later score (found on a 4KB-page emulator).
        scene = self._scene()
        patch = scene[50:110, 60:140].copy()
        bgra = cv2.cvtColor(patch, cv2.COLOR_BGR2BGRA)
        bgra[:20, :, 3] = 0
        tpl = image._prepare_template(bgra, False)
        before = tpl.mask.copy()
        gray = cv2.cvtColor(scene, cv2.COLOR_BGR2GRAY)
        first = image._do_match(gray, tpl.img, tpl.mask)
        self.assertTrue(np.array_equal(tpl.mask, before))
        second = image._do_match(gray, tpl.img, tpl.mask)
        self.assertEqual(float(first.max()), float(second.max()))
        self.assertGreater(float(first.max()), 0.99)

    def test_ascript_ori_keeps_per_template_hits(self):
        other = os.path.join(self.dir, "c.png")
        cv2.imencode(".png", self.src[120:150, 10:50].copy())[1].tofile(other)
        hits = image.find_templates([self.path, other], confidence=0.9, maxcnt=1, image=self.src, ori=2)
        self.assertEqual([h["index"] for h in hits], [0, 1])  # sorted by y: 50 then 120


@unittest.skipIf(np is None, "numpy/cv2 not installed")
class RawFrameTest(unittest.TestCase):
    def test_roundtrip(self):
        img = frame()
        rgba = image.raw_to_rgba(image.bgr_to_raw(img))
        self.assertEqual(rgba.shape, (80, 120, 4))
        self.assertTrue((image.rgba_to_bgr(rgba) == img).all())


class OcrFilterTest(unittest.TestCase):
    def test_pattern(self):
        rows = [image.OcrResult({"text": "金币 1200", "rect": [0, 0, 10, 10]}), image.OcrResult({"text": "确定", "rect": [5, 5, 25, 15]})]
        hits = image.ocr_filter(rows, r"\d+")
        self.assertEqual([h.text for h in hits], ["1200"])
        self.assertEqual(rows[1].center_x, 15)
        self.assertEqual(rows[1]["rect"], [5, 5, 25, 15])


if __name__ == "__main__":
    unittest.main()
