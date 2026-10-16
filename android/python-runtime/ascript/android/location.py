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


# ---- coordinate systems (China): WGS84 (GPS), GCJ-02 (高德/腾讯), BD-09 (百度) ---------------------------------------------

_A = 6378245.0
_EE = 0.00669342162296594323
_X_PI = math.pi * 3000.0 / 180.0


def _out_of_china(lon, lat):
    return not (73.66 < lon < 135.05 and 3.86 < lat < 53.55)


def _delta(lon, lat):
    x, y = lon - 105.0, lat - 35.0
    dlat = (-100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
            + (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
            + (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
            + (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0)
    dlon = (300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
            + (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
            + (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
            + (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0)
    rad = lat / 180.0 * math.pi
    magic = 1 - _EE * math.sin(rad) ** 2
    sq = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sq) * math.pi)
    dlon = (dlon * 180.0) / (_A / sq * math.cos(rad) * math.pi)
    return dlon, dlat


def wgs84_to_gcj02(lon, lat):
    if _out_of_china(lon, lat):
        return lon, lat
    dlon, dlat = _delta(lon, lat)
    return lon + dlon, lat + dlat


def gcj02_to_wgs84(lon, lat):
    """Iterative inverse (error well under 1 m inside China)."""
    if _out_of_china(lon, lat):
        return lon, lat
    wlon, wlat = lon, lat
    for _ in range(30):
        glon, glat = wgs84_to_gcj02(wlon, wlat)
        dx, dy = glon - lon, glat - lat
        wlon, wlat = wlon - dx, wlat - dy
        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            break
    return wlon, wlat


def bd09_to_gcj02(lon, lat):
    x, y = lon - 0.0065, lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * _X_PI)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * _X_PI)
    return z * math.cos(theta), z * math.sin(theta)


def gcj02_to_bd09(lon, lat):
    z = math.sqrt(lon * lon + lat * lat) + 0.00002 * math.sin(lat * _X_PI)
    theta = math.atan2(lat, lon) + 0.000003 * math.cos(lon * _X_PI)
    return z * math.cos(theta) + 0.0065, z * math.sin(theta) + 0.006


def to_wgs84(lon, lat, coord_type="wgs84"):
    t = str(coord_type).lower().replace("-", "").replace("_", "")
    if t in ("wgs84", "gps"):
        return float(lon), float(lat)
    if t in ("gcj02", "gcj", "amap", "gaode", "tencent"):
        return gcj02_to_wgs84(float(lon), float(lat))
    if t in ("bd09", "bd09ll", "baidu"):
        return gcj02_to_wgs84(*bd09_to_gcj02(float(lon), float(lat)))
    raise ValueError("coord_type must be wgs84, gcj02 or bd09")


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
