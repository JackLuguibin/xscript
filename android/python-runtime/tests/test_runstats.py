"""Per-run summary line: duration, capture count / average time and peak memory."""

import unittest
from unittest import mock

from xscript.android import image, screen
from xscript.runtime import runstats
from xscript.runtime.bridge import bridge


class RunStatsTest(unittest.TestCase):
    def setUp(self):
        runstats.reset()
        self.addCleanup(runstats.reset)

    def test_summary_without_captures(self):
        runstats._state["start"] = 100.0
        line = runstats.summary(now=112.34, peak_mb=209.6)
        self.assertEqual(line, "xscript: 运行统计 用时 12.3s · 截图 0 次 · 峰值内存 210MB")

    def test_average_capture_time(self):
        runstats._state["start"] = 0.0
        runstats.record_capture(0.030)
        runstats.record_capture(0.050)
        line = runstats.summary(now=1.0, peak_mb=0)
        self.assertIn("截图 2 次（平均 40ms）", line)
        self.assertNotIn("峰值内存", line)

    def test_capture_calls_are_counted(self):
        image._reset_run_state()
        if image._cached_frame["rgba"] is not None:
            image.set_cache(False)
        with mock.patch.object(bridge, "capture_raw", return_value=None), \
                mock.patch.object(bridge, "capture_to_file", return_value="/sdcard/a.png"), \
                mock.patch.object(bridge, "control", return_value="{}"), mock.patch("time.sleep"), \
                mock.patch("sys.stderr"):
            screen.capture()
            image.capture_rgba()
        image._reset_run_state()
        self.assertEqual(runstats._state["captures"], 2)

    def test_reset_clears_counters(self):
        runstats.record_capture(0.1)
        runstats.reset()
        self.assertEqual(runstats._state["captures"], 0)

    def test_peak_memory_is_positive_here(self):
        self.assertGreater(runstats.peak_memory_mb() or 1, 0)


if __name__ == "__main__":
    unittest.main()
