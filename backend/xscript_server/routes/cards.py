"""卡密 management API and the public /license/* endpoints that packaged apps call."""

from __future__ import annotations

import csv
import io
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import cards as cardsvc
from .. import licensing
from ..deps import Principal, admin, client_ip, ctx, db_session, operator, paginate, record, viewer
from ..models import Card

router = APIRouter(prefix="/api/cards", tags=["cards"])
public = APIRouter(prefix="/license", tags=["license"])

APP_PATTERN = r"^(\*|[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+)$"


def _filtered(q: str, status: str, app: str, batch: str):
    stmt = select(Card)
    if q:
        like = "%" + q.strip().upper() + "%"
        stmt = stmt.where(or_(Card.card.like(like), Card.device.like("%" + q.strip() + "%"),
                              Card.note.like("%" + q.strip() + "%")))
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
               app: str = "", batch: str = "", page: int = 1, page_size: int = 50):
    stmt = _filtered(q, status, app, batch)
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
                            func.count(Card.device))
                     .group_by(Card.batch).order_by(func.min(Card.created_at).desc()).limit(500)).all()
    return {"items": [{"batch": r[0], "app": r[1], "days": r[2], "note": r[3], "count": r[4], "created_at": r[5],
                       "bound": r[6]} for r in rows]}


class BatchIn(BaseModel):
    count: int = Field(ge=1, le=10000)
    days: float = Field(default=30, ge=0, le=36500)  # 0 = permanent
    app: str = Field(default="*", max_length=128, pattern=APP_PATTERN)
    note: str = Field(default="", max_length=255)
    prefix: str = Field(default="XS", min_length=1, max_length=8, pattern=r"^[A-Z0-9]+$")


@router.post("/batches")
def create_batch(body: BatchIn, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    batch, codes = cardsvc.create_batch(s, body.count, body.days, body.app, body.note, body.prefix)
    record(request, s, p, "card.create", batch, {"count": body.count, "days": body.days, "app": body.app})
    s.commit()
    return {"batch": batch, "cards": codes}


@router.get("/export")
def export_cards(request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session),
                 q: str = "", status: str = "", app: str = "", batch: str = ""):
    now = time.time()
    rows = [cardsvc.to_dict(c, now) for c in s.scalars(_filtered(q, status, app, batch).order_by(Card.created_at))]
    record(request, s, p, "card.export", batch or status or "all", {"count": len(rows)})
    s.commit()
    buf = io.StringIO()
    buf.write("\ufeff")  # Excel opens UTF-8 CSV correctly with a BOM
    w = csv.writer(buf)
    w.writerow(["卡密", "状态", "批次", "天数", "应用", "设备", "型号", "激活时间", "到期时间", "备注"])
    fmt = lambda t: time.strftime("%Y-%m-%d %H:%M", time.localtime(t)) if t else ""  # noqa: E731
    for r in rows:
        w.writerow([r["card"], r["status"], r["batch"], r["days"] or "永久", r["app"], r["device"] or "",
                    r["model"] or "", fmt(r["activated_at"]),
                    "永久" if r["activated_at"] and not r["expires_at"] else fmt(r["expires_at"]), r["note"]])
    name = "cards-%s.csv" % time.strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="%s"' % name})


class CardsAction(BaseModel):
    cards: list[str] = Field(min_length=1, max_length=10000)
    action: str = Field(pattern=r"^(revoke|restore|unbind|delete)$")


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
            c.device, c.model = None, None
        else:
            s.delete(c)
        n += 1
    record(request, s, p, "card." + body.action, "%d 张" % n, {"cards": codes[:50]})
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
    token, err = cardsvc.activate(s, c.key, card, device, body.app or "*", body.model)
    if err:
        if err == "卡密不存在":
            c.limiter.fail("license|" + ip)
        raise HTTPException(403, err)
    record(request, s, "app:" + (body.app or "*"), "card.activate", cardsvc.normalize(card), {"device": device})
    s.commit()
    return {"token": token}


@public.post("/verify")
def license_verify(body: VerifyIn, request: Request, s: Session = Depends(db_session)):
    payload = licensing.verify(ctx(request).pubkey, body.token)
    if payload is None:
        return {"status": "revoked", "revoked": True}
    state = cardsvc.check_token(s, payload)
    return {"status": state, "revoked": state in ("revoked", "unknown")}
