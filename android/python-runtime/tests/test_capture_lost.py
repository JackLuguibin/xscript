"""A script whose screen capture comes back empty is told why, once per outage."""

import io
import json
import unittest
from contextlib import redirect_stderr
from unittest import mock

from xscript.android import image
from xscript.runtime.bridge import bridge


class CaptureLostTest(unittest.TestCase):
    def setUp(self):
        image._capture_warned["done"] = False
        image._cached_frame["rgba"] = None

    def _run(self, status, calls=2):
        err = io.StringIO()
        with mock.patch.object(bridge, "capture_raw", return_value=b""), \
                mock.patch.object(bridge, "control", return_value=json.dumps(status)), \
                mock.patch.object(image.time, "sleep"), redirect_stderr(err):
            for _ in range(calls):
                self.assertIsNone(image.capture_rgba())
        return err.getvalue()

    def test_lost_grant_is_explained_once(self):
        out = self._run({"granted": False, "lost": True, "available": False})
        self.assertEqual(out.count("录屏授权已失效"), 1)

    def test_no_capture_source(self):
        out = self._run({"granted": False, "lost": False, "available": False})
        self.assertIn("没有可用的截图方式", out)

    def test_silent_when_status_unknown(self):
        with mock.patch.object(bridge, "control", return_value=""):
            self.assertEqual(image._capture_problem(), "")

    def test_warns_again_after_recovery(self):
        self._run({"lost": True})
        ok = b"\\x00"  # any non-empty frame; decoding is stubbed
        with mock.patch.object(bridge, "capture_raw", return_value=ok), \
                mock.patch.object(image, "raw_to_rgba", return_value=object()):
            self.assertIsNotNone(image.capture_rgba())
        self.assertIn("录屏授权已失效", self._run({"lost": True}, calls=1))


if __name__ == "__main__":
    unittest.main()
