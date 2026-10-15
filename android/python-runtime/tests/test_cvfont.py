"""CvFontLib (图片字库) on synthetic glyph images: no device needed."""
import os
import tempfile
import unittest

import cv2
import numpy as np

from ascript.android.screen import ascv, gp, gp_tasks
from ascript.android.screen.gp_tasks import CvFontLib


def glyph(ch, size=1.0):
    """Tight crop of a character rendered white-on-black, as a small BGR template."""
    canvas = np.zeros((40, 40, 3), np.uint8)
    cv2.putText(canvas, ch, (4, 30), cv2.FONT_HERSHEY_SIMPLEX, size, (255, 255, 255), 2, cv2.LINE_AA)
    ys, xs = np.where(canvas[:, :, 0] > 0)
    return canvas[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy()


def paste(screen, tpl, x, y):
    h, w = tpl.shape[:2]
    screen[y:y + h, x:x + w] = tpl
    return x, y, x + w, y + h


class CvFontLibTest(unittest.TestCase):
    def setUp(self):
        self.chars = "0123456789"
        self.tpl = {c: glyph(c) for c in self.chars}
        self.parts = [self.tpl[c] for c in self.chars]

    def screen(self, lines, w=240, h=120):
        img = np.zeros((h, w, 3), np.uint8)
        for line_y, x0, text in lines:
            x = x0
            for c in text:
                paste(img, self.tpl[c], x, line_y)
                x += self.tpl[c].shape[1] + 6
        return img

    def run_task(self, img, **kw):
        task = CvFontLib(self.parts, list(self.chars), **kw)
        return task.run(img, 0, 0)

    def test_reads_digits_left_to_right(self):
        res = self.run_task(self.screen([(20, 10, "8051")]))
        self.assertEqual(res.data["text"], "8051")
        self.assertEqual(res.data["group"], ["8051"])
        glyphs = [m for matches in res.data["words"] for m in matches]
        self.assertEqual(sorted(m["font"] for m in glyphs), ["0", "1", "5", "8"])
        self.assertTrue(all("rectangle" in m and "center_x" in m and m["confidence"] >= 0.95 for m in glyphs))

    def test_repeated_glyphs_are_all_found(self):
        self.assertEqual(self.run_task(self.screen([(20, 10, "1212")])).data["text"], "1212")
        self.assertEqual(self.run_task(self.screen([(20, 10, "777")])).data["text"], "777")

    def test_lines_are_grouped_by_spacing_and_read_top_to_bottom(self):
        img = self.screen([(70, 10, "34"), (15, 12, "12")])
        res = self.run_task(img, spacing=8)
        self.assertEqual(res.data["group"], ["12", "34"])
        self.assertEqual(res.data["text"], "1234")
        # A glyph a few px off the baseline still belongs to the line; a huge spacing merges both lines.
        merged = self.run_task(img, spacing=100).data
        self.assertEqual(len(merged["group"]), 1)
        self.assertEqual(sorted(merged["text"]), list("1234"))  # one line: ordered by left edge only

    def test_nothing_matched_gives_none(self):
        res = self.run_task(np.zeros((50, 80, 3), np.uint8))
        self.assertIsNone(res.data)
        self.assertEqual(res.image.shape, (50, 80, 3))

    def test_confidence_filters_noise_and_wrong_glyphs(self):
        img = self.screen([(20, 10, "3")])
        rng = np.random.RandomState(1)
        noisy = np.clip(img.astype(int) + rng.randint(-60, 60, img.shape), 0, 255).astype(np.uint8)
        self.assertEqual(self.run_task(noisy, confidence=0.6).data["text"], "3")
        self.assertIsNone(self.run_task(noisy, confidence=0.999).data)

    def test_rect_limits_the_search_and_keeps_input_coordinates(self):
        img = self.screen([(20, 10, "12"), (20, 120, "34")])
        res = self.run_task(img, rect=[100, 0, 240, 120])
        self.assertEqual(res.data["text"], "34")
        self.assertEqual(res.image.shape, (120, 140, 3))
        first = res.data["words"][3][0]
        self.assertGreaterEqual(first["rectangle"][0][0], 120)
        self.assertEqual(first["rect"][1], 20)

    def test_larger_glyph_listed_first_wins_over_its_parts(self):
        wide = glyph("8", 1.4)
        small = wide[3:wide.shape[0] - 3, 2:wide.shape[1] - 2].copy()  # textured sub-image of it
        img = np.zeros((60, 60, 3), np.uint8)
        paste(img, wide, 20, 10)
        res = CvFontLib([wide, small], ["W", "s"], confidence=0.97).run(img)
        self.assertEqual(res.data["text"], "W", "the sub-image inside a claimed glyph is blanked")
        res = CvFontLib([small, wide], ["s", "W"], confidence=0.97).run(img)
        self.assertEqual(res.data["text"], "s", "the smaller glyph claimed the area first")

    def test_templates_can_be_files(self):
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for c in "12":
                p = os.path.join(d, c + ".png")
                cv2.imwrite(p, self.tpl[c])
                paths.append(p)
            res = CvFontLib(paths, ["1", "2"]).run(self.screen([(20, 10, "21")]))
            self.assertEqual(res.data["text"], "21")
            with self.assertRaises(FileNotFoundError):
                CvFontLib([os.path.join(d, "missing.png")], ["x"]).run(self.screen([(20, 10, "1")]))

    def test_recognize_helper_accepts_an_image(self):
        self.assertEqual(CvFontLib.recognize(self.parts, list(self.chars), image=self.screen([(20, 10, "907")])), "907")
        self.assertEqual(CvFontLib.recognize(self.parts, list(self.chars), image=np.zeros((30, 30, 3), np.uint8)), "")

    def test_bad_arguments_fail_early(self):
        for args, kwargs in [(([], []), {}), (([self.parts[0]], ["a", "b"]), {}), (([self.parts[0]], [1]), {}),
                             (([self.parts[0]], ["a"]), {"confidence": 0}),
                             (([self.parts[0]], ["a"]), {"confidence": 1.5}),
                             (([self.parts[0]], ["a"]), {"spacing": -1}),
                             (([self.parts[0]], ["a"]), {"rect": [10, 10, 5, 20]}),
                             (([self.parts[0]], ["a"]), {"rect": [1, 2, 3]})]:
            with self.subTest(args=args, kwargs=kwargs), self.assertRaises(ValueError):
                CvFontLib(*args, **kwargs)
        with self.assertRaises(ValueError):
            CvFontLib(self.parts, list(self.chars), rect=[0, 0, 999, 999]).run(self.screen([(20, 10, "1")]))

    def test_helpers_match_the_ascript_algorithms(self):
        def m(x, y, h, font):
            return {"rectangle": ((x, y), (x, y + h), (x + 5, y), (x + 5, y + h)), "font": font}

        data = [[m(30, 10, 10, "b"), m(10, 12, 10, "a")], [m(50, 11, 10, "c"), m(12, 60, 10, "z")]]
        self.assertEqual(CvFontLib.sort_and_concatenate_chars(data), "abcz")
        words = CvFontLib.group_chars_by_distance([[m(0, 0, 5, "a"), m(4, 0, 5, "b"), m(40, 0, 5, "c")]], 10)
        self.assertEqual(words, [(0, "ab"), (40, "c")])
        text, ordered, lines = CvFontLib([self.parts[0]], ["a"], spacing=5).sort_group(data)
        self.assertEqual((text, lines), ("abcz", ["abc", "z"]))
        self.assertEqual([c[2] for c in ordered], list("abcz"))

    def test_runs_inside_a_gp_pipeline_with_structured_args(self):
        img = self.screen([(20, 10, "42")])
        # Structured args may carry ndarray templates (a .gp JSON file would reference image files instead).
        job = {"id": "ascript.android.screen.gp_tasks.CvFontLib",
               "args": [[self.tpl["4"], self.tpl["2"]], ["4", "2"]], "kwargs": {"confidence": 0.9}}
        res = gp.GPStack.run_json([job], img)
        self.assertEqual(res.data["text"], "42")
        self.assertIn(CvFontLib, gp_tasks.gp_list())
        self.assertIn("CvFontLib", gp_tasks.gp_list_json())

    def test_pipeline_after_threshold_and_crop(self):
        img = self.screen([(20, 10, "58")])
        stack = gp.GPStack(img)
        stack.add(gp_tasks.Crop(0, 0, 120, 100)).add(CvFontLib(self.parts, list(self.chars), confidence=0.9))
        self.assertEqual(stack.run().data["text"], "58")


if __name__ == "__main__":
    unittest.main()


class ThinGlyphTest(unittest.TestCase):
    """Anti-aliased 1px glyphs (real font rendering) used to be lost by the half-scale early reject in template search."""

    @staticmethod
    def ring(d):
        c = np.zeros((d + 6, d + 6, 3), np.uint8)
        cv2.circle(c, (c.shape[1] // 2, c.shape[0] // 2), d // 2, (255, 255, 255), 1, cv2.LINE_AA)
        ys, xs = np.where(c[:, :, 0] > 0)
        return c[ys.min():ys.max() + 1, xs.min():xs.max() + 1].copy()

    def test_thin_templates_are_found_at_any_size(self):
        for d in range(8, 40, 2):
            tpl = self.ring(d)
            screen = np.zeros((90, 200, 3), np.uint8)
            screen[20:20 + tpl.shape[0], 50:50 + tpl.shape[1]] = tpl
            with self.subTest(diameter=d):
                found = ascv.find_all_template(screen, tpl, threshold=0.95)
                self.assertEqual(len(found), 1)
                self.assertEqual(found[0]["rectangle"][0], (50, 20))

    def test_thin_glyph_row_is_read_completely(self):
        tpl = {"O": self.ring(16), "o": self.ring(10)}
        screen = np.zeros((60, 240, 3), np.uint8)
        x = 10
        for ch in "OoOOo":
            g = tpl[ch]
            screen[20:20 + g.shape[0], x:x + g.shape[1]] = g
            x += g.shape[1] + 8
        res = CvFontLib([tpl["O"], tpl["o"]], ["O", "o"], confidence=0.95).run(screen)
        self.assertEqual(res.data["text"], "OoOOo")
