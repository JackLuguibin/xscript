import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "scripts", "bench"))

try:
    import cv2  # noqa: F401
    import numpy as np
    import algo_bench
except ImportError:  # pragma: no cover
    algo_bench = None


@unittest.skipIf(algo_bench is None, "cv2/numpy not available")
class MultiScaleSparseTemplateTest(unittest.TestCase):
    """Sparse templates (little detail on a flat background) must survive the 1/4 reject pass.

    Downsampling 4x washes such a template out to an almost constant patch whose normalized
    score is noise, so the coarse pass used to return [] for a template that scores 0.99 at
    scale 1.0 and is found without scale_range.
    """

    def setUp(self):
        self.frame = algo_bench._frame()
        self.tpl = self.frame[1200:1290, 600:700].copy()

    def test_scale_range_finds_sparse_template(self):
        from xscript.android import image as I
        self.assertTrue(I.find_templates(self.tpl, None, 0.85, False, 1, None, self.frame))
        for rng in ((0.8, 1.2), (0.9, 1.1)):
            hits = I.find_templates(self.tpl, None, 0.85, False, 1, rng, self.frame)
            self.assertTrue(hits, rng)
            self.assertLessEqual(abs(hits[0]["rect"][0] - 600), 3)
            self.assertLessEqual(abs(hits[0]["rect"][1] - 1200), 3)

    def test_absent_template_still_rejected(self):
        from xscript.android import image as I
        tpl = np.random.default_rng(9).integers(0, 255, (80, 90, 3), dtype=np.uint8)
        self.assertEqual(I.find_templates(tpl, None, 0.85, False, 1, (0.8, 1.2), self.frame), [])


if __name__ == "__main__":
    unittest.main()
