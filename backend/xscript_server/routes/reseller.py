"""代理 (reseller) accounts.

Admins manage limits and quota under /api/resellers. A reseller (role=reseller) signs in to the same
console and only reaches /api/reseller/*: their own cards, their quota, their sales trend and the audit
rows about them. Every query here is filtered by owner_id = the signed-in account; the staff card
endpoints keep refusing the role because it has no rank.
"""

from __future__ import annotations

import csv
import io
import re
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from .. import cards as cardsvc
from .. import settlement, stats
from ..deps import Principal, admin, db_session, like_contains, like_escape, paginate, record, reseller_only
from ..models import AuditLog, Card, Reseller, ResellerLedger, ResellerPrice, User
from .cards import APP_PATTERN, _filtered

router = APIRouter(prefix="/api/resellers", tags=["resellers"])
me = APIRouter(prefix="/api/reseller", tags=["reseller"])

KINDS = ("normal", "trial", "count")
MAX_QUOTA = 10_000_000


def _limits(r: Reseller) -> dict:
    return {"quota": r.quota, "used": r.used, "left": max(0, r.quota - r.used), "apps": list(r.apps or []),
            "kinds": list(r.kinds or []), "max_days": r.max_days, "max_devices": r.max_devices,
            "max_uses": r.max_uses, "note": r.note}


def _row(s: Session, user_id: int) -> Reseller:
    r = s.get(Reseller, user_id)
    if r is None:
        raise HTTPException(404, "代理不存在")
    return r


# ---------------------------------------------------------------- admin: 代理管理

@router.get("")
def list_resellers(p: Principal = Depends(admin), s: Session = Depends(db_session)):
    """Every reseller with limits, card counts by status and activations in the last 30 days."""
    since = int(time.time()) - 30 * 86400
    acts = dict(s.execute(select(Card.owner_id, func.count()).where(Card.owner_id.is_not(None),
                                                                     Card.activated_at >= since)
                          .group_by(Card.owner_id)).all())
    out = []
    for u, r in s.execute(select(User, Reseller).join(Reseller, Reseller.user_id == User.id)
                          .where(User.role == "reseller").order_by(User.id)).all():
        out.append({"id": u.id, "username": u.username, "disabled": u.disabled, "last_login_at": u.last_login_at,
                    **_limits(r), "cards": cardsvc.stats(s, u.id), "activations_30d": int(acts.get(u.id, 0))})
    return {"items": out}


class LimitsIn(BaseModel):
    apps: list[str] = Field(min_length=1, max_length=50)
    kinds: list[Literal["normal", "trial", "count"]] = Field(min_length=1, max_length=3)
    max_days: float = Field(ge=0, le=36500)  # 0 = permanent cards allowed
    max_devices: int = Field(ge=1, le=100)
    max_uses: int = Field(ge=1, le=100000)
    note: str = Field(default="", max_length=255)

    @field_validator("apps")
    @classmethod
    def _apps(cls, v: list[str]) -> list[str]:
        import re
        out = []
        for a in v:
            a = a.strip()
            if not re.match(APP_PATTERN, a):
                raise ValueError("应用包名格式不正确: %s" % a[:64])
            out.append(a)
        return list(dict.fromkeys(out))


@router.put("/{user_id}")
def set_limits(user_id: int, body: LimitsIn, request: Request, p: Principal = Depends(admin),
               s: Session = Depends(db_session)):
    r = _row(s, user_id)
    r.apps, r.kinds = body.apps, list(dict.fromkeys(body.kinds))
    r.max_days, r.max_devices, r.max_uses, r.note = body.max_days, body.max_devices, body.max_uses, body.note
    u = s.get(User, user_id)
    record(request, s, p, "reseller.limits", u.username if u else str(user_id),
           {"apps": r.apps, "kinds": r.kinds, "max_days": r.max_days, "max_devices": r.max_devices,
            "max_uses": r.max_uses})
    s.commit()
    return _limits(r)


class QuotaIn(BaseModel):
    delta: int = Field(ge=-MAX_QUOTA, le=MAX_QUOTA)  # + 充值 / - 扣回
    note: str = Field(default="", max_length=200)


@router.post("/{user_id}/quota")
def adjust_quota(user_id: int, body: QuotaIn, request: Request, p: Principal = Depends(admin),
                 s: Session = Depends(db_session)):
    if body.delta == 0:
        raise HTTPException(400, "调整数量不能为 0")
    r = _row(s, user_id)
    new = r.quota + body.delta
    if new < r.used:
        raise HTTPException(400, "额度不能低于已生成的 %d 张" % r.used)
    if new > MAX_QUOTA:
        raise HTTPException(400, "额度过大")
    before, r.quota = r.quota, new
    u = s.get(User, user_id)
    record(request, s, p, "reseller.quota", u.username if u else str(user_id),
           {"delta": body.delta, "before": before, "after": new, "note": body.note})
    s.commit()
    return _limits(r)


@router.get("/{user_id}/stats/daily")
def reseller_daily(user_id: int, days: int = Query(30, ge=7, le=365), p: Principal = Depends(admin),
                   s: Session = Depends(db_session)):
    _row(s, user_id)
    return stats.daily(s, days, owner_id=user_id, cards_only=True)


# ---------------------------------------------------------------- admin: 批发价与结算

MAX_CENTS = 10**12  # 一百亿元: far above any real amount, keeps sums inside BIGINT


class PriceIn(BaseModel):
    app: str = Field(default="*", max_length=128)
    kind: Literal["normal", "trial", "count"] = "normal"
    days: float | None = Field(default=None, gt=0, le=36500)
    price_cents: int = Field(ge=0, le=MAX_CENTS)

    @field_validator("app")
    @classmethod
    def _app(cls, v: str) -> str:
        v = v.strip() or "*"
        if v != "*" and not re.match(APP_PATTERN, v):
            raise ValueError("应用包名格式不正确")
        return v


class PricesIn(BaseModel):
    unpriced: Literal["free", "deny"] = "free"
    items: list[PriceIn] = Field(default_factory=list, max_length=500)


def _prices(s: Session, r: Reseller) -> dict:
    rows = s.scalars(select(ResellerPrice).where(ResellerPrice.reseller_id == r.user_id)
                     .order_by(ResellerPrice.app, ResellerPrice.kind, ResellerPrice.days))
    return {"unpriced": r.unpriced or "free", "items": [settlement.price_dict(x) for x in rows]}


def _name(s: Session, user_id: int) -> str:
    u = s.get(User, user_id)
    return u.username if u else str(user_id)


@router.get("/balances")
def balances(p: Principal = Depends(admin), s: Session = Depends(db_session)):
    """应付 / 已付 / 余额 for every reseller (balance > 0: the reseller owes that much)."""
    out = []
    for r, u in s.execute(select(Reseller, User).join(User, User.id == Reseller.user_id).order_by(User.username)):
        out.append({"id": r.user_id, "username": u.username, **settlement.balance(s, r.user_id)})
    return {"items": out}


@router.get("/{user_id}/prices")
def get_prices(user_id: int, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    return _prices(s, _row(s, user_id))


@router.put("/{user_id}/prices")
def put_prices(user_id: int, body: PricesIn, request: Request, p: Principal = Depends(admin),
               s: Session = Depends(db_session)):
    """Replaces the whole price table (the console edits it as one list). Past charges are not repriced."""
    r = _row(s, user_id)
    seen = set()
    for it in body.items:
        key = (it.app, it.kind, None if it.days is None else round(it.days, 3))
        if key in seen:
            raise HTTPException(400, "价格重复：%s / %s / %s" % (it.app, it.kind, "任意天数" if it.days is None else it.days))
        seen.add(key)
    before = _prices(s, r)
    s.query(ResellerPrice).filter(ResellerPrice.reseller_id == user_id).delete()
    for it in body.items:
        s.add(ResellerPrice(reseller_id=user_id, app=it.app, kind=it.kind, days=it.days, price_cents=it.price_cents))
    r.unpriced = body.unpriced
    record(request, s, p, "reseller.prices", _name(s, user_id),
           {"unpriced": body.unpriced, "count": len(body.items), "before": len(before["items"])})
    s.commit()
    return _prices(s, r)


class LedgerIn(BaseModel):
    kind: Literal["payment", "adjust"]
    amount_cents: int = Field(ge=-MAX_CENTS, le=MAX_CENTS)  # payment > 0; adjust signed (+ 加应付 / - 减应付)
    note: str = Field(default="", max_length=200)


@router.post("/{user_id}/ledger")
def add_ledger(user_id: int, body: LedgerIn, request: Request, p: Principal = Depends(admin),
               s: Session = Depends(db_session)):
    _row(s, user_id)
    if body.kind == "payment" and body.amount_cents <= 0:
        raise HTTPException(400, "收款金额必须大于 0")
    if body.amount_cents == 0:
        raise HTTPException(400, "调整金额不能为 0")
    row = ResellerLedger(reseller_id=user_id, kind=body.kind, amount_cents=body.amount_cents, note=body.note,
                         actor=p.username)
    s.add(row)
    record(request, s, p, "reseller." + body.kind, _name(s, user_id),
           {"amount_cents": body.amount_cents, "note": body.note})
    s.commit()
    return {"row": settlement.row_dict(row), **settlement.balance(s, user_id)}


def _ledger_page(s: Session, user_id: int, since: int, until: int, kind: str, page: int, page_size: int) -> dict:
    stmt = settlement.ledger_stmt(user_id, since, until, kind)
    total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    off, size = paginate(page, page_size)
    rows = s.scalars(stmt.order_by(ResellerLedger.time.desc(), ResellerLedger.id.desc()).offset(off).limit(size))
    return {"items": [settlement.row_dict(r) for r in rows], "total": total, **settlement.balance(s, user_id)}


def _statement(s: Session, user_id: int, username: str, since: int, until: int) -> StreamingResponse:
    body = settlement.statement_csv(s, user_id, username, since, until)
    name = "statement-%s-%s.csv" % (re.sub(r"[^A-Za-z0-9_.-]", "_", username), time.strftime("%Y%m%d-%H%M%S"))
    return StreamingResponse(iter([body]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="%s"' % name})


@router.get("/{user_id}/ledger")
def get_ledger(user_id: int, p: Principal = Depends(admin), s: Session = Depends(db_session),
               since: int = 0, until: int = 0, kind: Literal["", "charge", "payment", "adjust"] = "",
               page: int = 1, page_size: int = 50):
    _row(s, user_id)
    return _ledger_page(s, user_id, since, until, kind, page, page_size)


@router.get("/{user_id}/statement")
def get_statement(user_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session),
                  since: int = 0, until: int = 0):
    _row(s, user_id)
    name = _name(s, user_id)
    record(request, s, p, "reseller.statement", name, {"since": since, "until": until})
    s.commit()
    return _statement(s, user_id, name, since, until)


# ---------------------------------------------------------------- 代理 console (own data only)

def _mine(p: Principal, s: Session) -> Reseller:
    r = s.get(Reseller, p.id)
    if r is None:  # role set without limits (e.g. by an older release): nothing is allowed
        raise HTTPException(403, "代理账号尚未开通额度，请联系管理员")
    return r


@me.get("/me")
def my_limits(p: Principal = Depends(reseller_only), s: Session = Depends(db_session)):
    limits = _limits(_mine(p, s))
    limits.pop("note")  # the admin's note about this reseller stays internal
    return {"username": p.username, **limits, "cards": cardsvc.stats(s, p.id)}


@me.get("/cards")
def my_cards(p: Principal = Depends(reseller_only), s: Session = Depends(db_session), q: str = "", status: str = "",
             app: str = "", batch: str = "", kind: str = "", page: int = 1, page_size: int = 50):
    stmt = _filtered(q, status, app, batch, kind).where(Card.owner_id == p.id)
    total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    off, size = paginate(page, page_size)
    now = time.time()
    rows = s.scalars(stmt.order_by(Card.created_at.desc(), Card.card).offset(off).limit(size))
    return {"items": [cardsvc.to_dict(c, now) for c in rows], "total": total}


@me.get("/cards/stats")
def my_card_stats(p: Principal = Depends(reseller_only), s: Session = Depends(db_session)):
    return cardsvc.stats(s, p.id)


@me.get("/cards/batches")
def my_batches(p: Principal = Depends(reseller_only), s: Session = Depends(db_session)):
    return {"items": cardsvc.batches(s, owner_id=p.id)}


class MyBatchIn(BaseModel):
    count: int = Field(ge=1, le=10000)
    days: float = Field(default=30, ge=0, le=36500)
    hours: float | None = Field(default=None, gt=0, le=720)
    app: str = Field(default="*", max_length=128, pattern=APP_PATTERN)
    note: str = Field(default="", max_length=255)
    prefix: str = Field(default="XS", min_length=1, max_length=8, pattern=r"^[A-Z0-9]+$")
    kind: Literal["normal", "trial", "count"] = "normal"
    uses: int = Field(default=0, ge=0, le=100000)
    max_devices: int = Field(default=1, ge=1, le=100)
    stack: bool = True


def _check(r: Reseller, body: MyBatchIn, days: float) -> None:
    apps = r.apps or []
    if "*" not in apps and body.app not in apps:
        raise HTTPException(403, "不能为这个应用生成卡密（允许：%s）" % "、".join(apps or ["无"]))
    if body.kind not in (r.kinds or []):
        raise HTTPException(403, "不能生成这种类型的卡密")
    if r.max_days:
        if days == 0 and body.kind != "count":
            raise HTTPException(403, "不能生成永久卡")
        if days > r.max_days:
            raise HTTPException(403, "有效期不能超过 %g 天" % r.max_days)
    if body.max_devices > r.max_devices:
        raise HTTPException(403, "每张卡最多 %d 台设备" % r.max_devices)
    if body.kind == "count" and body.uses > r.max_uses:
        raise HTTPException(403, "按次卡最多 %d 次" % r.max_uses)


@me.post("/cards/batches")
def my_create_batch(body: MyBatchIn, request: Request, p: Principal = Depends(reseller_only),
                    s: Session = Depends(db_session)):
    r = _mine(p, s)
    days = body.hours / 24 if body.hours else body.days
    _check(r, body, days)
    unit = settlement.price_for(s, p.id, body.app, body.kind, days)
    if unit is None:
        if (r.unpriced or "free") == "deny":
            raise HTTPException(403, "这种卡密还没有设置批发价，请联系管理员")
        unit = 0
    # Atomic: two concurrent requests cannot both spend the last of the quota.
    took = s.execute(update(Reseller).where(Reseller.user_id == p.id, Reseller.used + body.count <= Reseller.quota)
                     .values(used=Reseller.used + body.count)).rowcount
    if not took:
        s.rollback()
        left = max(0, r.quota - r.used)
        raise HTTPException(403, "额度不足：剩余 %d 张，本次需要 %d 张" % (left, body.count))
    try:
        batch, codes = cardsvc.create_batch(s, body.count, days, body.app, body.note, body.prefix, kind=body.kind,
                                            max_devices=body.max_devices, stack=body.stack, uses=body.uses,
                                            owner_id=p.id)
    except ValueError as e:
        s.rollback()
        raise HTTPException(400, str(e)) from None
    # The charge is written in the same transaction as the cards: both land or neither does.
    settlement.charge(s, p.id, batch, body.count, unit, body.app, body.kind, days, p.username)
    record(request, s, p, "card.create", batch, {"count": body.count, "days": days, "app": body.app,
                                                 "kind": body.kind, "max_devices": body.max_devices,
                                                 "uses": body.uses if body.kind == "count" else 0,
                                                 "reseller": True, "unit_cents": unit,
                                                 "charge_cents": unit * body.count})
    s.commit()
    s.refresh(r)
    return {"batch": batch, "cards": codes, "left": max(0, r.quota - r.used), "unit_cents": unit,
            "charge_cents": unit * body.count}


class MyAction(BaseModel):
    cards: list[str] = Field(min_length=1, max_length=10000)
    action: Literal["revoke", "restore", "unbind"]
    device: str | None = Field(default=None, max_length=128)


@me.post("/cards/actions")
def my_cards_action(body: MyAction, request: Request, p: Principal = Depends(reseller_only),
                    s: Session = Depends(db_session)):
    """Revoke, restore or unbind the reseller's own cards; codes owned by others are silently skipped."""
    _mine(p, s)
    codes = [cardsvc.normalize(c) for c in body.cards]
    n = 0
    for c in s.scalars(select(Card).where(Card.card.in_(codes), Card.owner_id == p.id)):
        if body.action == "revoke":
            c.revoked = True
        elif body.action == "restore":
            c.revoked = False
        elif not cardsvc.unbind(s, c, body.device):
            continue
        n += 1
    record(request, s, p, "card." + body.action, "%d 张" % n,
           {"cards": codes[:50], "reseller": True, **({"device": body.device} if body.device else {})})
    s.commit()
    return {"updated": n}


@me.get("/cards/export")
def my_export(request: Request, p: Principal = Depends(reseller_only), s: Session = Depends(db_session),
              q: str = "", status: str = "", app: str = "", batch: str = "", kind: str = ""):
    _mine(p, s)
    now = time.time()
    rows = [cardsvc.to_dict(c, now) for c in s.scalars(_filtered(q, status, app, batch, kind)
                                                        .where(Card.owner_id == p.id).order_by(Card.created_at))]
    record(request, s, p, "card.export", batch or status or "all", {"count": len(rows), "reseller": True})
    s.commit()
    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    w.writerow(["卡密", "状态", "批次", "天数", "应用", "设备", "激活时间", "到期时间", "备注", "类型", "剩余次数"])
    fmt = lambda t: time.strftime("%Y-%m-%d %H:%M", time.localtime(t)) if t else ""  # noqa: E731
    for r in rows:
        w.writerow([r["card"], r["status"], r["batch"], round(r["days"], 3) if r["days"] else "永久", r["app"],
                    r["device"] or "", fmt(r["activated_at"]),
                    "永久" if r["activated_at"] and not r["expires_at"] else fmt(r["expires_at"]), r["note"],
                    {"trial": "体验卡", "count": "按次卡"}.get(r["kind"], "正式卡"),
                    r["uses_left"] if r["kind"] == "count" else ""])
    name = "cards-%s.csv" % time.strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="%s"' % name})


@me.get("/balance")
def my_balance(p: Principal = Depends(reseller_only), s: Session = Depends(db_session)):
    """Own 应付 / 已付 / 余额 and the price list that applies to this account."""
    r = _mine(p, s)
    return {**settlement.balance(s, p.id), "prices": _prices(s, r)}


@me.get("/ledger")
def my_ledger(p: Principal = Depends(reseller_only), s: Session = Depends(db_session), since: int = 0,
              until: int = 0, kind: Literal["", "charge", "payment", "adjust"] = "", page: int = 1,
              page_size: int = 50):
    _mine(p, s)
    return _ledger_page(s, p.id, since, until, kind, page, page_size)


@me.get("/statement")
def my_statement(request: Request, p: Principal = Depends(reseller_only), s: Session = Depends(db_session),
                 since: int = 0, until: int = 0):
    _mine(p, s)
    record(request, s, p, "reseller.statement", p.username, {"since": since, "until": until, "reseller": True})
    s.commit()
    return _statement(s, p.id, p.username, since, until)


@me.get("/stats/daily")
def my_daily(days: int = Query(30, ge=7, le=365), app: str = Query("", max_length=128),
             p: Principal = Depends(reseller_only), s: Session = Depends(db_session)):
    _mine(p, s)
    return stats.daily(s, days, app, owner_id=p.id, cards_only=True)


@me.get("/audit")
def my_audit(p: Principal = Depends(reseller_only), s: Session = Depends(db_session), action: str = "",
             q: str = "", since: int = 0, until: int = 0, page: int = 1, page_size: int = 50):
    """The reseller's own actions, plus admin quota / limit changes made to this account."""
    stmt = select(AuditLog).where(or_(AuditLog.actor == p.username,
                                      (AuditLog.action.in_(("reseller.quota", "reseller.limits", "reseller.prices",
                                                             "reseller.payment", "reseller.adjust")))
                                      & (AuditLog.target == p.username)))
    if action:  # same filters as the staff log: "card." is a category prefix
        stmt = stmt.where(AuditLog.action.like(like_escape(action.rstrip("*")) + "%", escape="\\"))
    if q:
        stmt = stmt.where(AuditLog.target.ilike(like_contains(q), escape="\\"))
    if since:
        stmt = stmt.where(AuditLog.time >= since)
    if until:
        stmt = stmt.where(AuditLog.time <= until)
    total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    off, size = paginate(page, page_size)
    rows = s.scalars(stmt.order_by(AuditLog.id.desc()).offset(off).limit(size))
    return {"items": [{"id": r.id, "time": r.time, "actor": r.actor, "action": r.action, "target": r.target,
                       "detail": r.detail, "ip": r.ip} for r in rows], "total": total}
