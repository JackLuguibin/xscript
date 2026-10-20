"""Android location compatibility API. Coordinates are WGS84.

Callbacks run on a daemon worker; keep the script alive while receiving updates.
Call close() to release subscriptions. mock.start/stop/status drive system-wide mock locations (developer option needed).
"""

import json
import math
import threading
import traceback

from xscript.runtime.bridge import bridge
from ascript.android.system import permission


class Location:
    """Snapshot of Android's Location with matching common getters."""

    def __init__(self, data):
        self.latitude = float(data.get("latitude", 0))
        self.longitude = float(data.get("longitude", 0))
        self.altitude = float(data.get("altitude", 0))
        self.accuracy = float(data.get("accuracy", 0))
        self.speed = float(data.get("speed", 0))
        self.bearing = float(data.get("bearing", 0))
        self.time = int(data.get("time", 0))
        self.provider = data.get("provider", "")

    def getLatitude(self):
        return self.latitude

    def getLongitude(self):
        return self.longitude

    def getAltitude(self):
        return self.altitude

    def getAccuracy(self):
        return self.accuracy

    def getSpeed(self):
        return self.speed

    def getBearing(self):
        return self.bearing

    def getTime(self):
        return self.time

    def getProvider(self):
        return self.provider


_lock = threading.RLock()
_stop = None
_worker = None


def _call(op, arg=None):
    raw = bridge.system("location_" + op, arg or {})
    if not raw:
        raise RuntimeError("Android location bridge is unavailable")
    result = json.loads(str(raw))
    if isinstance(result, dict) and result.get("error"):
        if result.get("code") == "permission_denied":
            raise PermissionError(result["error"])
        raise RuntimeError(result["error"])
    return result


def _ensure_permission():
    if permission.has(permission.ACCESS_FINE_LOCATION) or permission.has(permission.ACCESS_COARSE_LOCATION):
        return
    if not permission.ensure(permission.ACCESS_FINE_LOCATION):
        if not permission.has(permission.ACCESS_COARSE_LOCATION):
            raise PermissionError("Location requires ACCESS_FINE_LOCATION or ACCESS_COARSE_LOCATION")


def _poll(stop, callback, subscription):
    while not stop.is_set():
        try:
            events = _call("poll", {"timeout_ms": 250, "subscription": subscription})
        except Exception:
            if not stop.is_set():
                traceback.print_exc()
            break
        for data in events or []:
            if stop.is_set():
                return
            if callback is not None:
                try:
                    callback(Location(data))
                except Exception:
                    # User callback failures must not disable future updates.
                    traceback.print_exc()
        stop.wait(0.01)


def request(call_back=None, min_time_updata=5000, min_distance_change=0):
    """Subscribe to available GPS/network providers; replace the previous request."""
    global _stop, _worker
    if call_back is not None and not callable(call_back):
        raise TypeError("call_back must be callable or None")
    interval = float(min_time_updata)
    distance = float(min_distance_change)
    if not math.isfinite(interval) or not math.isfinite(distance) or interval < 0 or distance < 0:
        raise ValueError("Location update time and distance must be finite and nonnegative")
    _ensure_permission()
    with _lock:
        close()
        result = _call("request", {"min_time_updata": int(interval), "min_distance_change": distance})
        stop = threading.Event()
        worker = threading.Thread(target=_poll, args=(stop, call_back, result.get("subscription")), name="ascript-location", daemon=True)
        _stop, _worker = stop, worker
        worker.start()


def get_last():
    """Return the newest cached location, or None if Android has no cached fix."""
    _ensure_permission()
    data = _call("last")
    return Location(data) if data is not None else None


def close():
    """Stop receiving updates and remove Android listeners (safe to repeat)."""
    global _stop, _worker
    with _lock:
        if _stop is not None:
            _stop.set()
        _stop, _worker = None, None
        _call("close")


def _shutdown():
    try:
        close()
    except Exception:
        pass


# Coordinate systems (China): the implementation is xscript.android.coords; same names as before.
from xscript.android.coords import (  # noqa: E402,F401
    wgs84_to_gcj02, gcj02_to_wgs84, bd09_to_gcj02, gcj02_to_bd09, wgs84_to_bd09, bd09_to_wgs84,
    to_wgs84, from_wgs84, convert,
)


class MockLocationApi:
    """System-wide mock location (AScript location.mock). The device must have XScript selected under
    开发者选项 → 选择模拟位置信息应用 (granted automatically with root). Mocking ends with stop() or when the script ends."""

    def start(self, lon, lat, accuracy=5.0, interval=1000, coord_type="bd09"):
        lon, lat = float(lon), float(lat)
        for v in (lon, lat, float(accuracy), float(interval)):
            if not math.isfinite(v):
                raise ValueError("mock location arguments must be finite")
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("longitude/latitude out of range")
        if float(accuracy) <= 0 or float(interval) <= 0:
            raise ValueError("accuracy and interval must be positive")
        wlon, wlat = to_wgs84(lon, lat, coord_type)
        r = self._call("start", {"lon": wlon, "lat": wlat, "accuracy": float(accuracy), "interval": int(interval)})
        return r

    def stop(self):
        self._call("stop")

    def status(self):
        """{"running", "allowed", "providers", "updates", and lat/lon (WGS84)/accuracy/interval while running}"""
        return self._call("status")

    @staticmethod
    def _call(op, arg=None):
        raw = bridge.system("location_mock_" + op, arg or {})
        if not raw:
            raise RuntimeError("Android location bridge is unavailable")
        r = json.loads(str(raw))
        if isinstance(r, dict) and r.get("error"):
            if r.get("code") == "not_mock_app":
                raise PermissionError(r["error"])
            if r.get("code") == "bad_args":
                raise ValueError(r["error"])
            raise RuntimeError(r["error"])
        return r


_MockLocationApi = MockLocationApi  # old private name
mock: MockLocationApi = MockLocationApi()  # annotated so scripts/gen_stubs.py keeps the type
