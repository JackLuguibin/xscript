"""Image matching against committed golden images (tests/data/golden): a fixed 540x960 phone-like scene, templates cut
from it, and the expected positions in expected.json. Unlike the synthetic frames elsewhere, the inputs never change
with numpy / OpenCV versions, so a drift here is a change in the matching itself. make_golden.py documents how the
fixtures were made; do not regenerate them to make a test pass."""
import json
import os
import tempfile
import unittest

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    cv2 = None

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "golden")


def center(box):
    l, t, r, b = box
    return (l + r) / 2.0, (t + b) / 2.0


@unittest.skipIf(cv2 is None, "cv2/numpy not available")
class GoldenMatchingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from xscript.android import screen
        cls.screen = screen
        with open(os.path.join(GOLDEN, "expected.json")) as f:
            cls.exp = json.load(f)
        cls.scene_path = os.path.join(GOLDEN, "scene.png")
        cls.scene = cv2.imread(cls.scene_path)
        cls.tmp = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        for n in os.listdir(cls.tmp):
            os.remove(os.path.join(cls.tmp, n))
        os.rmdir(cls.tmp)

    def tpl(self, name):
        return os.path.join(GOLDEN, name)

    def variant(self, name, img):
        p = os.path.join(self.tmp, name)
        cv2.imwrite(p, img)
        return p

    def assertNear(self, got, want, tol, msg=None):
        self.assertLessEqual(abs(got[0] - want[0]), tol, msg or (got, want))
        self.assertLessEqual(abs(got[1] - want[1]), tol, msg or (got, want))

    def test_fixtures_are_intact(self):
        self.assertEqual(list(self.scene.shape[:2][::-1]), self.exp["size"])
        for name, (l, t, r, b) in self.exp["templates"].items():
            t_img = cv2.imread(self.tpl(name))
            self.assertTrue(np.array_equal(t_img, self.scene[t:b, l:r]), name + " is no longer a crop of scene.png")

    def masked_alpha(self):
        a = cv2.imread(self.tpl("coin_masked.png"), cv2.IMREAD_UNCHANGED)
        self.assertEqual(a.shape[2], 4)
        return a

    def test_masked_fixture_is_the_coin_with_a_round_alpha(self):
        a = self.masked_alpha()
        l, t, r, b = self.exp["templates"]["coin.png"]
        self.assertTrue(np.array_equal(a[:, :, :3], self.scene[t:b, l:r]))
        self.assertEqual(a[0, 0, 3], 0)                                   # corner transparent
        self.assertEqual(a[a.shape[0] // 2, a.shape[1] // 2, 3], 255)     # centre opaque

    def test_masked_template_ignores_what_is_behind_its_transparent_pixels(self):
        alpha = self.masked_alpha()[:, :, 3]
        img = self.scene.copy()
        h, w = alpha.shape
        noise = (np.indices((h, w)).sum(0) % 7 * 35).astype(np.uint8)
        for l, t, r, b in self.exp["coin_rects"]:
            sub = img[t:b, l:r]
            sub[alpha == 0] = noise[alpha == 0][:, None]
        path = self.variant("coin_corners.png", img)
        hits = self.screen.find_all_images(self.tpl("coin_masked.png"), image=path, confidence=0.85)
        self.assertEqual(sorted(h_["rect"] for h_ in hits), sorted(self.exp["coin_rects"]))
        self.assertTrue(all(h_["confidence"] >= 0.99 for h_ in hits), hits)
        # the same coin without a mask cannot see past the repainted corners
        self.assertEqual(self.screen.find_all_images(self.tpl("coin.png"), image=path, confidence=0.85), [])

    def test_find_all_multiscale_finds_every_coin_at_the_refined_scale(self):
        # Measured with the phone's pins: plain 0.7925 / 1.2453 at ~0.985; masked 0.8113 / 1.2453 at 0.835 / 0.908.
        for s in (0.8, 1.25):
            img = cv2.resize(self.scene, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
            path = self.variant("scene_all_x%s.png" % s, img)
            for name in ("coin.png", "coin_masked.png"):
                hits = self.screen.find_all_images(self.tpl(name), image=path, confidence=0.8, method="multiscale",
                                                   scale_range=(0.6, 1.6))
                self.assertEqual(len(hits), 3, (s, name, hits))
                for h_ in hits:
                    self.assertAlmostEqual(h_["scale"], s, delta=0.02, msg=(s, name))
                want = sorted((center(b)[0] * s, center(b)[1] * s) for b in self.exp["coin_rects"])
                got = sorted(center(h_["rect"]) for h_ in hits)
                for g, w_ in zip(got, want):
                    self.assertNear(g, w_, 3, (s, name, g, w_))

    def test_every_template_is_found_exactly(self):
        for name, box in self.exp["templates"].items():
            hit = self.screen.find_image(self.tpl(name), image=self.scene_path, confidence=0.9)
            self.assertIsNotNone(hit, name)
            # the three coins are pixel-identical, so which one scores best is a tie (it differs by platform)
            self.assertIn(list(hit["rect"]), self.exp["coin_rects"] if name == "coin.png" else [box], name)
            self.assertGreater(hit["confidence"], 0.98, name)

    def test_repeated_icon_is_found_at_each_place(self):
        hits = self.screen.find_all_images(self.tpl("coin.png"), image=self.scene_path, confidence=0.9)
        self.assertEqual(sorted(list(h["rect"]) for h in hits), self.exp["coin_rects"])
        # the gems in between are a different shape and colour: never confused with coins
        self.assertEqual(len(hits), 3)

    def test_rect_limits_the_search(self):
        first = self.exp["coin_rects"][0]
        hits = self.screen.find_all_images(self.tpl("coin.png"), rect=[0, 500, 540, 960], image=self.scene_path,
                                           confidence=0.9)
        self.assertEqual(sorted(list(h["rect"]) for h in hits), self.exp["coin_rects"][1:])
        self.assertNotIn(first, [list(h["rect"]) for h in hits])

    def test_absent_template_is_not_found(self):
        self.assertIsNone(self.screen.find_image(self.tpl("absent.png"), image=self.scene_path, confidence=0.8))
        self.assertEqual(self.screen.find_all_images(self.tpl("absent.png"), image=self.scene_path, confidence=0.8), [])

    def test_survives_jpeg_and_dimming(self):
        ok, buf = cv2.imencode(".jpg", self.scene, [cv2.IMWRITE_JPEG_QUALITY, 60])
        jpeg = self.variant("scene_q60.png", cv2.imdecode(buf, cv2.IMREAD_COLOR))
        dim = self.variant("scene_dim.png", (self.scene.astype(np.float32) * 0.7).astype(np.uint8))
        for path in (jpeg, dim):
            for name, box in self.exp["templates"].items():
                hit = self.screen.find_image(self.tpl(name), image=path, confidence=0.85)
                self.assertIsNotNone(hit, (path, name))
                # the three coins are identical: the best hit may be any of them
                wants = self.exp["coin_rects"] if name == "coin.png" else [box]
                self.assertTrue(any(abs(center(hit["rect"])[0] - center(b)[0]) <= 2 and
                                    abs(center(hit["rect"])[1] - center(b)[1]) <= 2 for b in wants), (path, name, hit["rect"]))
            coins = self.screen.find_all_images(self.tpl("coin.png"), image=path, confidence=0.85)
            self.assertEqual(len(coins), 3, path)

    def test_multiscale_finds_a_resized_screen(self):
        for s in (0.8, 1.25):
            img = cv2.resize(self.scene, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
            path = self.variant("scene_x%s.png" % s, img)
            # Measured with the phone's pins: centres land within a pixel or two; after the local scale refinement
            # the estimate is within 0.01 (0.794-0.797 for 0.8, 1.241-1.248 for 1.25) and confidence is 0.97-0.99
            # (it was 0.745 / 1.28 and 0.73 / 0.83 with coarse steps only). The fine-noise badge is left out on
            # purpose: resampling destroys its texture, so template matching cannot find it at another size.
            for name in ("btn_shop.png", "title.png"):
                box = self.exp["templates"][name]
                hit = self.screen.find_image(self.tpl(name), image=path, confidence=0.6, method="multiscale",
                                             scale_range=(0.6, 1.6))
                self.assertIsNotNone(hit, (s, name))
                cx, cy = center(box)
                self.assertNear(center(hit["rect"]), (cx * s, cy * s), 4, (s, name, hit["rect"]))
                self.assertAlmostEqual(hit["scale"], s, delta=0.02)
                self.assertGreaterEqual(hit["confidence"], 0.95, (s, name))
            # plain template matching at the original size does not claim a hit on a resized screen
            for name in ("btn_shop.png", "title.png"):
                self.assertIsNone(self.screen.find_image(self.tpl(name), image=path, confidence=0.8), (s, name))

    def test_feature_matching_finds_a_rotated_screen(self):
        h, w = self.scene.shape[:2]
        for angle in (10, -15):
            m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
            path = self.variant("scene_r%d.png" % angle, cv2.warpAffine(self.scene, m, (w, h), borderValue=(236, 232, 228)))
            for name in ("badge.png", "title.png"):
                hit = self.screen.find_image(self.tpl(name), image=path, confidence=0.5, method="feature")
                self.assertIsNotNone(hit, (angle, name))
                want = m @ np.array([*center(self.exp["templates"][name]), 1.0])
                self.assertNear((hit["center_x"], hit["center_y"]), want, 5, (angle, name))

    def test_colour_marker(self):
        mk = self.exp["marker"]
        p = self.screen.find_colors(mk["colors"], image=self.scene_path, sim=0.95)
        self.assertIsNotNone(p)
        self.assertEqual((p.x, p.y), tuple(mk["at"]))
        # the marker is four solid 8px squares, so neighbouring offsets match too; `space` merges them
        all_hits = self.screen.find_all_colors(mk["colors"], image=self.scene_path, sim=0.95, space=20)
        self.assertEqual([(h.x, h.y) for h in all_hits], [tuple(mk["at"])])
        self.assertTrue(self.screen.compare_colors("40,880,#FF0000|52,892,#FFFF00", image=self.scene_path, sim=0.95))
        self.assertFalse(self.screen.compare_colors("40,880,#00FF00", image=self.scene_path, sim=0.95))


if __name__ == "__main__":
    unittest.main()
