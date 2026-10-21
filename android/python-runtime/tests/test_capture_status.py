"""screen.capture_status(): what a script can check before a long run."""

import json
import unittest
from unittest import mock

from xscript.android import screen
from xscript.runtime.bridge import bridge


def _status(info):
    with mock.patch.object(bridge, "control", return_value=json.dumps(info) if info is not None else ""):
        return screen.capture_status()


class CaptureStatusTest(unittest.TestCase):
    def test_recording_granted(self):
        st = _status({"granted": True, "lost": False, "available": True, "via": "projection"})
        self.assertEqual(st, {"ok": True, "source": "projection", "lost": False, "reason": ""})

    def test_lost_grant_explains_how_to_fix(self):
        st = _status({"granted": False, "lost": True, "available": False, "via": ""})
        self.assertFalse(st["ok"])
        self.assertTrue(st["lost"])
        self.assertIn("重新授权", st["reason"])

    def test_lost_grant_but_accessibility_still_works(self):
        st = _status({"granted": False, "lost": True, "available": True, "via": "accessibility"})
        self.assertEqual((st["ok"], st["source"], st["lost"], st["reason"]), (True, "accessibility", True, ""))

    def test_nothing_available(self):
        st = _status({"granted": False, "lost": False, "available": True, "via": ""})  # run mode rules the source out
        self.assertFalse(st["ok"])
        self.assertIn("没有可用的截图方式", st["reason"])

    def test_off_device(self):
        st = _status(None)
        self.assertEqual((st["ok"], st["source"]), (False, ""))
        self.assertIn("XScript", st["reason"])

    def test_older_app_without_via(self):
        self.assertTrue(_status({"granted": True, "lost": False, "available": True})["ok"])


if __name__ == "__main__":
    unittest.main()
