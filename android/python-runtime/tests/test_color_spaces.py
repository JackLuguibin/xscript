import unittest

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    cv2 = None


def bgr(hexc):
    h = hexc.lstrip("#")
    return (int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16))


def dim(img, factor):
    return cv2.convertScaleAbs(img, alpha=factor)


@unittest.skipIf(cv2 is None, "cv2/numpy not available")
class ToleranceTest(unittest.TestCase):
    def test_defaults_and_explicit(self):
        from xscript.android import image as I
        self.assertEqual(I.color_tolerance("rgb", 0.9), (25, 25, 25))
        self.assertEqual(I.color_tolerance("hsv", 0.9), (10.0, 60, 80))
        self.assertEqual(I.color_tolerance("lab", 0.9), 12.0)
        self.assertEqual(I.color_tolerance("lab", 1.0), 1.0)
        self.assertEqual(I.color_tolerance("hsv", 1.0), (2.0, 0, 0))
        self.assertEqual(I.color_tolerance("rgb", 0.9, 10), (10, 10, 10))
        self.assertEqual(I.color_tolerance("hsv", 0.9, (5, 40, 40)), (5, 40, 40))
        self.assertEqual(I.color_tolerance("lab", 0.9, 6), 6.0)
        with self.assertRaises(ValueError):
            I.color_tolerance("cmyk")
        with self.assertRaises(ValueError):
            I.color_tolerance("hsv", 0.9, (1, 2))


@unittest.skipIf(cv2 is None, "cv2/numpy not available")
class ColorSpaceSearchTest(unittest.TestCase):
    def setUp(self):
        img = np.full((400, 600, 3), 250, np.uint8)
        img[50:90, 40:200] = bgr("#1a66e0")      # accent button
        img[50:90, 220:380] = bgr("#2a70e8")     # a slightly different blue (perceptually close)
        img[150:190, 40:200] = bgr("#e03c1a")    # red-orange
        img[150:190, 220:380] = bgr("#f01420")   # red near hue 0 / 180
        img[250:300, 40:120] = bgr("#808080")    # grey
        # gradient button: blue getting brighter left to right
        for i, x in enumerate(range(300, 560)):
            v = 0.75 + 0.25 * i / 260.0
            img[250:330, x] = [int(c * v) for c in bgr("#1a66e0")]
        self.img = img

    def test_rgb_default_is_unchanged(self):
        from xscript.android import screen
        p = screen.find_colors("#1a66e0", image=self.img)
        self.assertEqual((p.x, p.y), (40, 50))
        self.assertIsNone(screen.find_colors("#1a66e0", image=dim(self.img, 0.75)))

    def test_hsv_survives_dimming(self):
        from xscript.android import screen
        dark = dim(self.img, 0.75)
        p = screen.find_colors("#1a66e0", image=dark, color_space="hsv")
        self.assertEqual((p.x, p.y), (40, 50))
        bright = cv2.convertScaleAbs(self.img, alpha=1.0, beta=25)
        self.assertIsNotNone(screen.find_colors("#1a66e0", image=bright, color_space="hsv"))
        self.assertTrue(screen.compare_colors("60,60,#1a66e0|100,70,#1a66e0", image=dark, color_space="hsv"))
        self.assertFalse(screen.compare_colors("60,60,#1a66e0|100,70,#1a66e0", image=dark))

    def test_multi_point_pattern_in_hsv_and_lab(self):
        from xscript.android import screen
        pattern = "#1a66e0|0,100,#e03c1a"  # blue with red-orange 100px below
        for cs in ("rgb", "hsv", "lab"):
            hits = screen.find_all_colors(pattern, image=self.img, color_space=cs, space=1000)
            self.assertEqual(len(hits), 1, cs)
            self.assertEqual((hits[0].x, hits[0].y), (40, 50), cs)
        self.assertEqual(screen.find_all_colors(pattern, image=self.img, color_space="lab", rect=[30, 40, 300, 200],
                                                space=5, max_num=3)[0].x, 40)

    def test_lab_is_tighter_than_rgb_for_the_same_sim(self):
        from xscript.android import screen
        n_rgb = screen.count_color("#1a66e0", rect=[0, 0, 400, 100], image=self.img, sim=0.9)
        n_lab = screen.count_color("#1a66e0", rect=[0, 0, 400, 100], image=self.img, color_space="lab", tolerance=3)  # the two blues are dE 4.4 apart
        self.assertEqual(n_lab, 40 * 160)
        self.assertGreater(n_rgb, n_lab)  # rgb ±25 also takes the second blue
        self.assertEqual(screen.count_color("#2a70e8", rect=[0, 0, 400, 100], image=self.img, color_space="lab",
                                            tolerance=3), 40 * 160)

    def test_hue_wraps_around_and_grey_ignores_hue(self):
        from xscript.android import screen
        # #f01420 sits near hue 179/0; a target on the other side of 0 must still match with a wide hue tolerance
        self.assertEqual(screen.count_color("#f0200f", rect=[220, 150, 380, 190], image=self.img, color_space="hsv",
                                            tolerance=(16, 60, 60)), 40 * 160)
        self.assertEqual(screen.count_color("#f01420", image=self.img, color_space="hsv", tolerance=(4, 30, 30)),
                         40 * 160)
        grey = screen.count_color("#7a7a7a", rect=[0, 200, 300, 400], image=self.img, color_space="hsv",
                                  tolerance=(2, 20, 20))
        self.assertEqual(grey, 50 * 80)
        self.assertEqual(screen.count_color("#808080", rect=[0, 200, 300, 400], image=self.img, color_space="hsv",
                                            tolerance=(180, 5, 5)), 50 * 80)

    def test_count_color_or_and_diff_and_rect(self):
        from xscript.android import screen
        both = screen.count_color("#1a66e0|#e03c1a", image=self.img, sim=1.0)
        self.assertEqual(both, 2 * 40 * 160)
        self.assertEqual(screen.count_color("#1a66e0-101010", rect=[0, 0, 400, 100], image=self.img, sim=1.0),
                         2 * 40 * 160)
        self.assertEqual(screen.count_color("#1a66e0", rect=[0, 0, 100, 100], image=self.img, sim=1.0), 40 * 60)
        with self.assertRaises(ValueError):
            screen.count_color("|", image=self.img)

    def test_blobs(self):
        from xscript.android import screen
        blobs = screen.find_color_blobs("#1a66e0", image=self.img)
        # HSV takes the whole gradient button (80x260) and the flat button; the second blue is close in hue too
        self.assertEqual(blobs[0]["rect"], [300, 250, 560, 330])
        self.assertEqual(blobs[0]["area"], 80 * 260)
        self.assertEqual(blobs[0]["fill"], 1.0)
        self.assertEqual((blobs[0]["center_x"], blobs[0]["center_y"]), (430, 290))
        rgb_blobs = screen.find_color_blobs("#1a66e0", image=self.img, color_space="rgb", sim=1.0)
        self.assertEqual([b["rect"] for b in rgb_blobs], [[40, 50, 200, 90]])
        self.assertEqual(len(screen.find_color_blobs("#1a66e0", image=self.img, max_num=1)), 1)
        self.assertEqual(screen.find_color_blobs("#1a66e0", image=self.img, min_area=10 ** 6), [])
        off = screen.find_color_blobs("#e03c1a", rect=[20, 140, 210, 200], image=self.img, color_space="lab")
        self.assertEqual(off[0]["rect"], [40, 150, 200, 190])

    def test_dominant_colors(self):
        from xscript.android import screen
        img = np.zeros((100, 100, 3), np.uint8)
        img[:60] = bgr("#ff0000")
        img[60:90] = bgr("#0000ff")
        img[90:] = bgr("#00ff00")
        dc = screen.dominant_colors(image=img, k=3)
        self.assertEqual([d["color"] for d in dc], ["#ff0000", "#0000ff", "#00ff00"])
        self.assertEqual([d["ratio"] for d in dc], [0.6, 0.3, 0.1])
        self.assertEqual(dc[0]["rgb"], (255, 0, 0))
        self.assertEqual(len(screen.dominant_colors(image=img, k=10)), 3)  # never more than distinct colours
        self.assertEqual(screen.dominant_colors(rect=[0, 0, 100, 50], image=img, k=2)[0]["ratio"], 1.0)
        from xscript.android import image as I
        self.assertEqual(I.dominant_colors(image=img, k=2, color_space="rgb")[0]["color"], "#ff0000")
        with self.assertRaises(ValueError):
            screen.dominant_colors(image=img, k=0)
        big = np.tile(img, (4, 4, 1))  # 160k px: subsampled, same answer
        self.assertEqual(screen.dominant_colors(image=big, k=3)[0]["color"], "#ff0000")

    def test_invalid_space(self):
        from xscript.android import screen
        with self.assertRaises(ValueError):
            screen.find_colors("#ffffff", image=self.img, color_space="yuv")


if __name__ == "__main__":
    unittest.main()
