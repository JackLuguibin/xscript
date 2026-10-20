"""China coordinate systems: WGS84 (GPS, what Android reports), GCJ-02 (高德 / 腾讯 / 谷歌中国) and BD-09 (百度).

All functions take and return (lon, lat) in degrees. Outside mainland China GCJ-02 equals WGS84, so the
WGS84 <-> GCJ-02 functions return the input there unchanged. Pure Python, no device needed.
Same names as AScript's ``ascript.android.location`` (which re-exports these).
"""
import math

COORD_TYPES = ("wgs84", "gcj02", "bd09")

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
    """WGS84 (GPS) -> GCJ-02 (高德 / 腾讯). Unchanged outside China."""
    if _out_of_china(lon, lat):
        return lon, lat
    dlon, dlat = _delta(lon, lat)
    return lon + dlon, lat + dlat


def gcj02_to_wgs84(lon, lat):
    """GCJ-02 -> WGS84 by iterating the forward transform (error well under 1 m inside China)."""
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
    """BD-09 (百度) -> GCJ-02."""
    x, y = lon - 0.0065, lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * _X_PI)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * _X_PI)
    return z * math.cos(theta), z * math.sin(theta)


def gcj02_to_bd09(lon, lat):
    """GCJ-02 -> BD-09 (百度)."""
    z = math.sqrt(lon * lon + lat * lat) + 0.00002 * math.sin(lat * _X_PI)
    theta = math.atan2(lat, lon) + 0.000003 * math.cos(lon * _X_PI)
    return z * math.cos(theta) + 0.0065, z * math.sin(theta) + 0.006


def wgs84_to_bd09(lon, lat):
    """WGS84 (GPS) -> BD-09 (百度), via GCJ-02."""
    return gcj02_to_bd09(*wgs84_to_gcj02(lon, lat))


def bd09_to_wgs84(lon, lat):
    """BD-09 (百度) -> WGS84 (GPS), via GCJ-02."""
    return gcj02_to_wgs84(*bd09_to_gcj02(lon, lat))


def coord_type(name):
    """Normalise a coordinate system name: wgs84 / gps, gcj02 / gcj / amap / gaode / tencent, bd09 / bd09ll / baidu."""
    t = str(name).lower().replace("-", "").replace("_", "")
    if t in ("wgs84", "gps"):
        return "wgs84"
    if t in ("gcj02", "gcj", "amap", "gaode", "tencent"):
        return "gcj02"
    if t in ("bd09", "bd09ll", "baidu"):
        return "bd09"
    raise ValueError("coord_type must be wgs84, gcj02 or bd09, got %r" % (name,))


def to_wgs84(lon, lat, coord_type="wgs84"):
    """(lon, lat) in `coord_type` (wgs84 / gcj02 / bd09, aliases as in coord_type()) -> WGS84."""
    return convert(lon, lat, coord_type, "wgs84")


def from_wgs84(lon, lat, coord_type="gcj02"):
    """WGS84 (e.g. location.get_last()) -> `coord_type`, e.g. for a 高德 (gcj02) or 百度 (bd09) map link."""
    return convert(lon, lat, "wgs84", coord_type)


def convert(lon, lat, from_type, to_type):
    """(lon, lat) from one coordinate system to another (wgs84 / gcj02 / bd09)."""
    src, dst = coord_type(from_type), coord_type(to_type)
    lon, lat = float(lon), float(lat)
    if src == dst:
        return lon, lat
    if src == "bd09":
        lon, lat = bd09_to_gcj02(lon, lat)
    elif src == "wgs84":
        lon, lat = wgs84_to_gcj02(lon, lat)
    # now GCJ-02
    if dst == "gcj02":
        return lon, lat
    if dst == "bd09":
        return gcj02_to_bd09(lon, lat)
    return gcj02_to_wgs84(lon, lat)
