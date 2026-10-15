"""卡密 database operations on top of the Card table."""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import licensing
from .models import Card, CardDevice, DeviceBan, TrialUse

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


def bound_devices(c: Card) -> dict[str, str]:
    """device id -> model of every device holding the card (first one, then the extras)."""
    out: dict[str, str] = {}
    if c.device:
        out[c.device] = c.model or ""
    for e in c.extras:
        out.setdefault(e.device, e.model or "")
    return out


def to_dict(c: Card, now: float | None = None) -> dict[str, Any]:
    devices = bound_devices(c)
    return {
        "card": c.card, "batch": c.batch, "days": c.days, "app": c.app, "note": c.note,
        "created_at": c.created_at, "device": c.device, "model": c.model,
        "activated_at": c.activated_at, "expires_at": c.expires_at, "revoked": c.revoked,
        "last_verified_at": c.last_verified_at, "status": status_of(c, now),
        "kind": c.kind or "normal", "max_devices": c.max_devices or 1, "stack": bool(c.stack),
        "devices": [{"device": d, "model": m} for d, m in devices.items()],
    }


def normalize(card: str) -> str:
    return (card or "").strip().upper()


def new_batch_id() -> str:
    return time.strftime("%Y%m%d") + "-" + secrets.token_hex(3)


def create_batch(s: Session, count: int, days: float, app: str, note: str = "", prefix: str = "XS",
                 batch: str | None = None, kind: str = "normal", max_devices: int = 1,
                 stack: bool = True) -> tuple[str, list[str]]:
    if kind not in ("normal", "trial"):
        raise ValueError("未知卡类型")
    if kind == "trial":  # a trial is short, single-device and never stacks
        if not 0 < days <= 30:
            raise ValueError("体验卡有效期必须在 0 到 30 天之间")
        max_devices, stack = 1, False
    batch = batch or new_batch_id()
    codes: list[str] = []
    now = int(time.time())
    while len(codes) < count:
        code = licensing.new_card(prefix)
        try:
            with s.begin_nested():
                s.add(Card(card=code, batch=batch, days=float(days), app=app or "*", note=note, created_at=now,
                           kind=kind, max_devices=max(1, int(max_devices)), stack=bool(stack)))
            codes.append(code)
        except IntegrityError:  # astronomically unlikely collision
            continue
    return batch, codes


@dataclass
class Activation:
    token: str | None = None
    error: str | None = None
    code: str = "ok"  # ok | not_found | revoked | wrong_app | bound_other | limit | trial_used | expired | device_banned
    card: Card | None = None
    new_device: bool = False  # this call bound a device that was not bound before


def _stack_base(s: Session, device: str, app: str, now: int, skip: str) -> int:
    """Where a new card's validity starts: the latest expiry among the device's running cards of this app."""
    held = (Card.device == device) | Card.card.in_(select(CardDevice.card).where(CardDevice.device == device))
    rows = s.scalars(select(Card).where(held, Card.revoked.is_(False), Card.card != skip,
                                        Card.app.in_(("*", app)), Card.activated_at.is_not(None)))
    base = now
    for r in rows:
        if r.expires_at == 0:
            return now  # a permanent card is already running; nothing to stack onto
        if r.expires_at and r.expires_at > base:
            base = int(r.expires_at)
    return base


def _claim_trial(s: Session, device: str, app: str, card: str, now: int) -> bool:
    """Record the device's one trial for this app. False if it already had one (another card)."""
    existing = s.scalar(select(TrialUse).where(TrialUse.device == device, TrialUse.app == app))
    if existing is not None:
        return existing.card == card
    try:
        with s.begin_nested():
            s.add(TrialUse(device=device, app=app, card=card, used_at=now))
    except IntegrityError:  # another request just claimed it
        return False
    return True


def activate_ex(s: Session, key, card: str, device: str, app: str, model: str = "",
                now: int | None = None) -> Activation:
    """Bind the card to `device` and sign a token. Commits when it binds or fails after changes."""
    now = int(now or time.time())
    code = normalize(card)
    if device != "*" and s.get(DeviceBan, device) is not None:
        return Activation(error="此设备已被禁止激活卡密", code="device_banned")
    row = s.get(Card, code)
    if row is None:
        return Activation(error="卡密不存在", code="not_found")
    if row.revoked:
        return Activation(error="卡密已停用", code="revoked", card=row)
    if row.app not in ("*", app):
        return Activation(error="卡密不属于此应用", code="wrong_app", card=row)
    bound = bound_devices(row)
    limit = max(1, row.max_devices or 1)
    new_device = False
    if device in bound:
        pass
    elif bound:
        if len(bound) >= limit:
            if limit == 1:
                return Activation(error="卡密已绑定其他设备", code="bound_other", card=row)
            return Activation(error="卡密绑定的设备数已达上限（%d 台）" % limit, code="limit", card=row)
        if row.kind == "trial" and not _claim_trial(s, device, app, row.card, now):
            s.rollback()
            return Activation(error="此设备已使用过体验卡", code="trial_used", card=row)
        try:
            with s.begin_nested():
                s.add(CardDevice(card=row.card, device=device, model=model, bound_at=now))
                s.flush()
                # Insert first, then count: two devices racing for the last seat cannot both stay.
                n = s.scalar(select(func.count()).select_from(CardDevice).where(CardDevice.card == row.card)) or 0
                if n + 1 > limit:
                    raise IntegrityError("limit", None, Exception("limit"))
        except IntegrityError:
            s.rollback()
            return Activation(error="卡密绑定的设备数已达上限（%d 台）" % limit, code="limit", card=row)
        s.commit()
        s.refresh(row)
        new_device = True
    else:
        if row.kind == "trial" and not _claim_trial(s, device, app, row.card, now):
            s.rollback()
            return Activation(error="此设备已使用过体验卡", code="trial_used", card=row)
        # First activation starts the clock; re-binding after 解绑 keeps the original expiry.
        values: dict[str, Any] = {"device": device, "model": model}
        if not row.activated_at:
            expires = 0
            if row.days:
                base = now
                if row.kind != "trial" and row.stack and limit == 1:
                    base = _stack_base(s, device, app, now, row.card)
                expires = base + int(row.days * 86400)
            values.update(activated_at=now, expires_at=expires)
        # Conditional update so two devices racing for one card cannot both win.
        res = s.execute(update(Card).where(Card.card == code, Card.device.is_(None)).values(**values))
        s.commit()
        s.refresh(row)
        if res.rowcount == 0 and row.device != device:
            if row.kind == "trial":  # lost the race: give the loser its trial back
                s.execute(delete(TrialUse).where(TrialUse.device == device, TrialUse.app == app,
                                                 TrialUse.card == row.card))
                s.commit()
            return Activation(error="卡密已绑定其他设备" if limit == 1 else "卡密绑定的设备数已达上限（%d 台）" % limit,
                              code="bound_other" if limit == 1 else "limit", card=row)
        new_device = res.rowcount > 0
    if row.expires_at and row.expires_at <= now:
        return Activation(error="卡密已过期", code="expired", card=row)
    payload = {"card": row.card, "device": device, "app": app, "iat": now, "exp": int(row.expires_at or 0)}
    return Activation(token=licensing.sign(key, payload), card=row, new_device=new_device)


def activate(s: Session, key, card: str, device: str, app: str, model: str = "",
             now: int | None = None) -> tuple[str | None, str | None]:
    """Bind the card to `device` on first use; return (token, None) or (None, error). Commits."""
    r = activate_ex(s, key, card, device, app, model, now)
    return r.token, r.error


def unbind(s: Session, c: Card, device: str | None = None) -> int:
    """Release all devices, or just `device` (the next one then becomes the first). Returns how many."""
    bound = bound_devices(c)
    if device is None:
        n = len(bound)
        c.device, c.model = None, None
        for e in list(c.extras):
            c.extras.remove(e)
        return n
    if device not in bound:
        return 0
    if device == c.device:
        nxt = c.extras[0] if c.extras else None
        if nxt is not None:
            c.device, c.model = nxt.device, nxt.model
            c.extras.remove(nxt)
        else:
            c.device, c.model = None, None
    else:
        for e in list(c.extras):
            if e.device == device:
                c.extras.remove(e)
    return 1


def check_token(s: Session, payload: dict[str, Any]) -> str:
    """Re-verification for apps: "ok", "revoked", "expired" or "unknown". Commits."""
    row = s.get(Card, normalize(str(payload.get("card", ""))))
    if row is None:
        return "unknown"
    row.last_verified_at = int(time.time())
    s.commit()
    if row.revoked:
        return "revoked"
    dev = payload.get("device")
    if dev and dev != "*" and s.get(DeviceBan, str(dev)) is not None:
        return "revoked"  # a banned device loses its licenses at the next re-verification
    bound = bound_devices(row)
    if bound and payload.get("device") not in ("*", *bound):
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
