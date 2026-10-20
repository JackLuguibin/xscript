import os
import tempfile
import unittest

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    cv2 = None


def ui_frame(w=1080, h=2400, seed=5):
    """A phone-like frame: rows of text, coloured shapes and a textured banner, all distinct."""
    rng = np.random.default_rng(seed)
    img = np.full((h, w, 3), 245, np.uint8)
    banner = rng.integers(0, 255, (40, 135, 3), dtype=np.uint8)
    img[200:520, 0:w] = cv2.GaussianBlur(cv2.resize(banner, (w, 320), interpolation=cv2.INTER_CUBIC), (0, 0), 3)
    words = ["Start", "Daily", "Gold 1234", "Settings", "Shop", "Quest 7", "Mail", "Rank 42", "Friends", "Exit"]
    for i in range(18):
        y = 600 + i * 95
        cv2.rectangle(img, (30, y), (w - 30, y + 80), tuple(int(v) for v in rng.integers(150, 250, 3)), -1)
        cv2.circle(img, (80, y + 40), 28, tuple(int(v) for v in rng.integers(0, 200, 3)), -1)
        cv2.putText(img, "%s %02d" % (words[i % len(words)], i), (130, y + 55), cv2.FONT_HERSHEY_SIMPLEX, 1.4,
                    (20, 20, 20), 3, cv2.LINE_AA)
    return img


def warp(img, scale, angle, center=None):
    h, w = img.shape[:2]
    c = center or (w / 2.0, h / 2.0)
    m = cv2.getRotationMatrix2D(c, angle, scale)
    return cv2.warpAffine(img, m, (w, h), borderValue=(245, 245, 245)), m


@unittest.skipIf(cv2 is None, "cv2/numpy not available")
class FeatureMatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frame = ui_frame()
        cls.box = (100, 200, 700, 280)  # x, y, w, h: part of the (smooth) banner
        x, y, w, h = cls.box
        cls.tpl = cls.frame[y:y + h, x:x + w].copy()
        cls.crisp_box = (30, 885, 700, 380)  # four rows of text and icons
        x, y, w, h = cls.crisp_box
        cls.crisp = cls.frame[y:y + h, x:x + w].copy()

    def inside(self, m, box):
        x, y, w, h = box
        pts = m @ np.array([[x, y, 1], [x + w, y, 1], [x + w, y + h, 1], [x, y + h, 1]], float).T
        fh, fw = self.frame.shape[:2]
        return bool((pts[0] >= 0).all() and (pts[0] < fw).all() and (pts[1] >= 0).all() and (pts[1] < fh).all())

    def truth(self, m, box=None):
        x, y, w, h = box or self.box
        return m @ np.array([x + w / 2.0, y + h / 2.0, 1.0])

    def test_finds_scaled_and_rotated(self):
        """ORB and SIFT on crisp UI; on a smooth banner only SIFT (ORB keeps the strongest corners: the text)."""
        from xscript.android import feature
        for scale, angle in ((1.0, 0), (0.7, 0), (1.3, 0), (1.0, 20), (0.85, -35)):
            img, m = warp(self.frame, scale, angle)
            cases = [("orb", self.crisp, self.crisp_box), ("sift", self.crisp, self.crisp_box),
                     ("sift", self.tpl, self.box)]
            for det, tpl, box in cases:
                if not self.inside(m, box):  # the banner at the top leaves the frame when scaled up / rotated
                    continue
                hit = feature.match(img, tpl, det, 0.8)
                self.assertIsNotNone(hit, (scale, angle, det))
                cx, cy = self.truth(m, box)
                self.assertLessEqual(abs(hit["center_x"] - cx), 6, (scale, angle, det))
                self.assertLessEqual(abs(hit["center_y"] - cy), 6, (scale, angle, det))
                self.assertAlmostEqual(hit["scale"], scale, delta=0.05)
                self.assertAlmostEqual(hit["angle"], angle, delta=2.0)
                self.assertGreaterEqual(hit["confidence"], 0.8)
                self.assertEqual(len(hit["quad"]), 4)
                self.assertEqual(hit["method"], "feature:" + det)
                self.assertGreaterEqual(hit["inliers"], feature.MIN_INLIERS)

    def test_akaze_and_offset(self):
        from xscript.android import feature
        hit = feature.match(self.frame, self.tpl, "akaze", 0.8, rect_offset=(10, 20))
        self.assertIsNotNone(hit)
        x, y, w, h = self.box
        self.assertLessEqual(abs(hit["center_x"] - (x + w / 2 + 10)), 4)
        self.assertLessEqual(abs(hit["center_y"] - (y + h / 2 + 20)), 4)

    def test_absent_and_degenerate(self):
        from xscript.android import feature
        other = ui_frame(seed=99)[200:480, 100:800]
        self.assertIsNone(feature.match(self.frame[600:, :], other, "orb", 0.8))
        self.assertIsNone(feature.match(self.frame, self.tpl[:4, :4], "orb"))
        flat = np.full((60, 60, 3), 128, np.uint8)
        self.assertLess(feature.keypoint_count(flat), feature.MIN_KEYPOINTS)
        self.assertIsNone(feature.match(self.frame, flat))
        with self.assertRaises(ValueError):
            feature.match(self.frame, self.tpl, "surf")

    def test_masked_template_and_gray_inputs(self):
        from xscript.android import feature
        bgra = cv2.cvtColor(self.tpl, cv2.COLOR_BGR2BGRA)
        bgra[:40, :, 3] = 0
        img, m = warp(self.frame, 0.8, 10)
        hit = feature.match(img, bgra, "sift", 0.7)
        self.assertIsNotNone(hit)
        cx, cy = self.truth(m)
        self.assertLessEqual(abs(hit["center_x"] - cx), 8)
        g = feature.match(cv2.cvtColor(self.frame, cv2.COLOR_BGR2GRAY), cv2.cvtColor(self.crisp, cv2.COLOR_BGR2GRAY))
        self.assertIsNotNone(g)

    def test_quad_rejects_folded_and_tiny(self):
        from xscript.android import feature
        good = np.float32([[0, 0], [100, 0], [100, 50], [0, 50]])
        self.assertTrue(feature._quad_ok(good, 100, 50))
        self.assertFalse(feature._quad_ok(np.float32([[0, 0], [100, 50], [100, 0], [0, 50]]), 100, 50))
        self.assertFalse(feature._quad_ok(good * 0.05, 100, 50))
        self.assertFalse(feature._quad_ok(np.float32([[0, 0], [400, 0], [400, 50], [0, 50]]), 100, 50))
        self.assertEqual(feature._verify(self.frame[:, :, 0], self.tpl[:, :, 0], np.zeros((3, 3))), 0.0)
        self.assertEqual(feature._verify(self.frame[:, :, 0], self.tpl[:, :, 0], np.eye(3), np.zeros(self.tpl.shape[:2], np.uint8)), 0.0)

    def test_hash(self):
        from xscript.android import feature
        self.assertEqual(feature.hash_similarity(self.tpl, self.tpl), 1.0)
        self.assertGreater(feature.hash_similarity(self.tpl, cv2.resize(self.tpl, (350, 140))), 0.9)
        self.assertLess(feature.hash_similarity(self.tpl, self.frame[700:980, 100:800]), 0.8)


@unittest.skipIf(cv2 is None, "cv2/numpy not available")
class FindImageMethodTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frame = ui_frame()
        cls.tpl = cls.frame[200:480, 100:800].copy()
        cls.icon = cls.frame[600 + 95 * 3:600 + 95 * 3 + 80, 40:400].copy()  # one row: text + circle
        cls.rot, cls.m = warp(cls.frame, 0.9, 15)

    def test_template_hits_carry_the_new_keys(self):
        from xscript.android import screen
        hit = screen.find_image(self.tpl, image=self.frame)
        self.assertEqual(hit["method"], "template")
        self.assertEqual(hit["angle"], 0.0)
        self.assertEqual(hit["scale"], 1.0)
        self.assertEqual(hit["quad"][0], [100.0, 200.0])
        self.assertEqual(hit["quad"][2], [800.0, 480.0])

    def test_default_is_unchanged_and_auto_falls_back_to_features(self):
        from xscript.android import screen
        self.assertIsNone(screen.find_image(self.tpl, image=self.rot))
        self.assertIsNone(screen.find_image(self.tpl, image=self.rot, method="template"))
        hit = screen.find_image(self.tpl, image=self.rot, method="auto")
        self.assertIsNotNone(hit)
        self.assertTrue(hit["method"].startswith("feature:"))
        cx, cy = self.m @ np.array([450.0, 340.0, 1.0])
        self.assertLessEqual(abs(hit["center_x"] - cx), 6)
        self.assertAlmostEqual(hit["angle"], 15, delta=2)
        self.assertAlmostEqual(hit["scale"], 0.9, delta=0.05)
        # auto keeps template hits as they are
        self.assertEqual(screen.find_image(self.tpl, image=self.frame, method="auto")["method"], "template")

    def test_feature_method_with_rect_and_lists(self):
        from xscript.android import screen
        hits = screen.find_all_images([self.tpl, np.full((50, 50, 3), 9, np.uint8)], image=self.rot,
                                      method="feature", confidence=0.8)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["index"], 0)
        h, w = self.rot.shape[:2]
        hit = screen.find_image(self.tpl, rect=[0, 0, w, 800], image=self.rot, method="feature")
        self.assertIsNotNone(hit)
        self.assertIsNone(screen.find_image(self.tpl, rect=[0, 1200, w, h], image=self.rot, method="feature"))

    def test_multiscale_method_uses_a_default_range(self):
        from xscript.android import screen
        small, m = warp(self.frame, 0.75, 0)
        self.assertIsNone(screen.find_image(self.tpl, image=small))
        hit = screen.find_image(self.tpl, image=small, method="multiscale")
        self.assertIsNotNone(hit)
        self.assertAlmostEqual(hit["scale"], 0.75, delta=0.02)

    def test_hash_method(self):
        from xscript.android import screen
        hit = screen.find_image(self.tpl, rect=[100, 200, 800, 480], image=self.frame, method="hash")
        self.assertEqual(hit["method"], "hash")
        self.assertEqual(hit["rect"], [100, 200, 800, 480])
        self.assertIsNone(screen.find_image(self.tpl, rect=[100, 900, 800, 1180], image=self.frame, method="hash"))

    def test_unknown_method_and_template_files(self):
        from xscript.android import screen
        with self.assertRaises(ValueError):
            screen.find_image(self.tpl, image=self.frame, method="magic")
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "t.png")
            cv2.imwrite(p, self.tpl)
            self.assertIsNotNone(screen.find_image(p, image=self.rot, method="feature"))
            with self.assertRaises(FileNotFoundError):
                screen.find_image(os.path.join(d, "missing.png"), image=self.rot, method="feature")
            open(os.path.join(d, "bad.png"), "wb").write(b"not a png")
            with self.assertRaises(ValueError):
                screen.find_image(os.path.join(d, "bad.png"), image=self.rot, method="feature")

    def test_ascript_sift_is_real_feature_matching(self):
        from ascript.android.screen import ascv, FindImages
        hits = ascv.find_all_sift(self.rot, self.tpl, threshold=0.8)
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["method"].startswith("feature:"))
        self.assertEqual(ascv.find_surf(self.rot, self.tpl, 0.8, off_rect=[5, 7, 0, 0])[0]["center_x"],
                         hits[0]["center_x"] + 5)
        self.assertIsNone(ascv.find_all_sift(None, self.tpl))
        # a flat little icon has no keypoints: template matching, as before
        flat = self.frame[600 + 95 * 2 + 30:600 + 95 * 2 + 50, 300:330].copy()
        self.assertEqual(ascv.find_all_sift(self.frame, flat, threshold=0.9)[0]["method"], "template")
        hit = FindImages.find_sift(self.tpl, source_img=self.rot, confidence=0.8)
        self.assertTrue(hit["method"].startswith("feature:"))
        self.assertEqual(len(FindImages.find_all_sift(self.tpl, source_img=self.rot, confidence=0.8)), 1)
        self.assertTrue(FindImages.find(self.tpl, source_img=self.rot, method="smart")["method"].startswith("feature"))
        self.assertEqual(len(FindImages.find_all(self.tpl, source_img=self.rot, method="sift")), 1)
        noise = np.random.default_rng(4).integers(0, 255, (60, 60, 3), dtype=np.uint8)
        self.assertIsNone(FindImages.find(noise, source_img=self.rot, method="auto"))
        self.assertIsNone(FindImages.find_all("/nonexistent.png", source_img=self.rot, method="auto"))


if __name__ == "__main__":
    unittest.main()
