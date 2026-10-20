"""概览 趋势图: stats.daily buckets activations, expirations, new and online devices by server-local day."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from xscript_server import stats
    from xscript_server.db import Base
    from xscript_server.models import Card, Device, DeviceDay
except ImportError as e:  # pragma: no cover
    SKIP = "server deps missing: %s" % e
else:
    SKIP = ""


def at(day_offset: int, hour: int = 10, now: float = 0.0) -> int:
    """Epoch seconds of `hour`:00 local time, `day_offset` days from `now`'s date (negative = past)."""
    lt = time.localtime(now)
    return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + day_offset, hour, 0, 0, 0, 0, -1)))


@unittest.skipIf(SKIP, SKIP)
class DailyStatsTest(unittest.TestCase):
    def setUp(self):
        # Fixed "now": 2026-03-02 15:00 local, so the 7-day window crosses a month end (Feb has 28 days).
        self.now = time.mktime((2026, 3, 2, 15, 0, 0, 0, 0, -1))
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.s = Session(engine)
        self.addCleanup(self.s.close)
        n = self.now
        cards = [
            Card(card="A1", app="com.a", batch="b1", activated_at=at(0, now=n), expires_at=at(30, now=n)),
            Card(card="A2", app="com.a", batch="b1", activated_at=at(0, 1, now=n), expires_at=at(3, now=n)),
            Card(card="A3", app="com.a", batch="b2", activated_at=at(-1, now=n), expires_at=0),
            Card(card="B1", app="com.b", batch="b2", activated_at=at(-6, now=n), expires_at=at(-2, now=n)),
            Card(card="B2", app="com.b", batch="", activated_at=at(-7, now=n), expires_at=at(-1, now=n)),  # out of range
            Card(card="R1", app="com.b", batch="b2", activated_at=at(-3, now=n), expires_at=at(-1, now=n), revoked=True),
            Card(card="U1", app="com.a", batch="b1"),  # never activated
            Card(card="F1", app="com.a", batch="b1", activated_at=at(-2, now=n), expires_at=at(1, 23, now=n)),
        ]
        self.s.add_all(cards)
        self.s.add_all([
            Device(id="d1", device_id="d1", app="com.a", first_seen=at(0, now=n), last_seen=at(0, now=n)),
            Device(id="d2", device_id="d2", app="com.b", first_seen=at(-5, now=n), last_seen=at(0, now=n)),
            Device(id="d3", device_id="d3", app="com.a", first_seen=at(-40, now=n), last_seen=at(-1, now=n)),
        ])
        days, _ = stats.day_range(7, self.now)
        self.s.add_all([DeviceDay(day=days[-1], device="d1"), DeviceDay(day=days[-1], device="d2"),
                        DeviceDay(day=days[-2], device="d3"), DeviceDay(day=days[-2], device="d2"),
                        DeviceDay(day=days[0], device="d2"), DeviceDay(day="2025-01-01", device="d1")])
        self.s.commit()

    def test_day_range_crosses_month_end(self):
        days, start = stats.day_range(7, self.now)
        self.assertEqual(days, ["2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27", "2026-02-28",
                                "2026-03-01", "2026-03-02"])
        self.assertEqual(time.strftime("%Y-%m-%d %H:%M", time.localtime(start)), "2026-02-24 00:00")
        self.assertEqual(len(stats.day_range(365, self.now)[0]), 365)

    def test_series_totals_and_breakdowns(self):
        d = stats.daily(self.s, 7, now=self.now)
        self.assertEqual(d["days"][-1], "2026-03-02")
        sr = d["series"]
        # A1, A2 today; A3 yesterday; F1 two days ago; R1 (revoked, still activated) three days ago; B1 six days ago.
        self.assertEqual(sr["activations"], [1, 0, 0, 1, 1, 1, 2])
        # B1 expired 2 days ago; B2 expired yesterday (activated before the window, still counted);
        # R1 revoked: excluded; A2 / F1 / A1 expire in the future.
        self.assertEqual(sr["expirations"], [0, 0, 0, 0, 1, 1, 0])
        self.assertEqual(sr["new_devices"], [0, 1, 0, 0, 0, 0, 1])
        self.assertEqual(sr["online_devices"], [1, 0, 0, 0, 0, 2, 2])
        self.assertEqual(d["totals"], {"activations": 6, "expirations": 2, "new_devices": 2, "online_peak": 2})
        self.assertEqual(d["expiring_7d"], 2)  # A2 (+3 d) and F1 (+1 d); A1 is +30 d
        self.assertEqual(d["by_app"][0], {"name": "com.a", "count": 4})
        self.assertEqual({x["name"]: x["count"] for x in d["by_batch"]}, {"b1": 3, "b2": 3})
        self.assertRegex(d["timezone"], r"^[+-]\d{4}$")

    def test_filters(self):
        a = stats.daily(self.s, 7, app="com.a", now=self.now)
        self.assertEqual(a["totals"]["activations"], 4)
        self.assertEqual(a["series"]["new_devices"][-1], 1)
        self.assertEqual(a["series"]["online_devices"], [0, 0, 0, 0, 0, 1, 1])  # d3 yesterday, d1 today
        self.assertEqual(a["expiring_7d"], 2)
        b = stats.daily(self.s, 7, batch="b2", now=self.now)
        self.assertEqual(b["totals"]["activations"], 3)
        self.assertEqual(b["totals"]["expirations"], 1)  # B1; R1 revoked
        self.assertEqual(stats.daily(self.s, 7, app="nope", now=self.now)["totals"],
                         {"activations": 0, "expirations": 0, "new_devices": 0, "online_peak": 0})

    def test_long_window_includes_older_rows(self):
        d = stats.daily(self.s, 90, now=self.now)
        self.assertEqual(len(d["days"]), 90)
        self.assertEqual(d["totals"]["activations"], 7)  # B2 now inside the window
        self.assertEqual(d["totals"]["new_devices"], 3)


if __name__ == "__main__":
    unittest.main()
