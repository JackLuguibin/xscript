"""卡密 database operations on top of the Card table."""

from __future__ import annotations

import secrets
import time
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import licensing
from .models import Card

STATUSES = ("unused", "active", "expired", "unbound", "revoked")


def status_of(c: Card, now: float | None = None) -> str:
    now = now or time.time()
    if c.revoked:
        return "revoked"
    if not c.device:
        return "unbound" if c.activated_at else "unused"
    if c.expires_at and c.expires_at <= now:
        return "expired"
    return "active"


def status_filter(status: str, now: int):
    if status == "revoked":
        return Card.revoked.is_(True)
    live = Card.revoked.is_(False)
    if status == "unused":
        return and_(live, Card.device.is_(None), Card.activated_at.is_(None))
    if status == "unbound":
        return and_(live, Card.device.is_(None), Card.activated_at.is_not(None))
    not_expired = or_(Card.expires_at.is_(None), Card.expires_at == 0, Card.expires_at > now)
    if status == "active":
        return and_(live, Card.device.is_not(None), not_expired)
    if status == "expired":
        return and_(live, Card.device.is_not(None), Card.expires_at > 0, Card.expires_at <= now)
    raise ValueError("unknown status " + status)


def to_dict(c: Card, now: float | None = None) -> dict[str, Any]:
    return {
        "card": c.card, "batch": c.batch, "days": c.days, "app": c.app, "note": c.note,
        "created_at": c.created_at, "device": c.device, "model": c.model,
        "activated_at": c.activated_at, "expires_at": c.expires_at, "revoked": c.revoked,
        "last_verified_at": c.last_verified_at, "status": status_of(c, now),
    }


def normalize(card: str) -> str:
    return (card or "").strip().upper()


def new_batch_id() -> str:
    return time.strftime("%Y%m%d") + "-" + secrets.token_hex(3)


def create_batch(s: Session, count: int, days: float, app: str, note: str = "", prefix: str = "XS",
                 batch: str | None = None) -> tuple[str, list[str]]:
    batch = batch or new_batch_id()
    codes: list[str] = []
    now = int(time.time())
    while len(codes) < count:
        code = licensing.new_card(prefix)
        try:
            with s.begin_nested():
                s.add(Card(card=code, batch=batch, days=float(days), app=app or "*", note=note, created_at=now))
            codes.append(code)
        except IntegrityError:  # astronomically unlikely collision
            continue
    return batch, codes


def activate(s: Session, key, card: str, device: str, app: str, model: str = "",
             now: int | None = None) -> tuple[str | None, str | None]:
    """Bind the card to `device` on first use; return (token, None) or (None, error). Commits."""
    now = int(now or time.time())
    code = normalize(card)
    row = s.get(Card, code)
    if row is None:
        return None, "卡密不存在"
    if row.revoked:
        return None, "卡密已停用"
    if row.app not in ("*", app):
        return None, "卡密不属于此应用"
    if row.device and row.device != device:
        return None, "卡密已绑定其他设备"
    if not row.device:
        # First activation starts the clock; re-binding after 解绑 keeps the original expiry.
        values: dict[str, Any] = {"device": device, "model": model}
        if not row.activated_at:
            values.update(activated_at=now, expires_at=now + int(row.days * 86400) if row.days else 0)
        # Conditional update so two devices racing for one card cannot both win.
        res = s.execute(update(Card).where(Card.card == code, Card.device.is_(None)).values(**values))
        s.commit()
        s.refresh(row)
        if res.rowcount == 0 and row.device != device:
            return None, "卡密已绑定其他设备"
    if row.expires_at and row.expires_at <= now:
        return None, "卡密已过期"
    payload = {"card": row.card, "device": device, "app": app, "iat": now, "exp": int(row.expires_at or 0)}
    return licensing.sign(key, payload), None


def check_token(s: Session, payload: dict[str, Any]) -> str:
    """Re-verification for apps: "ok", "revoked", "expired" or "unknown". Commits."""
    row = s.get(Card, normalize(str(payload.get("card", ""))))
    if row is None:
        return "unknown"
    row.last_verified_at = int(time.time())
    s.commit()
    if row.revoked:
        return "revoked"
    if row.device and payload.get("device") not in ("*", row.device):
        return "revoked"
    if row.expires_at and row.expires_at <= time.time():
        return "expired"
    return "ok"


def issue_offline(s: Session, key, device: str, days: float, app: str, note: str = "") -> tuple[str, dict[str, Any]]:
    """Offline token, recorded as an already-bound card so it can be listed and revoked."""
    token, payload = licensing.issue(key, device, days, app)
    s.add(Card(card=payload["card"], batch="offline", days=float(days), app=app or "*", note=note,
               created_at=payload["iat"], device=device or "*", activated_at=payload["iat"],
               expires_at=payload["exp"]))
    return token, payload


def stats(s: Session) -> dict[str, int]:
    now = int(time.time())
    out = {st: s.scalar(select(func.count()).select_from(Card).where(status_filter(st, now))) or 0 for st in STATUSES}
    out["total"] = s.scalar(select(func.count()).select_from(Card)) or 0
    return out
