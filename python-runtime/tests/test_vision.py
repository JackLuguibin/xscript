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
