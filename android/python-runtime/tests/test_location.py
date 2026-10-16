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


class MockBridge:
    def __init__(self):
        self.calls = []
        self.reply = {"ok": True, "running": True}

    def system(self, op, arg):
        self.calls.append((op, arg))
        return json.dumps(self.reply)


class MockLocationTest(unittest.TestCase):
    def setUp(self):
        self.fake = MockBridge()
        p = patch.object(location, "bridge", self.fake)
        p.start()
        self.addCleanup(p.stop)

    def test_conversions_round_trip(self):
        # Tiananmen: WGS84 116.391275,39.906217 ~ GCJ-02 116.397518,39.907619 (well-known offset ~500 m)
        glon, glat = location.wgs84_to_gcj02(116.391275, 39.906217)
        self.assertAlmostEqual(glon, 116.39752, places=3)
        self.assertAlmostEqual(glat, 39.90762, places=3)
        wlon, wlat = location.gcj02_to_wgs84(glon, glat)
        self.assertAlmostEqual(wlon, 116.391275, places=6)
        self.assertAlmostEqual(wlat, 39.906217, places=6)
        blon, blat = location.gcj02_to_bd09(glon, glat)
        back = location.bd09_to_gcj02(blon, blat)
        self.assertAlmostEqual(back[0], glon, places=5)
        self.assertAlmostEqual(back[1], glat, places=5)
        w2 = location.to_wgs84(blon, blat, "bd09")
        self.assertAlmostEqual(w2[0], 116.391275, places=4)
        self.assertAlmostEqual(w2[1], 39.906217, places=4)
        self.assertEqual(location.to_wgs84(-0.1276, 51.5072, "gcj02"), (-0.1276, 51.5072))  # outside China: unchanged
        with self.assertRaises(ValueError):
            location.to_wgs84(1, 2, "utm")

    def test_start_converts_to_wgs84_and_forwards(self):
        glon, glat = location.wgs84_to_gcj02(121.4737, 31.2304)
        location.mock.start(glon, glat, accuracy=3, interval=500, coord_type="gcj02")
        op, arg = self.fake.calls[-1]
        self.assertEqual(op, "location_mock_start")
        self.assertAlmostEqual(arg["lon"], 121.4737, places=6)
        self.assertAlmostEqual(arg["lat"], 31.2304, places=6)
        self.assertEqual((arg["accuracy"], arg["interval"]), (3.0, 500))
        location.mock.start(10, 20, coord_type="wgs84")
        self.assertEqual((self.fake.calls[-1][1]["lon"], self.fake.calls[-1][1]["lat"]), (10.0, 20.0))
        location.mock.stop()
        self.assertEqual(self.fake.calls[-1][0], "location_mock_stop")
        self.assertTrue(location.mock.status()["running"])

    def test_validation_and_errors(self):
        for args in ((200, 0), (0, 95), (float("nan"), 0), (0, 0, 0), (0, 0, 5, -1)):
            with self.assertRaises(ValueError):
                location.mock.start(*args, coord_type="wgs84") if len(args) < 3 else location.mock.start(*args[:2], *args[2:], coord_type="wgs84")
        self.assertEqual(self.fake.calls, [])
        self.fake.reply = {"error": "not the mock location app", "code": "not_mock_app"}
        with self.assertRaises(PermissionError):
            location.mock.start(116.4, 39.9)
        self.fake.reply = {"error": "latitude must be within -90..90", "code": "bad_args"}
        with self.assertRaises(ValueError):
            location.mock.status()


if __name__ == "__main__":
    unittest.main()
