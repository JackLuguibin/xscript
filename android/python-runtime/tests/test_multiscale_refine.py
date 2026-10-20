import unittest

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    cv2 = None


def textured_frame(seed=7, w=1080, h=2400):
    """A unique, smooth texture (blurred noise): every crop has one true location at every scale."""
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 255, (h // 16, w // 16, 3), dtype=np.uint8)
    img = cv2.resize(img, (w, h), interpolation=cv2.INTER_CUBIC)
    return cv2.GaussianBlur(img, (0, 0), 4.0)


@unittest.skipIf(cv2 is None, "cv2/numpy not available")
class MultiScaleRefineTest(unittest.TestCase):
    """scale_range must find targets whose scale falls between two coarse steps.

    Coarse scales are ~12% apart (0.776, 0.866 ... for (0.5, 1.5)). A large template drawn at 0.8x
    scored ~0.85 at the nearest step, so confidence 0.9 returned nothing although the target
    scores > 0.95 at its true scale.
    """

    @classmethod
    def setUpClass(cls):
        cls.frame = textured_frame()
        cls.tpl = cls.frame[300:560, 100:900].copy()

    def scaled(self, s):
        h, w = self.frame.shape[:2]
        m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), 0, s)
        img = cv2.warpAffine(self.frame, m, (w, h), borderValue=(240, 240, 240))
        cx, cy = m @ np.array([500.0, 430.0, 1.0])
        return img, cx, cy

    def check(self, s, conf, maxcnt=1):
        from xscript.android import image as I
        img, cx, cy = self.scaled(s)
        hits = I.find_templates(self.tpl, None, conf, False, maxcnt, (0.5, 1.5), img)
        self.assertTrue(hits, "scale %s conf %s" % (s, conf))
        self.assertLessEqual(abs(hits[0]["center_x"] - cx), 6)
        self.assertLessEqual(abs(hits[0]["center_y"] - cy), 6)
        self.assertGreaterEqual(hits[0]["confidence"], conf)
        self.assertAlmostEqual((hits[0]["rect"][2] - hits[0]["rect"][0]) / float(self.tpl.shape[1]), s, delta=0.02)
        return hits

    def test_between_coarse_steps_single(self):
        for s in (0.8, 0.83, 0.92, 1.13):
            self.check(s, 0.97)

    def test_between_coarse_steps_find_all(self):
        self.check(0.8, 0.9, maxcnt=0)

    def test_refine_with_masked_template(self):
        from xscript.android import image as I
        tpl = cv2.cvtColor(self.tpl, cv2.COLOR_BGR2BGRA)
        tpl[:40, :, 3] = 0
        img, cx, cy = self.scaled(0.8)
        hits = I.find_templates(tpl, None, 0.85, False, 1, (0.5, 1.5), img)
        self.assertTrue(hits)
        self.assertLessEqual(abs(hits[0]["center_x"] - cx), 8)

    def test_absent_template_still_rejected(self):
        from xscript.android import image as I
        img, _, _ = self.scaled(0.8)
        tpl = np.random.default_rng(3).integers(0, 255, (200, 600, 3), dtype=np.uint8)
        self.assertEqual(I.find_templates(tpl, None, 0.9, False, 1, (0.5, 1.5), img), [])

    def test_refine_scale_stops_at_frame_edge(self):
        from xscript.android import image as I
        tpl = I._load_template(self.tpl)
        g = cv2.cvtColor(self.frame, cv2.COLOR_BGR2GRAY)
        hit = (0.5, 0, 0, g.shape[1] - 1, 200)
        self.assertEqual(I._refine_scale(g, tpl, hit)[0], 0.5)


if __name__ == "__main__":
    unittest.main()
