"""xscript.android.action and the ascript.android.action compat layer: argument coercion,
gesture payloads, Path geometry and slide() speed curves, against a recording bridge."""

import math
import unittest

import ascript.android.action as aa
import xscript.android.action as xa
from xscript.runtime import bridge as bridge_mod


class Rec(bridge_mod._MissingJava):
    def __init__(self):
        self.calls = []

    def _rec(self, *a):
        self.calls.append(a)
        return True

    def click(self, x, y, dur):
        return self._rec("click", x, y, dur)

    def swipe(self, x1, y1, x2, y2, dur):
        return self._rec("swipe", x1, y1, x2, y2, dur)

    def gesture(self, strokes):
        return self._rec("gesture", strokes)

    def touch(self, action, x, y, dur):
        return self._rec("touch", action, x, y, dur)

    def global_action(self, name):
        return self._rec("global", name)

    def input_text(self, text):
        return self._rec("input", text)


class Base(unittest.TestCase):
    def setUp(self):
        self.rec = Rec()
        self.saved = (xa.bridge, aa.bridge)
        xa.bridge = aa.bridge = self.rec
        self.addCleanup(self.undo)

    def undo(self):
        xa.bridge, aa.bridge = self.saved


class NativeActionTest(Base):
    def test_click_accepts_numbers_points_dicts_and_tuples(self):
        class P:
            x, y = 10.7, 20.2

        class Callable:
            def x(self):
                return 3

            def y(self):
                return 4

        xa.click(1.9, 2.1)
        xa.click(P())
        xa.click(Callable())
        xa.click({"center_x": 7, "center_y": 8, "x": 0, "y": 0})
        xa.click({"x": 5, "y": 6})
        xa.click((11, 12), dur=50)
        xa.long_click(1, 1)
        self.assertEqual(self.rec.calls, [("click", 1, 2, 20), ("click", 10, 20, 20), ("click", 3, 4, 20),
                                          ("click", 7, 8, 20), ("click", 5, 6, 20), ("click", 11, 12, 50),
                                          ("click", 1, 1, 800)])
        with self.assertRaises(TypeError):
            xa.click(None)

    def test_results_are_booleans_from_the_bridge(self):
        self.assertIs(xa.click(1, 2), True)
        xa.bridge = bridge_mod._MissingJava()
        self.assertIs(xa.click(1, 2), False)
        self.assertIs(xa.swipe(0, 0, 1, 1), False)

    def test_gesture_payload_and_path(self):
        xa.gesture([{"points": [(0, 0), (10.5, 20)], "start": 5.9}, {"points": [[1, 1]], "duration": 50}])
        self.assertEqual(self.rec.calls[-1], ("gesture", [
            {"points": [[0.0, 0.0], [10.5, 20.0]], "start": 5, "duration": 300},
            {"points": [[1.0, 1.0]], "start": 0, "duration": 50}]))
        xa.path(iter([(0, 0), (5, 5)]), dur=120)
        self.assertEqual(self.rec.calls[-1][1], [{"points": [[0.0, 0.0], [5.0, 5.0]], "start": 0, "duration": 120}])

    def test_input_keys_and_touch(self):
        xa.input(None)
        xa.input(42)
        xa.Key.code(4.0)
        xa.back()
        xa.Touch.down(1.5, 2.5)
        xa.Touch.move(3, 4, 10)
        xa.Touch.up(3, 4)
        self.assertEqual(self.rec.calls, [("input", ""), ("input", "42"), ("global", "key:4"), ("global", "back"),
                                          ("touch", 0, 1, 2, 20), ("touch", 1, 3, 4, 10), ("touch", 2, 3, 4, 20)])


class CompatActionTest(Base):
    def test_click_and_swipe_differences_from_native(self):
        with self.assertRaises(Exception):
            aa.click(None)
        aa.click([3, 4])
        aa.swipe(0, 0, 100, 100)  # AScript default dur=20, clamped to >= 10ms
        aa.swipe(0, 0, 100, 100, dur=1)
        self.assertEqual(self.rec.calls, [("click", 3, 4, 20), ("swipe", 0, 0, 100, 100, 20), ("swipe", 0, 0, 100, 100, 10)])

    def test_slide_variants(self):
        aa.slide(0, 0, 100, 0)
        self.assertEqual(self.rec.calls[-1], ("swipe", 0, 0, 100, 0, 20))
        aa.slide(0, 0, 120, 0, dur=600, control_points=[60, 60])
        name, strokes = self.rec.calls[-1]
        pts = strokes[0]["points"]
        self.assertEqual(name, "gesture")
        self.assertEqual((pts[0], pts[-1]), ([0.0, 0.0], [120.0, 0.0]), "curve ends exactly on the endpoints")
        self.assertEqual(len(pts), 51, "600ms / 12 → 50 steps")
        self.assertAlmostEqual(max(p[1] for p in pts), 30.0, delta=0.5, msg="quadratic Bezier peaks at half the control height")
        self.assertEqual(strokes[0]["duration"], 600)

    def test_slide_with_interpolator_is_a_timed_touch_stream(self):
        class EaseIn:
            def getInterpolation(self, t):
                return t * t

        aa.slide(0, 0, 100, 0, dur=240, interpolator=EaseIn())
        touches = [c for c in self.rec.calls if c[0] == "touch"]
        self.assertEqual(touches[0][1:4], (0, 0, 0))
        self.assertEqual(touches[-1][1:4], (2, 100, 0))
        moves = [c for c in touches if c[1] == 1]
        self.assertEqual(sum(m[4] for m in moves), 240, "move durations add up to dur")
        xs = [m[2] for m in moves]
        self.assertEqual(xs, sorted(xs))
        self.assertLess(xs[len(xs) // 2], 50, "ease-in: slow start")

        class SnakeCase:  # python-style interpolator also accepted, values clamped to 0..1
            def get_interpolation(self, t):
                return 2.0 if t > 0.5 else -1.0

        self.rec.calls.clear()
        aa.slide(0, 0, 100, 0, dur=120, interpolator=SnakeCase())
        xs = [c[2] for c in self.rec.calls if c[0] == "touch" and c[1] == 1]
        self.assertTrue(all(0 <= x <= 100 for x in xs))

    def test_path_geometry(self):
        p = aa.Path(start_time=10, duration=0)
        p.addRect(0, 0, 10, 20)
        self.assertEqual(p.strokes(), [{"points": [(0.0, 0.0), (10.0, 0.0), (10.0, 20.0), (0.0, 20.0), (0.0, 0.0)],
                                        "start": 10, "duration": 1}])
        ccw = aa.Path()
        ccw.addRect(0, 0, 10, 20, aa.Path.CCW)
        self.assertEqual(ccw.strokes()[0]["points"][1], (0.0, 20.0))
        q = aa.Path()
        q.lineTo(5, 5)  # implicit moveTo(0, 0)
        q.rLineTo(5, 0)
        q.close()
        self.assertEqual(q.strokes()[0]["points"], [(0.0, 0.0), (5.0, 5.0), (10.0, 5.0), (0.0, 0.0)])
        c = aa.Path()
        c.addCircle(50, 50, 10)
        pts = c.strokes()[0]["points"]
        self.assertTrue(all(abs(math.hypot(x - 50, y - 50) - 10) < 1e-6 for x, y in pts))
        self.assertAlmostEqual(pts[0][0], pts[-1][0])
        two = aa.Path()
        two.moveTo(0, 0)
        two.lineTo(1, 1)
        two.moveTo(5, 5)
        two.lineTo(6, 6)
        self.assertEqual(len(two.strokes()), 2, "each moveTo starts a new contour")
        two.reset()
        self.assertEqual(two.strokes(), [])

    def test_gesture_listener_callbacks(self):
        seen = []

        class L:
            def onCompleted(self, d):
                seen.append("done")

            def onCancelled(self, d):
                seen.append("cancel")

        p = aa.Path()
        p.moveTo(0, 0)
        p.lineTo(10, 10)
        self.assertTrue(aa.gesture(p, L()))
        self.assertFalse(aa.gesture([], L()), "no strokes: nothing is sent")
        self.assertEqual(seen, ["done", "cancel"])
        self.assertEqual(sum(1 for c in self.rec.calls if c[0] == "gesture"), 1)


if __name__ == "__main__":
    unittest.main()
