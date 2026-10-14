"""AScript sensor decorators backed by bounded Android event queues."""
import json
import threading
import uuid

from xscript.runtime.bridge import bridge

DELAY_FASTEST, DELAY_GAME, DELAY_UI, DELAY_NORMAL = 0, 1, 2, 3


def _call(op, args):
    raw = bridge.system(op, args)
    if not raw:
        raise RuntimeError("Android sensor bridge is unavailable")
    value = json.loads(raw)
    if isinstance(value, dict) and "error" in value:
        raise RuntimeError(value["error"])
    return value


class _SensorEventData:
    def __init__(self, x, y=0, z=0):
        self.x, self.y, self.z = float(x), float(y), float(z)

    def __repr__(self):
        return "SensorEvent(x=%s, y=%s, z=%s)" % (self.x, self.y, self.z)


class _SingleValueEventData:
    def __init__(self, value, _y=0, _z=0):
        self.value = float(value)

    def __repr__(self):
        return "SensorEvent(value=%s)" % self.value


class _BaseSensor:
    DELAY_NORMAL, DELAY_UI = DELAY_NORMAL, DELAY_UI
    DELAY_GAME, DELAY_FASTEST = DELAY_GAME, DELAY_FASTEST
    _DATA_CLASS = _SensorEventData

    def __init_subclass__(cls):
        cls._lock = threading.RLock()
        cls._callbacks = []
        cls._registered = False
        cls._token = None
        cls._stop_event = None

    @classmethod
    def on(cls, delay=None):
        delay = DELAY_NORMAL if delay is None else int(delay)
        if delay < 0:
            raise ValueError("sensor delay must be nonnegative")

        def decorator(func):
            if not callable(func):
                raise TypeError("sensor callback must be callable")
            with cls._lock:
                if not cls._registered:
                    token = uuid.uuid4().hex
                    if not _call("sensor_register", {"type": cls._SENSOR_TYPE, "delay": delay, "token": token}):
                        print("%s: device does not support this sensor" % cls.__name__)
                        return func
                    cls._token, cls._registered = token, True
                    cls._stop_event = threading.Event()
                    cls._callbacks.append(func)
                    threading.Thread(target=cls._poll, args=(token, cls._stop_event),
                                     name=cls.__name__, daemon=True).start()
                else:
                    cls._callbacks.append(func)
            return func
        return decorator

    @classmethod
    def _poll(cls, token, stop):
        while not stop.is_set():
            try:
                rows = _call("sensor_poll", {"type": cls._SENSOR_TYPE, "token": token})
                for row in rows:
                    with cls._lock:
                        if cls._token != token:
                            return
                        event = cls._DATA_CLASS(row.get("x", 0), row.get("y", 0), row.get("z", 0))
                        event.timestamp = row.get("timestamp", 0)
                        event.accuracy = row.get("accuracy", 0)
                        callbacks = list(cls._callbacks)
                    for callback in callbacks:
                        with cls._lock:
                            if cls._token != token:
                                return
                        try:
                            callback(event)
                        except Exception as exc:
                            print("%s callback error: %s" % (cls.__name__, exc))
            except Exception as exc:
                with cls._lock:
                    if cls._token == token:
                        print("%s sensor error: %s" % (cls.__name__, exc))
                        cls.stop()
                return
            stop.wait(0.03)

    @classmethod
    def stop(cls):
        with cls._lock:
            token = cls._token
            cls._callbacks.clear()
            cls._registered, cls._token = False, None
            if cls._stop_event:
                cls._stop_event.set()
            if token is not None:
                _call("sensor_unregister", {"type": cls._SENSOR_TYPE, "token": token})


class AccelerometerSensor(_BaseSensor):
    _SENSOR_TYPE = 1


class GyroscopeSensor(_BaseSensor):
    _SENSOR_TYPE = 4


class LightSensor(_BaseSensor):
    _SENSOR_TYPE = 5
    _DATA_CLASS = _SingleValueEventData


class ProximitySensor(_BaseSensor):
    _SENSOR_TYPE = 8
    _DATA_CLASS = _SingleValueEventData


class _GpsEventData:
    def __init__(self, location):
        self.latitude, self.longitude = location.getLatitude(), location.getLongitude()
        self.altitude, self.accuracy, self.speed = location.getAltitude(), location.getAccuracy(), location.getSpeed()
        self._location = location

    def __repr__(self):
        return "GpsEvent(lat=%s, lng=%s)" % (self.latitude, self.longitude)


class GpsSensor:
    _lock = threading.RLock()
    _callbacks = []
    _registered = False
    _token = None

    @classmethod
    def on(cls, min_time=5000, min_distance=0):
        def decorator(func):
            from ascript.android import location
            if not callable(func):
                raise TypeError("sensor callback must be callable")
            with cls._lock:
                if not cls._registered:
                    token = uuid.uuid4().hex
                    cls._token, cls._registered = token, True
                    cls._callbacks.append(func)
                    try:
                        ok = location.request(lambda loc: cls._dispatch(loc, token),
                                              min_time_updata=min_time, min_distance_change=min_distance)
                        if ok is False:
                            cls._callbacks.clear()
                            cls._token, cls._registered = None, False
                    except Exception:
                        cls._callbacks.clear()
                        cls._token, cls._registered = None, False
                        raise
                else:
                    cls._callbacks.append(func)
            return func
        return decorator

    @classmethod
    def _dispatch(cls, loc, token):
        with cls._lock:
            if token != cls._token:
                return
            event = _GpsEventData(loc)
            callbacks = list(cls._callbacks)
        for callback in callbacks:
            with cls._lock:
                if cls._token != token:
                    return
            try:
                callback(event)
            except Exception as exc:
                print("GpsSensor callback error: %s" % exc)

    @classmethod
    def stop(cls):
        from ascript.android import location
        with cls._lock:
            active = cls._registered
            cls._callbacks.clear()
            cls._token, cls._registered = None, False
            if active:
                location.close()


def _shutdown():
    for sensor in (AccelerometerSensor, GyroscopeSensor, LightSensor, ProximitySensor, GpsSensor):
        try:
            sensor.stop()
        except Exception as exc:
            print("%s cleanup error: %s" % (sensor.__name__, exc))
