"""Location API compatibility without reading real device location."""
import contextlib
import io
import json
import threading
import unittest
from unittest.mock import patch
from ascript.android import location


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.events = []
        self.last = None
        self.error = None
        self.subscription = 0
        self.condition = threading.Condition()

    def system(self, op, arg):
        self.calls.append((op, arg))
        if self.error and op != "location_close":
            return json.dumps(self.error)
        if op == "location_request":
            self.subscription += 1
            return json.dumps({"ok": True, "subscription": self.subscription})
        if op == "location_poll":
            with self.condition:
                if not self.events:
                    self.condition.wait(0.02)
                if arg["subscription"] != self.subscription:
                    return "[]"
                events, self.events = self.events, []
                return json.dumps(events)
        if op == "location_last":
            return json.dumps(self.last)
        if op == "location_close":
            self.events.clear()
            return '{"ok": true}'
        raise AssertionError(op)

    def push(self, **data):
        with self.condition:
            self.events.append(data)
            self.condition.notify_all()


class LocationTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        self.patch = patch.object(location, "bridge", self.fake)
        self.patch.start()
        self.perm = patch.object(location.permission, "has", return_value=True)
        self.perm.start()

    def tearDown(self):
        location._shutdown()
        self.perm.stop()
        self.patch.stop()

    def test_last_and_getters(self):
        self.assertIsNone(location.get_last())
        self.fake.last = dict(latitude=43.2, longitude=-79.5, altitude=32, accuracy=4, speed=2,
                              bearing=60, time=123, provider="gps")
        fix = location.get_last()
        for name, expected in (("Latitude", 43.2), ("Longitude", -79.5), ("Altitude", 32),
                               ("Accuracy", 4), ("Speed", 2), ("Bearing", 60), ("Time", 123), ("Provider", "gps")):
            self.assertEqual(getattr(fix, "get" + name)(), expected)

    def test_permission_denied(self):
        with patch.object(location.permission, "has", return_value=False), patch.object(location.permission, "ensure", return_value=False):
            with self.assertRaises(PermissionError):
                location.get_last()
        self.fake.error = dict(error="denied", code="permission_denied")
        with self.assertRaises(PermissionError):
            location.get_last()

    def test_coarse_permission_does_not_request_fine(self):
        with patch.object(location.permission, "has", side_effect=lambda key: key == location.permission.ACCESS_COARSE_LOCATION), patch.object(location.permission, "ensure") as ensure:
            location.get_last()
            ensure.assert_not_called()

    def test_callback_error_and_close(self):
        received = threading.Event()
        calls = []
        def callback(fix):
            calls.append(fix.latitude)
            if len(calls) == 1:
                raise ValueError("user callback error")
            received.set()
        with contextlib.redirect_stderr(io.StringIO()):
            location.request(callback, min_time_updata=10, min_distance_change=2)
            worker = location._worker
            self.assertTrue(worker.daemon)
            self.fake.push(latitude=1)
            self.fake.push(latitude=2)
            self.assertTrue(received.wait(1))
            location.close()
            worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(calls, [1, 2])
        self.assertEqual(self.fake.calls[-1][0], "location_close")

    def test_replacement_and_shutdown(self):
        location.request()
        first = location._worker
        location.request()
        first.join(1)
        self.assertFalse(first.is_alive())
        second = location._worker
        location._shutdown()
        second.join(1)
        self.assertFalse(second.is_alive())
        location.close()

    def test_invalid_parameters_and_mock(self):
        for value in (-1, float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                location.request(min_time_updata=value)
            with self.assertRaises(ValueError):
                location.request(min_distance_change=value)
        with self.assertRaises(TypeError):
            location.request("bad callback")
        for name, args in (("start", (1, 2)), ("stop", ()), ("status", ())):
            with self.assertRaises(NotImplementedError):
                getattr(location.mock, name)(*args)


if __name__ == "__main__":
    unittest.main()
