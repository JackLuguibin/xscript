"""find_colors: the in-place greedy scan returns exactly what the sort-then-filter reference returned."""

import time
import unittest

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

from xscript.android import image as img


def _reference(colors, rect, sim, space, ori, max_num, image):
    """The previous implementation: every candidate sorted in Python, then O(n*k) spacing."""
    pts = img.parse_color_points(colors)
    tol = img.diff_from_similarity(sim)
    H, W = image.shape[:2]
    x0, y0 = pts[0][0], pts[0][1]
    rel = [(x - x0, y - y0, rgb, d or tol) for x, y, rgb, d in pts]
    rect = img._norm_rect(rect)
    l, t, r, b = rect or (0, 0, W, H)
    r, b = min(r, W), min(b, H)
    ox0 = max(l, -min(p[0] for p in rel))
    oy0 = max(t, -min(p[1] for p in rel))
    ox1 = min(r, W - max(p[0] for p in rel))
    oy1 = min(b, H - max(p[1] for p in rel))
    if ox1 <= ox0 or oy1 <= oy0:
        return []
    mask = None
    for dx, dy, rgb, d in rel:
        ok = img._channel_ok(image[oy0 + dy:oy1 + dy, ox0 + dx:ox1 + dx], rgb, d)
        mask = ok if mask is None else mask & ok
    ys, xs = np.nonzero(mask)
    cands = img._order([(int(x) + ox0, int(y) + oy0) for x, y in zip(xs, ys)], ori)
    out = []
    for x, y in cands:
        if space and any(abs(x - p[0]) <= space and abs(y - p[1]) <= space for p in out):
            continue
        out.append((x, y))
        if max_num and len(out) >= max_num:
            break
    return out


@unittest.skipIf(np is None, "numpy missing")
class FindColorsFastTest(unittest.TestCase):
    def _image(self, seed, h=90, w=130):
        rng = np.random.RandomState(seed)
        # Few colors so patterns match in many places (clusters, edges, repeats).
        pal = np.array([[10, 10, 10], [200, 50, 50], [50, 200, 50], [240, 240, 240]], np.uint8)
        return pal[rng.randint(0, 4, (h, w))]

    def test_matches_reference_for_every_direction_space_and_limit(self):
        for seed in range(3):
            im = self._image(seed)
            b, g, r = [int(v) for v in im[40, 60]]
            b2, g2, r2 = [int(v) for v in im[42, 61]]
            colors = "60,40,#%02x%02x%02x|61,42,#%02x%02x%02x" % (r, g, b, r2, g2, b2)
            for ori in range(1, 9):
                for space in (0, 2, 7):
                    for max_num in (0, 1, 5):
                        for rect in (None, [10, 5, 120, 80]):
                            got = [tuple(p) for p in img.find_colors(colors, rect, 0.95, space, ori, max_num, im)]
                            want = _reference(colors, rect, 0.95, space, ori, max_num, im)
                            self.assertEqual(got, want, (seed, ori, space, max_num, rect))

    def test_tolerance_edges_and_per_point_diff(self):
        im = np.zeros((20, 20, 3), np.uint8)
        im[5, 5] = (100, 100, 100)
        im[5, 6] = (125, 75, 0)       # BGR: within ±25 of #000064? no; checked against explicit diffs below
        for colors in ("5,5,#646464", "5,5,#7d7d7d", "5,5,#4b4b4b", "5,5,#7e7e7e", "5,5,#000000-0a0a0a",
                       "5,5,#646464|6,5,#004b7d", "5,5,#646464|6,5,#00ff7d-00ff00"):
            for sim in (1.0, 0.9, 0.5, 30):
                got = [tuple(p) for p in img.find_colors(colors, None, sim, 0, 2, 0, im)]
                self.assertEqual(got, _reference(colors, None, sim, 0, 2, 0, im), (colors, sim))

    def test_does_not_modify_the_image(self):
        im = self._image(1)
        before = im.copy()
        img.find_colors("0,0,#0a0a0a", None, 0.9, 3, 5, 0, im)
        self.assertTrue((im == before).all())

    def test_many_hits_is_much_faster_than_the_reference(self):
        im = np.full((600, 400, 3), 240, np.uint8)
        im[::7, ::5] = 10
        colors = "0,0,#f0f0f0|2,0,#f0f0f0"
        t0 = time.perf_counter()
        ref = _reference(colors, None, 0.9, 5, 2, 0, im)
        t_ref = time.perf_counter() - t0
        t0 = time.perf_counter()
        got = [tuple(p) for p in img.find_colors(colors, None, 0.9, 5, 2, 0, im)]
        t_new = time.perf_counter() - t0
        self.assertEqual(got, ref)
        self.assertLess(t_new * 3, t_ref, "new %.1f ms vs reference %.1f ms" % (t_new * 1e3, t_ref * 1e3))


if __name__ == "__main__":
    unittest.main()
