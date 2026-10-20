import base64
import json
import os
import tempfile
import unittest

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover
    np = None

from xscript.runtime import vision


def _frame():
    """200x120 BGR: gray background, red block (20..40, 10..30), blue/green pair at (100, 60)."""
    img = np.full((120, 200, 3), 128, np.uint8)
    img[10:30, 20:40] = (0, 0, 255)
    img[60, 100] = (255, 0, 0)
    img[60, 101] = (0, 255, 0)
    # A textured patch so template matching has something distinctive to lock on to.
    rng = np.random.RandomState(7)
    img[70:100, 140:180] = rng.randint(0, 255, (30, 40, 3), dtype=np.uint8)
    return img


@unittest.skipIf(np is None, "numpy/cv2 not installed")
class VisionTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "snap.png")
        # Snapshots are PNGs with alpha, like the device writes them.
        bgra = cv2.cvtColor(_frame(), cv2.COLOR_BGR2BGRA)
        cv2.imwrite(self.path, bgra)

    def tearDown(self):
        for name in os.listdir(self.dir):
            os.remove(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def run_op(self, **req):
        req.setdefault("image", self.path)
        return vision.run(req)

    def test_pixel(self):
        self.assertEqual(self.run_op(op="pixel", x=25, y=15)["color"], "#ff0000")
        self.assertIsNone(self.run_op(op="pixel", x=999, y=15)["color"])

    def test_pixel_points(self):
        out = self.run_op(op="pixel", points=[[25, 15], [100, 60], [-1, 0]])
        self.assertEqual(out["colors"], ["#ff0000", "#0000ff", None])

    def test_find_colors_multi_point(self):
        out = self.run_op(op="find_colors", colors="100,60,#0000FF|101,60,#00FF00", sim=0.95)
        self.assertEqual(out["points"], [[100, 60]])
        self.assertFalse(out["truncated"])
        self.assertIn("ms", out)

    def test_find_colors_rect_and_cap(self):
        out = self.run_op(op="find_colors", colors="0,0,#808080", sim=1.0, space=0, max_num=5)
        self.assertEqual(len(out["points"]), 5)
        self.assertTrue(out["truncated"])
        none = self.run_op(op="find_colors", colors="0,0,#FF0000", rect=[60, 0, 200, 120], sim=0.95)
        self.assertEqual(none["points"], [])

    def test_compare_details(self):
        out = self.run_op(op="compare_colors", colors="25,15,#FF0000|100,60,#00FF00", sim=0.95)
        self.assertFalse(out["match"])
        self.assertEqual([d["ok"] for d in out["details"]], [True, False])
        self.assertEqual(out["details"][1]["actual"], "#0000ff")
        ok = self.run_op(op="compare_colors", colors="25,15,#FF0000|100,60,#0000FF", sim=0.95)
        self.assertTrue(ok["match"])
        # 数量相似度: half of the points is enough.
        half = self.run_op(op="compare_colors", colors="25,15,#FF0000|100,60,#00FF00", sim=0.95, count_sim=0.5)
        self.assertTrue(half["match"])
        self.assertEqual((half["hits"], half["need"]), (1, 1))

    def test_find_image_from_snapshot_region(self):
        out = self.run_op(op="find_image", template_rect=[140, 70, 180, 100], confidence=0.9)
        self.assertTrue(out["hits"])
        self.assertEqual(out["hits"][0]["rect"], [140, 70, 180, 100])
        self.assertGreater(out["hits"][0]["confidence"], 0.99)

    def test_find_image_from_file(self):
        tpl = os.path.join(self.dir, "tpl.png")
        cv2.imwrite(tpl, _frame()[70:100, 140:180])
        out = self.run_op(op="find_image", template_path=tpl, confidence=0.9)
        self.assertEqual(out["hits"][0]["center_x"], 160)

    def test_find_image_from_region_of_other_image(self):
        other = os.path.join(self.dir, "other.png")
        cv2.imwrite(other, _frame())
        out = self.run_op(op="find_image", template_path=other, template_rect=[140, 70, 180, 100], confidence=0.9)
        self.assertEqual(out["hits"][0]["rect"], [140, 70, 180, 100])
        with self.assertRaises(ValueError):
            self.run_op(op="find_image", template_path=other, template_rect=[500, 500, 600, 600])

    def test_ocr_pattern_and_compare_count(self):
        # OCR itself needs the device; only check that the filter path is wired (no crash on empty).
        from unittest import mock
        with mock.patch.object(vision._img, "ocr", return_value=[]):
            out = self.run_op(op="ocr", pattern=r"\d+", binary=128)
        self.assertEqual(out["lines"], [])

    def test_color_space_and_tolerance(self):
        # The block is #ff0000; a dimmed red misses in rgb at sim 0.95 but matches in hsv.
        self.assertEqual(self.run_op(op="find_colors", colors="#c80000", sim=0.95)["points"], [])
        hsv = self.run_op(op="find_colors", colors="#c80000", color_space="HSV", tolerance=[10, 80, 80], max_num=1)
        self.assertEqual(hsv["points"], [[20, 10]])
        self.assertFalse(self.run_op(op="compare_colors", colors="25,15,#c80000", sim=0.95)["match"])
        out = self.run_op(op="compare_colors", colors="25,15,#c80000|999,0,#c80000", color_space="hsv",
                          tolerance=[10, 80, 80], count_sim=0.5)
        self.assertTrue(out["match"])
        self.assertEqual([d["ok"] for d in out["details"]], [True, False])
        self.assertTrue(self.run_op(op="compare_colors", colors="25,15,#fc0000", color_space="lab", tolerance=5)["match"])
        self.assertFalse(self.run_op(op="compare_colors", colors="25,15,#c80000", color_space="lab", tolerance=5)["match"])
        with self.assertRaises(ValueError):
            self.run_op(op="find_colors", colors="#ff0000", color_space="cmyk")

    def test_count_color(self):
        out = self.run_op(op="count_color", color="#ff0000", sim=1.0)
        self.assertEqual(out["count"], 400)
        self.assertAlmostEqual(out["ratio"], 400 / (200 * 120.0), places=4)
        out = self.run_op(op="count_color", color="#ff0000", rect=[20, 10, 30, 30])
        self.assertEqual((out["count"], out["ratio"]), (200, 1.0))

    def test_find_color_blobs(self):
        out = self.run_op(op="find_color_blobs", color="#ff0000")
        self.assertEqual(len(out["blobs"]), 1)
        b = out["blobs"][0]
        self.assertEqual((b["rect"], b["area"], b["fill"]), ([20, 10, 40, 30], 400, 1.0))
        self.assertEqual((b["center_x"], b["center_y"]), (30, 20))
        self.assertFalse(out["truncated"])
        json.dumps(out)
        self.assertEqual(self.run_op(op="find_color_blobs", color="#ff0000", min_area=500)["blobs"], [])
        capped = self.run_op(op="find_color_blobs", color="#808080", color_space="rgb", min_area=1, max_num=1)
        self.assertEqual(len(capped["blobs"]), 1)

    def test_dominant_colors(self):
        out = self.run_op(op="dominant_colors", rect=[0, 0, 60, 40], k=2)
        self.assertEqual([c["color"] for c in out["colors"]], ["#808080", "#ff0000"])
        self.assertAlmostEqual(sum(c["ratio"] for c in out["colors"]), 1.0, places=3)
        json.dumps(out)

    def test_find_image_method(self):
        out = self.run_op(op="find_image", template_rect=[140, 70, 180, 100], method="template")
        self.assertEqual(out["hits"][0]["rect"], [140, 70, 180, 100])
        with self.assertRaises(ValueError):
            self.run_op(op="find_image", template_rect=[140, 70, 180, 100], method="nope")

    def test_errors(self):
        with self.assertRaises(ValueError):
            self.run_op(op="nope")
        with self.assertRaises(ValueError):
            self.run_op(op="find_image")
        with self.assertRaises(ValueError):
            vision.run({"op": "pixel", "image": os.path.join(self.dir, "missing.png")})

    def test_b64_entry(self):
        payload = base64.b64encode(json.dumps({"op": "pixel", "image": self.path, "x": 25, "y": 15}).encode()).decode()
        self.assertEqual(vision.run_b64(payload)["color"], "#ff0000")


if __name__ == "__main__":
    unittest.main()
