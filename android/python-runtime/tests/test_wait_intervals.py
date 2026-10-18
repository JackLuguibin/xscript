"""Wait loops take an `interval=` (old fixed value as default) and never sleep past their deadline."""
import unittest
from unittest.mock import patch

from xscript.android import event, node, screen


class FakeClock(object):
    """Stands in for the `time` module: sleep() advances monotonic() instead of waiting."""

    def __init__(self):
        self.now = 100.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(round(s, 6))
        self.now += s


class SelectorWaitTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.queries = []
        self.results = []  # what successive _query() calls return; [] once exhausted
        patcher = patch.object(node, "time", self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def selector(self):
        sel = node.Selector()

        def query():
            self.queries.append(self.clock.now)
            return self.results.pop(0) if self.results else []
        sel._query = query
        return sel

    def test_find_all_default_interval_ends_exactly_at_the_deadline(self):
        self.assertEqual(self.selector().find_all(timeout=1), [])
        self.assertEqual(self.clock.sleeps, [0.25] * 4)
        self.assertEqual(self.queries[-1], 101.0)  # one last look at the deadline, no overshoot

    def test_find_all_custom_interval_shortens_the_last_nap(self):
        self.selector().find_all(timeout=1, interval=0.4)
        self.assertEqual(self.clock.sleeps, [0.4, 0.4, 0.2])
        self.assertAlmostEqual(self.clock.now, 101.0)

    def test_find_without_timeout_queries_once_and_never_sleeps(self):
        self.assertIsNone(self.selector().find(timeout=0, interval=5))
        self.assertEqual((len(self.queries), self.clock.sleeps), (1, []))

    def test_find_returns_as_soon_as_something_matches(self):
        hit = node.Node({"path": "0", "text": "OK"})
        self.results = [[], [], [hit]]
        self.assertIs(self.selector().find(timeout=10, interval=0.1), hit)
        self.assertEqual(self.clock.sleeps, [0.1, 0.1])

    def test_node_find_passes_the_interval_through(self):
        sel = self.selector()
        with patch.object(node.Selector, "within", lambda s, n: sel):
            node.Node({"path": "0"}).find(node.Selector(), timeout=0.5, interval=0.2)
        self.assertEqual(self.clock.sleeps, [0.2, 0.2, 0.1])

    def test_wait_gone(self):
        self.assertTrue(self.selector().wait_gone(timeout=1, interval=0.3))  # nothing there: no waiting at all
        self.assertEqual(self.clock.sleeps, [])
        self.results = [[1]] * 100  # never goes away
        self.assertFalse(self.selector().wait_gone(timeout=1, interval=0.3))
        self.assertEqual(self.clock.sleeps, [0.3, 0.3, 0.3, 0.1])
        self.clock.sleeps.clear()
        self.results = [[1], [1]]  # gone on the third look
        self.assertTrue(self.selector().wait_gone(timeout=10))
        self.assertEqual(self.clock.sleeps, [0.25, 0.25])


class OcrWaitTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        for p in (patch.object(screen, "time", self.clock), patch.object(screen, "ocr_find", lambda *a, **k: None)):
            p.start()
            self.addCleanup(p.stop)

    def test_default_interval(self):
        self.assertIsNone(screen.ocr_wait("登录", timeout=0.6))
        self.assertEqual(self.clock.sleeps, [0.3, 0.3])

    def test_custom_interval_does_not_overshoot(self):
        screen.ocr_wait("登录", timeout=1.2, interval=0.5)
        self.assertEqual(self.clock.sleeps, [0.5, 0.5, 0.2])
        self.assertAlmostEqual(self.clock.now, 101.2)

    def test_returns_the_hit(self):
        hits = iter([None, "hit"])
        with patch.object(screen, "ocr_find", lambda *a, **k: next(hits)):
            self.assertEqual(screen.ocr_wait("登录", timeout=5, interval=1), "hit")
        self.assertEqual(self.clock.sleeps, [1])


class EventLoopTest(unittest.TestCase):
    def test_loop_polls_at_the_given_interval_until_handlers_are_gone(self):
        sleeps = []

        def fake_sleep(s):
            sleeps.append(s)
            if len(sleeps) == 3:
                event._reg.handlers.clear()
        with patch.object(event._reg, "handlers", [("t", "toast", None, None)]), patch.object(event.time, "sleep", fake_sleep):
            event.loop(interval=0.05)
            self.assertEqual(sleeps, [0.05] * 3)
            sleeps.clear()
            event._reg.handlers.append(("t", "toast", None, None))
            event.loop()  # default unchanged
            self.assertEqual(sleeps, [0.5] * 3)


if __name__ == "__main__":
    unittest.main()
