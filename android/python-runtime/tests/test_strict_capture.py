"""screen.strict_capture(): a failed capture raises instead of returning an empty result (opt-in, reset per run)."""

import io
import json
import unittest
from contextlib import redirect_stderr
from unittest import mock

from xscript.android import image, screen
from xscript.runtime.bridge import bridge

LOST = json.dumps({"granted": False, "lost": True, "available": False, "via": ""})


class StrictCaptureTest(unittest.TestCase):
    def setUp(self):
        image._reset_run_state()
        image.set_cache(False) if image._cached_frame["rgba"] is not None else None
        patches = [
            mock.patch.object(bridge, "capture_raw", return_value=None),
            mock.patch.object(bridge, "capture_to_file", return_value=None),
            mock.patch.object(bridge, "capture_bitmap", return_value=None),
            mock.patch.object(bridge, "control", return_value=LOST),
            mock.patch("time.sleep"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(image._reset_run_state)

    def test_default_keeps_empty_results_and_logs_once(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertIsNone(screen.capture())
            self.assertIsNone(screen.capture_cv())
            self.assertIsNone(screen.capture_bitmap())
        self.assertEqual(err.getvalue().count("[xscript]"), 1)
        self.assertIn("重新授权", err.getvalue())

    def test_unknown_reason_is_logged_too(self):
        err = io.StringIO()
        with mock.patch.object(bridge, "control", return_value=json.dumps({"available": True, "via": "projection"})), redirect_stderr(err):
            self.assertIsNone(screen.capture_cv())
        self.assertIn("capture_status", err.getvalue())

    def test_strict_raises_with_the_fix(self):
        self.assertFalse(screen.strict_capture(True))
        with redirect_stderr(io.StringIO()):
            for call in (screen.capture, screen.capture_cv, screen.capture_bitmap, lambda: image.ocr()):
                with self.assertRaises(screen.CaptureError) as ctx:
                    call()
                self.assertIn("重新授权", str(ctx.exception))
        self.assertTrue(issubclass(screen.CaptureError, RuntimeError))
        self.assertTrue(screen.strict_capture(False))
        with redirect_stderr(io.StringIO()):
            self.assertIsNone(screen.capture())

    def test_strict_does_not_affect_working_capture(self):
        screen.strict_capture(True)
        with mock.patch.object(bridge, "capture_to_file", return_value="/sdcard/a.png"):
            self.assertEqual(screen.capture(), "/sdcard/a.png")

    def test_a_new_run_resets_strict_mode(self):
        screen.strict_capture(True)
        image._reset_run_state()
        with redirect_stderr(io.StringIO()):
            self.assertIsNone(screen.capture())


if __name__ == "__main__":
    unittest.main()
