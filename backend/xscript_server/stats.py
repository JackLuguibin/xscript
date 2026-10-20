"""Daily trend series for the 概览 page: activations, expirations, new and online devices.

Days are server-local calendar days (the same clock as the daily backup), oldest first.
Only the needed columns are loaded; bucketing happens in Python so the SQL stays portable.
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Card, Device, DeviceDay


def _day(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def day_range(days: int, now: float | None = None) -> tuple[list[str], int]:
    """The last `days` local dates ending today, and the epoch second of the first one's midnight."""
    lt = time.localtime(time.time() if now is None else now)
    # mktime normalizes day underflow across months / years; noon avoids DST edge hours.
    labels = [_day(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday - i, 12, 0, 0, 0, 0, -1)))
              for i in range(days - 1, -1, -1)]
    first = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday - (days - 1), 0, 0, 0, 0, 0, -1))
    return labels, int(first)


def daily(s: Session, days: int = 30, app: str = "", batch: str = "", now: float | None = None,
          owner_id: int | None = None, cards_only: bool = False) -> dict[str, Any]:
    """Trend series. owner_id limits card series to one reseller's cards; cards_only leaves out the device
    series (a reseller must not see fleet-wide device numbers)."""
    now = time.time() if now is None else now
    labels, start = day_range(days, now)
    index = {d: i for i, d in enumerate(labels)}

    def series(stamps) -> list[int]:
        out = [0] * len(labels)
        for ts in stamps:
            i = index.get(_day(ts))
            if i is not None:
                out[i] += 1
        return out

    card_filter = []
    if app:
        card_filter.append(Card.app == app)
    if batch:
        card_filter.append(Card.batch == batch)
    if owner_id is not None:
        card_filter.append(Card.owner_id == owner_id)

    act_rows = s.execute(select(Card.activated_at, Card.app, Card.batch)
                         .where(Card.activated_at.is_not(None), Card.activated_at >= start, *card_filter)).all()
    exp_rows = s.scalars(select(Card.expires_at).where(
        Card.expires_at.is_not(None), Card.expires_at > 0, Card.expires_at >= start, Card.expires_at <= now,
        Card.revoked.is_(False), *card_filter)).all()
    upcoming = s.scalar(select(func.count()).select_from(Card).where(
        Card.expires_at > now, Card.expires_at <= now + 7 * 86400, Card.revoked.is_(False), *card_filter)) or 0

    def top(values, limit=8):
        return [{"name": k or "(全部)", "count": n} for k, n in Counter(values).most_common(limit)]

    activations = series(r[0] for r in act_rows)
    expirations = series(exp_rows)
    if cards_only:
        created = series(s.scalars(select(Card.created_at).where(Card.created_at >= start, *card_filter)).all())
        return {
            "days": labels,
            "series": {"created": created, "activations": activations, "expirations": expirations},
            "totals": {"created": sum(created), "activations": sum(activations), "expirations": sum(expirations)},
            "expiring_7d": upcoming,
            "by_app": top(r[1] for r in act_rows),
            "by_batch": top(r[2] for r in act_rows if r[2]),
            "timezone": time.strftime("%z", time.localtime(now)),
        }

    dev_filter = [Device.app == app] if app else []
    new_rows = s.scalars(select(Device.first_seen).where(Device.first_seen >= start, *dev_filter)).all()
    online_q = select(DeviceDay.day, func.count()).where(DeviceDay.day >= labels[0]).group_by(DeviceDay.day)
    if app:
        online_q = online_q.join(Device, Device.id == DeviceDay.device).where(Device.app == app)
    online = [0] * len(labels)
    for d, n in s.execute(online_q):
        if d in index:
            online[index[d]] = int(n)

    new_devices = series(new_rows)
    return {
        "days": labels,
        "series": {"activations": activations, "expirations": expirations,
                   "new_devices": new_devices, "online_devices": online},
        "totals": {"activations": sum(activations), "expirations": sum(expirations),
                   "new_devices": sum(new_devices), "online_peak": max(online) if online else 0},
        "expiring_7d": upcoming,
        "by_app": top(r[1] for r in act_rows),
        "by_batch": top(r[2] for r in act_rows if r[2]),
        "timezone": time.strftime("%z", time.localtime(now)),
    }
