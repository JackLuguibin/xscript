"""卡密 abuse detection: card sharing, one device burning many cards, one IP feeding many devices,
and card guessing. Kept in memory and, when a database session is passed to observe(), written through to the
abuse_events / abuse_reports tables and reloaded by load() at start, so a restart does not reset
the windows or the one-report-per-hour cooldown. Every finding is also written to the
audit log (action card.abuse) and pushed through the card_abuse alert webhooks.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from .models import AbuseEvent, AbuseReport

WINDOW_S = 24 * 3600
COOLDOWN_S = 3600  # one report per signal and subject per hour

SIGNALS = {
    "card_shared": "卡密疑似被多人共享",
    "device_many_cards": "单设备短时间激活大量卡密",
    "ip_many_devices": "单 IP 为大量设备激活卡密",
    "ip_guessing": "疑似暴力猜卡密",
}
# settings key per signal; 0 switches that signal off
SETTING_KEYS = {
    "card_shared": "abuse_card_devices",
    "device_many_cards": "abuse_device_cards",
    "ip_many_devices": "abuse_ip_devices",
    "ip_guessing": "abuse_ip_failures",
}


@dataclass
class Finding:
    signal: str
    subject: str
    count: int
    threshold: int
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def title(self) -> str:
        return "%s · %s" % (SIGNALS[self.signal], self.subject)

    @property
    def text(self) -> str:
        return "%s：%s，24 小时内 %d 次（阈值 %d）。" % (SIGNALS[self.signal], self.subject, self.count, self.threshold)


class AbuseMonitor:
    def __init__(self) -> None:
        self._last_prune = 0.0
        self._lock = threading.Lock()
        self._seen: dict[tuple[str, str], dict[str, float]] = {}
        self._reported: dict[tuple[str, str], float] = {}

    def load(self, s: Session, now: float | None = None) -> int:
        """Reload the windows from the database (at start). Returns the number of events restored."""
        now = now or time.time()
        n = 0
        with self._lock:
            for r in s.scalars(select(AbuseEvent).where(AbuseEvent.ts > now - WINDOW_S)):
                self._seen.setdefault((r.signal, r.subject), {})[r.member] = r.ts
                n += 1
            for r in s.scalars(select(AbuseReport).where(AbuseReport.ts > now - COOLDOWN_S)):
                self._reported[(r.signal, r.subject)] = r.ts
        return n

    def _hit(self, signal: str, subject: str, member: str, now: float, threshold: int,
             writes: list | None = None) -> Finding | None:
        if threshold <= 0 or not subject:
            return None
        key = (signal, subject)
        members = self._seen.setdefault(key, {})
        members[member] = now
        if writes is not None:
            writes.append(("event", signal, subject[:160], member[:200], now))
        for m in [m for m, t in members.items() if now - t > WINDOW_S]:
            del members[m]
        if len(members) < threshold or now - self._reported.get(key, 0) < COOLDOWN_S:
            return None
        self._reported[key] = now
        if writes is not None:
            writes.append(("report", signal, subject[:160], "", now))
        if len(self._seen) > 20000:  # bound memory under a flood
            self._seen = {k: v for k, v in self._seen.items() if v and now - max(v.values()) < WINDOW_S}
            self._reported = {k: t for k, t in self._reported.items() if now - t < COOLDOWN_S}
        return Finding(signal, subject, len(members), threshold)

    def observe(self, code: str, card: str, device: str, ip: str, thresholds: dict[str, Any],
                now: float | None = None, s: Session | None = None) -> list[Finding]:
        """One activation attempt. `code` is Activation.code; returns new findings (usually none).
        With a session [s] the observation is also written to the database (the caller commits)."""
        now = now or time.time()
        th = {sig: int(thresholds.get(key) or 0) for sig, key in SETTING_KEYS.items()}
        out: list[Finding | None] = []
        writes: list | None = [] if s is not None else None
        with self._lock:
            if code in ("bound_other", "limit"):
                # Distinct devices turned away from one card.
                out.append(self._hit("card_shared", card, device, now, th["card_shared"], writes))
            elif code == "ok":
                out.append(self._hit("device_many_cards", device, card, now, th["device_many_cards"], writes))
                out.append(self._hit("ip_many_devices", ip, device, now, th["ip_many_devices"], writes))
            elif code == "not_found":
                out.append(self._hit("ip_guessing", ip, "%r|%s" % (now, card), now, th["ip_guessing"], writes))
        if s is not None and writes:
            self._persist(s, writes, now)
        found = [f for f in out if f]
        for f in found:
            f.detail = {"signal": f.signal, "count": f.count, "threshold": f.threshold}
        return found

    def _persist(self, s: Session, writes: list, now: float) -> None:
        for kind, signal, subject, member, ts in writes:
            if kind == "event":
                stmt = sqlite_insert(AbuseEvent).values(signal=signal, subject=subject, member=member, ts=ts)
                s.execute(stmt.on_conflict_do_update(index_elements=["signal", "subject", "member"], set_={"ts": ts}))
            else:
                stmt = sqlite_insert(AbuseReport).values(signal=signal, subject=subject, ts=ts)
                s.execute(stmt.on_conflict_do_update(index_elements=["signal", "subject"], set_={"ts": ts}))
        if now - self._last_prune > 600:  # keep the tables to the 24 h window
            self._last_prune = now
            s.execute(delete(AbuseEvent).where(AbuseEvent.ts < now - WINDOW_S))
            s.execute(delete(AbuseReport).where(AbuseReport.ts < now - COOLDOWN_S))
