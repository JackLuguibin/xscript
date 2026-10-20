import unittest

from xscript.android import coords, location as xloc
from ascript.android import location as aloc

# Tiananmen: WGS84 and its well-known GCJ-02 / BD-09 values (as shown by 高德 / 百度 maps), ~1e-5 degrees ≈ 1 m.
WGS = (116.391275, 39.906217)


class CoordsTest(unittest.TestCase):
    def close(self, a, b, tol=2e-6):
        self.assertAlmostEqual(a[0], b[0], delta=tol)
        self.assertAlmostEqual(a[1], b[1], delta=tol)

    def test_round_trips(self):
        g = coords.wgs84_to_gcj02(*WGS)
        b = coords.wgs84_to_bd09(*WGS)
        self.assertGreater(abs(g[0] - WGS[0]), 1e-3)  # GCJ-02 is offset by hundreds of metres in China
        self.close(coords.gcj02_to_bd09(*g), b, 1e-9)
        self.close(coords.bd09_to_wgs84(*b), WGS)
        self.close(coords.gcj02_to_wgs84(*g), WGS)

    def test_convert_all_pairs(self):
        pts = {"wgs84": WGS, "gcj02": coords.wgs84_to_gcj02(*WGS), "bd09": coords.wgs84_to_bd09(*WGS)}
        for src in pts:
            for dst in pts:
                self.close(coords.convert(*pts[src], src, dst), pts[dst], 3e-6)
        self.close(coords.to_wgs84(*pts["bd09"], "baidu"), WGS)
        self.close(coords.from_wgs84(*WGS), pts["gcj02"], 1e-12)  # default gcj02 (高德 / 腾讯)
        self.close(coords.from_wgs84(*WGS, coord_type="BD-09"), pts["bd09"], 1e-12)

    def test_aliases_and_errors(self):
        for name, want in (("GPS", "wgs84"), ("gcj_02", "gcj02"), ("amap", "gcj02"), ("tencent", "gcj02"),
                           ("bd09ll", "bd09"), ("Baidu", "bd09")):
            self.assertEqual(coords.coord_type(name), want)
        with self.assertRaises(ValueError):
            coords.convert(1, 2, "utm", "wgs84")
        with self.assertRaises(ValueError):
            coords.from_wgs84(1, 2, "mercator")
        self.assertEqual(coords.convert("116.4", "39.9", "wgs84", "wgs84"), (116.4, 39.9))

    def test_outside_china_unchanged(self):
        london = (-0.1276, 51.5072)
        self.assertEqual(coords.wgs84_to_gcj02(*london), london)
        self.assertEqual(coords.convert(*london, "gcj02", "wgs84"), london)

    def test_same_functions_in_both_location_modules(self):
        for name in ("wgs84_to_gcj02", "gcj02_to_wgs84", "bd09_to_gcj02", "gcj02_to_bd09", "wgs84_to_bd09",
                     "bd09_to_wgs84", "to_wgs84", "from_wgs84", "convert"):
            self.assertIs(getattr(xloc, name), getattr(coords, name), name)
            self.assertIs(getattr(aloc, name), getattr(coords, name), name)
        self.assertIs(xloc.coord_type, coords.coord_type)


if __name__ == "__main__":
    unittest.main()
