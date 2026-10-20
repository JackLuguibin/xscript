"""Android WGS84 location; shares the AScript subscription and cleanup state.

Coordinate converters (WGS84 / GCJ-02 高德 / BD-09 百度) come from xscript.android.coords.
"""
from ascript.android.location import Location, request, get_last, close, mock
from xscript.android.coords import (
    wgs84_to_gcj02, gcj02_to_wgs84, bd09_to_gcj02, gcj02_to_bd09, wgs84_to_bd09, bd09_to_wgs84,
    to_wgs84, from_wgs84, convert, coord_type,
)
