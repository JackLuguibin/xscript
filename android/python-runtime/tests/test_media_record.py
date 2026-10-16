"""media.recode / stop_recode against a fake bridge (no microphone is touched)."""
import json
import unittest
from unittest.mock import patch

from ascript.android import media
from ascript.android.system import permission


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.start_reply = {"ok": True, "path": "/sdcard/a.m4a"}
        self.stop_reply = {"ok": True, "path": "/sdcard/a.m4a", "duration_ms": 1000}

    def system(self, op, arg=None):
        self.calls.append((op, arg))
        if op == "record_start":
            return json.dumps(self.start_reply)
        if op == "record_stop":
            return json.dumps(self.stop_reply)
        if op == "record_status":
            return json.dumps({"recording": False, "path": None, "duration_ms": 0})
        raise AssertionError(op)


class RecodeTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        for p in (patch.object(media, "bridge", self.fake), patch.object(permission, "ensure", return_value=True),
                  patch("time.sleep", lambda s: self.fake.calls.append(("sleep", s)))):
            p.start()
            self.addCleanup(p.stop)

    def test_timed_recording_blocks_then_stops(self):
        self.assertEqual(media.recode("/sdcard/a.m4a", 1500), "/sdcard/a.m4a")
        self.assertEqual([c[0] for c in self.fake.calls], ["record_start", "sleep", "record_stop"])
        self.assertEqual(self.fake.calls[0][1], {"path": "/sdcard/a.m4a"})
        self.assertEqual(self.fake.calls[1][1], 1.5)

    def test_background_recording(self):
        self.assertEqual(media.recode("/sdcard/a.m4a"), "/sdcard/a.m4a")
        self.assertEqual([c[0] for c in self.fake.calls], ["record_start"])
        self.assertEqual(media.stop_recode(), "/sdcard/a.m4a")
        self.assertFalse(media.recode_status()["recording"])

    def test_stop_without_audio_or_recording(self):
        self.fake.stop_reply = {"ok": False, "recording": False}
        self.assertIsNone(media.stop_recode())

    def test_errors(self):
        for bad in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                media.recode("/sdcard/a.m4a", bad)
        self.fake.start_reply = {"error": "unsupported extension", "code": "bad_format"}
        with self.assertRaises(ValueError):
            media.recode("/sdcard/a.mp3")
        self.fake.start_reply = {"error": "already recording", "code": "busy"}
        with self.assertRaises(RuntimeError):
            media.recode("/sdcard/a.m4a")
        self.fake.start_reply = {"error": "RECORD_AUDIO permission required", "code": "permission_denied"}
        with self.assertRaises(PermissionError):
            media.recode("/sdcard/a.m4a")

    def test_permission_refused(self):
        with patch.object(permission, "ensure", return_value=False):
            with self.assertRaises(PermissionError):
                media.recode("/sdcard/a.m4a", 100)
        self.assertEqual(self.fake.calls, [])


if __name__ == "__main__":
    unittest.main()
