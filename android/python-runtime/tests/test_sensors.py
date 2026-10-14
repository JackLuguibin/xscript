"""Sensor compatibility and cancellation tests, using no physical device."""
import json
import threading
import unittest
from unittest.mock import patch

from ascript.android import sensor


class FakeBridge:
    def __init__(self):
        self.lock = threading.Lock()
        self.active = {}
        self.queues = {}
        self.calls = []
        self.missing = set()

    def system(self, op, args):
        with self.lock:
            self.calls.append((op, dict(args)))
            kind, token = args["type"], args["token"]
            if op == "sensor_register":
                if kind in self.missing:
                    return "false"
                self.active[kind] = token
                self.queues[(kind, token)] = []
                return "true"
            if op == "sensor_unregister":
                if self.active.get(kind) == token:
                    del self.active[kind]
                    self.queues.pop((kind, token), None)
                    return "true"
                return "false"
            if op == "sensor_poll":
                key = (kind, token)
                rows = self.queues.get(key, [])
                self.queues[key] = []
                return json.dumps(rows)
            raise AssertionError(op)

    def push(self, kind, **row):
        with self.lock:
            self.queues[(kind, self.active[kind])].append(row)


class SensorTest(unittest.TestCase):
    def setUp(self):
        sensor._shutdown()
        self.fake = FakeBridge()
        self.patcher = patch.object(sensor, "bridge", self.fake)
        self.patcher.start()

    def tearDown(self):
        sensor._shutdown()
        self.patcher.stop()

    def test_independent_types_and_single_value(self):
        seen = []
        ready = threading.Event()

        @sensor.AccelerometerSensor.on(sensor.DELAY_GAME)
        def accel(e):
            seen.append(("accel", e.x, e.y, e.z))
            if len(seen) == 2:
                ready.set()

        @sensor.LightSensor.on()
        def light(e):
            seen.append(("light", e.value))
            if len(seen) == 2:
                ready.set()

        self.fake.push(1, x=1, y=2, z=3)
        self.fake.push(5, x=42)
        self.assertTrue(ready.wait(2))
        self.assertCountEqual(seen, [("accel", 1., 2., 3.), ("light", 42.)])
        sensor.AccelerometerSensor.stop()
        self.assertEqual(set(self.fake.active), {5})
        register = next(args for op, args in self.fake.calls if op == "sensor_register")
        self.assertEqual(register["delay"], 1)

    def test_callback_exception_isolated(self):
        ready = threading.Event()
        sensor.GyroscopeSensor.on()(lambda e: 1 / 0)
        sensor.GyroscopeSensor.on()(lambda e: ready.set())
        self.fake.push(4, x=1)
        self.assertTrue(ready.wait(2))
        self.assertEqual(sum(op == "sensor_register" for op, _ in self.fake.calls), 1)

    def test_stop_and_register_inside_callback_discards_old_batch(self):
        seen = []
        ready = threading.Event()

        def replacement(e):
            seen.append(e.value)
            ready.set()

        @sensor.ProximitySensor.on()
        def first(e):
            seen.append(e.value)
            sensor.ProximitySensor.stop()
            sensor.ProximitySensor.on()(replacement)
            self.fake.push(8, x=3)

        with self.fake.lock:
            key = (8, self.fake.active[8])
            self.fake.queues[key].extend([{"x": 1}, {"x": 2}])
        self.assertTrue(ready.wait(2))
        self.assertEqual(seen, [1., 3.])

    def test_missing_hardware_can_retry(self):
        self.fake.missing.add(5)
        sensor.LightSensor.on()(lambda e: None)
        self.assertFalse(sensor.LightSensor._registered)
        self.assertEqual(sensor.LightSensor._callbacks, [])
        self.fake.missing.clear()
        sensor.LightSensor.on()(lambda e: None)
        self.assertTrue(sensor.LightSensor._registered)

    def test_stop_does_not_wait_for_blocked_sensor_callback(self):
        entered, release, stopped, new_ready = (threading.Event() for _ in range(4))
        seen, workers = [], []

        def blocked(e):
            workers.append(threading.current_thread())
            entered.set()
            release.wait(3)

        sensor.LightSensor.on()(blocked)
        sensor.LightSensor.on()(lambda e: seen.append("stale"))
        with self.fake.lock:
            self.fake.queues[(5, self.fake.active[5])].extend([{"x": 1}, {"x": 2}])
        self.assertTrue(entered.wait(2))
        stopper = threading.Thread(target=lambda: (sensor.LightSensor.stop(), stopped.set()), daemon=True)
        stopper.start()
        try:
            self.assertTrue(stopped.wait(1), "stop waited for user callback")
            self.assertNotIn(5, self.fake.active)  # native unregister precedes callback release
            sensor.LightSensor.on()(lambda e: (seen.append(e.value), new_ready.set()))
            self.fake.push(5, x=3)
            self.assertTrue(new_ready.wait(2))
        finally:
            release.set()
            stopper.join(2)
            for worker in workers:
                worker.join(2)
        self.assertEqual(seen, [3.])

    def test_stop_does_not_wait_for_blocked_gps_callback(self):
        from ascript.android import location
        entered, release, stopped = (threading.Event() for _ in range(3))
        callbacks, seen = [], []

        class Location:
            def getLatitude(self): return 1.0
            def getLongitude(self): return 2.0
            def getAltitude(self): return 3.0
            def getAccuracy(self): return 4.0
            def getSpeed(self): return 5.0

        def blocked(e):
            entered.set()
            release.wait(3)

        with patch.object(location, "request", side_effect=lambda fn, **kw: callbacks.append(fn) or True), \
                patch.object(location, "close") as close:
            sensor.GpsSensor.on()(blocked)
            sensor.GpsSensor.on()(lambda e: seen.append("stale"))
            dispatch = threading.Thread(target=lambda: callbacks[0](Location()), daemon=True)
            dispatch.start()
            self.assertTrue(entered.wait(2))
            stopper = threading.Thread(target=lambda: (sensor.GpsSensor.stop(), stopped.set()), daemon=True)
            stopper.start()
            try:
                self.assertTrue(stopped.wait(1), "GPS stop waited for user callback")
                self.assertEqual(close.call_count, 1)
                sensor.GpsSensor.on()(lambda e: seen.append("new"))
                callbacks[-1](Location())
            finally:
                release.set()
                stopper.join(2)
                dispatch.join(2)
                sensor.GpsSensor.stop()
        self.assertEqual(seen, ["new"])

    def test_shutdown_clears_all(self):
        for cls in (sensor.AccelerometerSensor, sensor.GyroscopeSensor, sensor.LightSensor, sensor.ProximitySensor):
            cls.on()(lambda e: None)
        sensor._shutdown()
        self.assertEqual(self.fake.active, {})

    def test_invalid_delay(self):
        with self.assertRaises(ValueError):
            sensor.AccelerometerSensor.on(-1)

    def test_gps_wrapper_cancellation_and_callback_isolation(self):
        from ascript.android import location
        callbacks = []
        seen = []

        class Location:
            def getLatitude(self): return 1.0
            def getLongitude(self): return 2.0
            def getAltitude(self): return 3.0
            def getAccuracy(self): return 4.0
            def getSpeed(self): return 5.0

        with patch.object(location, "request", side_effect=lambda fn, **kw: callbacks.append((fn, kw)) or True), \
                patch.object(location, "close") as close:
            sensor.GpsSensor.on()(lambda e: 1 / 0)
            sensor.GpsSensor.on()(lambda e: seen.append((e.latitude, e.longitude, e.altitude, e.accuracy, e.speed)))
            old, args = callbacks[0]
            self.assertEqual(args, {"min_time_updata": 5000, "min_distance_change": 0})
            old(Location())
            sensor.GpsSensor.stop()
            sensor.GpsSensor.on(1000, 5)(lambda e: seen.append("new"))
            old(Location())
            callbacks[-1][0](Location())
            sensor.GpsSensor.stop()
            self.assertEqual(close.call_count, 2)
        self.assertEqual(seen, [(1., 2., 3., 4., 5.), "new"])


if __name__ == "__main__":
    unittest.main()
