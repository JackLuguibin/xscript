"""卡密 management API and the public /license/* endpoints that packaged apps call."""

from __future__ import annotations

import csv
import io
import logging
import time
from typing import Literal

from anyio import from_thread
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import cards as cardsvc
from .. import licensing
from ..abuse import SIGNALS as ABUSE_SIGNALS
from ..audit import get_settings
from ..deps import Principal, admin, client_ip, ctx, db_session, like_contains, operator, paginate, record, viewer
from ..models import AuditLog, Card, DeviceBan

log = logging.getLogger("xscript.cards")
router = APIRouter(prefix="/api/cards", tags=["cards"])
public = APIRouter(prefix="/license", tags=["license"])

APP_PATTERN = r"^(\*|[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+)$"


def _filtered(q: str, status: str, app: str, batch: str, kind: str = ""):
    stmt = select(Card)
    if kind:
        stmt = stmt.where(Card.kind == kind)
    if q:
        like = like_contains(q)
        stmt = stmt.where(or_(Card.card.like(like_contains(q.upper()), escape="\\"),
                              Card.device.like(like, escape="\\"), Card.note.like(like, escape="\\")))
    if status:
        try:
            stmt = stmt.where(cardsvc.status_filter(status, int(time.time())))
        except ValueError:
            raise HTTPException(400, "未知状态") from None
    if app:
        stmt = stmt.where(Card.app == app)
    if batch:
        stmt = stmt.where(Card.batch == batch)
    return stmt


@router.get("")
def list_cards(p: Principal = Depends(viewer), s: Session = Depends(db_session), q: str = "", status: str = "",
               app: str = "", batch: str = "", kind: str = "", page: int = 1, page_size: int = 50):
    stmt = _filtered(q, status, app, batch, kind)
    total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    off, size = paginate(page, page_size)
    now = time.time()
    rows = s.scalars(stmt.order_by(Card.created_at.desc(), Card.card).offset(off).limit(size))
    return {"items": [cardsvc.to_dict(c, now) for c in rows], "total": total}


@router.get("/stats")
def card_stats(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    return cardsvc.stats(s)


@router.get("/batches")
def list_batches(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    rows = s.execute(select(Card.batch, Card.app, Card.days, Card.note, func.count(), func.min(Card.created_at),
                            func.count(Card.device), func.max(Card.kind), func.max(Card.max_devices))
                     .group_by(Card.batch).order_by(func.min(Card.created_at).desc()).limit(500)).all()
    return {"items": [{"batch": r[0], "app": r[1], "days": r[2], "note": r[3], "count": r[4], "created_at": r[5],
                       "bound": r[6], "kind": r[7] or "normal", "max_devices": r[8] or 1} for r in rows]}


@router.get("/abuse")
def abuse_findings(p: Principal = Depends(viewer), s: Session = Depends(db_session), limit: int = 100):
    """Recent 卡密滥用告警 findings (also in the audit log as card.abuse)."""
    rows = s.scalars(select(AuditLog).where(AuditLog.action == "card.abuse").order_by(AuditLog.id.desc())
                     .limit(min(max(limit, 1), 500)))
    return {"items": [{"time": r.time, "subject": r.target, "ip": r.ip, **(r.detail or {}),
                       "label": ABUSE_SIGNALS.get((r.detail or {}).get("signal"), "")} for r in rows]}


class BanIn(BaseModel):
    device: str = Field(min_length=1, max_length=128, pattern=r"^[^\s*]\S*$")  # "*" would mean every device
    reason: str = Field(default="", max_length=200)


@router.get("/bans")
def list_bans(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    """Devices that may not activate cards (设备黑名单)."""
    rows = s.scalars(select(DeviceBan).order_by(DeviceBan.created_at.desc()).limit(1000))
    return {"items": [{"device": b.device, "reason": b.reason, "created_by": b.created_by, "created_at": b.created_at}
                      for b in rows]}


@router.post("/bans")
def add_ban(body: BanIn, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    device = body.device.strip()
    row = s.get(DeviceBan, device)
    if row is None:
        s.add(DeviceBan(device=device, reason=body.reason, created_by=p.username))
    else:
        row.reason = body.reason or row.reason
    record(request, s, p, "card.ban", device, {"reason": body.reason})
    s.commit()
    return {"device": device}


@router.delete("/bans/{device}")
def remove_ban(device: str, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    row = s.get(DeviceBan, device)
    if row is None:
        raise HTTPException(404, "这台设备不在黑名单里")
    s.delete(row)
    record(request, s, p, "card.unban", device, {})
    s.commit()
    return {"ok": True}


class BatchIn(BaseModel):
    count: int = Field(ge=1, le=10000)
    days: float = Field(default=30, ge=0, le=36500)  # 0 = permanent
    app: str = Field(default="*", max_length=128, pattern=APP_PATTERN)
    note: str = Field(default="", max_length=255)
    prefix: str = Field(default="XS", min_length=1, max_length=8, pattern=r"^[A-Z0-9]+$")
    kind: Literal["normal", "trial", "count"] = "normal"  # 体验卡: one per device and app; 按次卡: limited by uses
    uses: int = Field(default=0, ge=0, le=100000)  # 按次卡: number of app launches
    hours: float | None = Field(default=None, gt=0, le=720)  # convenient for trials; overrides days
    max_devices: int = Field(default=1, ge=1, le=100)  # 多设备卡
    stack: bool = True  # 续期叠加: a new card starts when the device's running card ends


@router.post("/batches")
def create_batch(body: BatchIn, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    days = body.hours / 24 if body.hours else body.days
    try:
        batch, codes = cardsvc.create_batch(s, body.count, days, body.app, body.note, body.prefix, kind=body.kind,
                                            max_devices=body.max_devices, stack=body.stack, uses=body.uses)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    record(request, s, p, "card.create", batch, {"count": body.count, "days": days, "app": body.app,
                                                 "kind": body.kind, "max_devices": body.max_devices,
                                                 "stack": body.stack and body.kind == "normal",
                                                 "uses": body.uses if body.kind == "count" else 0})
    s.commit()
    return {"batch": batch, "cards": codes}


@router.get("/export")
def export_cards(request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session),
                 q: str = "", status: str = "", app: str = "", batch: str = "", kind: str = ""):
    now = time.time()
    rows = [cardsvc.to_dict(c, now) for c in s.scalars(_filtered(q, status, app, batch, kind).order_by(Card.created_at))]
    record(request, s, p, "card.export", batch or status or "all", {"count": len(rows)})
    s.commit()
    buf = io.StringIO()
    buf.write("\ufeff")  # Excel opens UTF-8 CSV correctly with a BOM
    w = csv.writer(buf)
    w.writerow(["卡密", "状态", "批次", "天数", "应用", "设备", "型号", "激活时间", "到期时间", "备注", "类型", "设备数上限",
                "已绑定设备数", "总次数", "剩余次数"])
    fmt = lambda t: time.strftime("%Y-%m-%d %H:%M", time.localtime(t)) if t else ""  # noqa: E731
    for r in rows:
        w.writerow([r["card"], r["status"], r["batch"], round(r["days"], 3) if r["days"] else "永久", r["app"], r["device"] or "",
                    r["model"] or "", fmt(r["activated_at"]),
                    "永久" if r["activated_at"] and not r["expires_at"] else fmt(r["expires_at"]), r["note"],
                    {"trial": "体验卡", "count": "按次卡"}.get(r["kind"], "正式卡"), r["max_devices"], len(r["devices"]),
                    r["uses_total"] if r["kind"] == "count" else "", r["uses_left"] if r["kind"] == "count" else ""])
    name = "cards-%s.csv" % time.strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="%s"' % name})


class CardsAction(BaseModel):
    cards: list[str] = Field(min_length=1, max_length=10000)
    action: str = Field(pattern=r"^(revoke|restore|unbind|delete)$")
    device: str | None = Field(default=None, max_length=128)  # unbind: only this device of a 多设备卡


@router.post("/actions")
def cards_action(body: CardsAction, request: Request, p: Principal = Depends(operator),
                 s: Session = Depends(db_session)):
    codes = [cardsvc.normalize(c) for c in body.cards]
    if body.action == "delete" and not p.at_least("admin"):
        raise HTTPException(403, "删除卡密需要管理员权限")
    n = 0
    for c in s.scalars(select(Card).where(Card.card.in_(codes))):
        if body.action == "revoke":
            c.revoked = True
        elif body.action == "restore":
            c.revoked = False
        elif body.action == "unbind":
            if not cardsvc.unbind(s, c, body.device):
                continue
        else:
            s.delete(c)
        n += 1
    record(request, s, p, "card." + body.action, "%d 张" % n,
           {"cards": codes[:50], **({"device": body.device} if body.device else {})})
    s.commit()
    return {"updated": n}


class ExtendIn(BaseModel):
    cards: list[str] = Field(min_length=1, max_length=10000)
    days: float = Field(gt=0, le=36500)


@router.post("/extend")
def extend_cards(body: ExtendIn, request: Request, p: Principal = Depends(operator),
                 s: Session = Depends(db_session)):
    """Unused cards get more validity; activated ones get a later expiry (from now if already expired)."""
    now = int(time.time())
    n = 0
    for c in s.scalars(select(Card).where(Card.card.in_([cardsvc.normalize(x) for x in body.cards]))):
        if not c.activated_at:
            if c.days:
                c.days += body.days
        elif c.expires_at:
            c.expires_at = max(c.expires_at, now) + int(body.days * 86400)
        n += 1
    record(request, s, p, "card.extend", "%d 张" % n, {"days": body.days})
    s.commit()
    return {"updated": n}


class OfflineIn(BaseModel):
    device: str = Field(min_length=1, max_length=128)
    days: float = Field(default=30, ge=0, le=36500)
    app: str = Field(default="*", max_length=128, pattern=APP_PATTERN)
    note: str = Field(default="", max_length=255)


@router.post("/offline")
def offline_token(body: OfflineIn, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    token, payload = cardsvc.issue_offline(s, ctx(request).key, body.device.strip(), body.days, body.app, body.note)
    record(request, s, p, "card.offline", payload["card"], {"device": body.device, "days": body.days, "app": body.app})
    s.commit()
    return {"token": token, "payload": payload}


@router.get("/public-key")
def public_key(request: Request, p: Principal = Depends(viewer)):
    return {"public_key": ctx(request).pubkey}


# ---------------------------------------------------------------- public endpoints (apps)

class ActivateIn(BaseModel):
    card: str = Field(default="", max_length=64)
    device_id: str = Field(default="", max_length=128)
    app: str = Field(default="*", max_length=128)
    model: str = Field(default="", max_length=128)


class VerifyIn(BaseModel):
    token: str = Field(default="", max_length=4096)
    device_id: str = Field(default="", max_length=128)


@public.post("/activate")
def license_activate(body: ActivateIn, request: Request, s: Session = Depends(db_session)):
    c = ctx(request)
    card, device = body.card.strip(), body.device_id.strip()
    if not card or not device:
        raise HTTPException(400, "缺少卡密或设备 ID")
    ip = client_ip(request)
    # Brute-force guard for card guessing, per client IP.
    wait = c.limiter.blocked("license|" + ip)
    if wait:
        raise HTTPException(429, "尝试次数过多，请稍后再试")
    act = cardsvc.activate_ex(s, c.key, card, device, body.app or "*", body.model)
    if act.code == "not_found":
        c.limiter.fail("license|" + ip)
    _watch(request, s, act, card, device, ip)
    if act.error:
        raise HTTPException(403, act.error)
    if act.new_device:
        record(request, s, "app:" + (body.app or "*"), "card.activate", cardsvc.normalize(card), {"device": device})
    s.commit()
    return {"token": act.token}


def _watch(request: Request, s: Session, act: cardsvc.Activation, card: str, device: str, ip: str) -> None:
    """Feed the attempt to the abuse monitor; a finding is audited and pushed to the card_abuse webhooks."""
    c = ctx(request)
    if c.abuse is None:
        return
    try:
        found = c.abuse.observe(act.code, cardsvc.normalize(card), device, ip, get_settings(s), s=s)
        for f in found:
            record(request, s, "system", "card.abuse", f.subject, f.detail)
            if c.alerts is not None:
                from_thread.run_sync(c.alerts.emit, "card_abuse", f.signal + ":" + f.subject, f.text)
        s.commit()  # also stores the observation (abuse_events) so a restart keeps the window
    except Exception:  # monitoring must never break activation
        s.rollback()
        log.exception("abuse check failed")


@public.post("/verify")
def license_verify(body: VerifyIn, request: Request, s: Session = Depends(db_session)):
    payload = licensing.verify(ctx(request).pubkey, body.token)
    if payload is None:
        return {"status": "revoked", "revoked": True}
    state = cardsvc.check_token(s, payload)
    return {"status": state, "revoked": state in ("revoked", "unknown")}


class UseIn(BaseModel):
    token: str = Field(default="", max_length=4096)
    device_id: str = Field(default="", max_length=128)


@public.post("/use")
def license_use(body: UseIn, request: Request, s: Session = Depends(db_session)):
    """Called by a packed app on every launch: deducts one use of a 按次卡 (no-op for other cards)."""
    payload = licensing.verify(ctx(request).pubkey, body.token)
    if payload is None:
        return {"status": "revoked", "revoked": True, "uses_left": 0}
    state, left = cardsvc.consume_use(s, payload)
    return {"status": state, "revoked": state in ("revoked", "unknown"), "uses_left": left}
