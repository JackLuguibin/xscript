"""代理批发价与结算: price lookup, ledger rows and balances. Money is integer 分 throughout."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import ResellerLedger, ResellerPrice

LEDGER_KINDS = ("charge", "payment", "adjust")


def same_days(a: float | None, b: float) -> bool:
    return a is not None and round(float(a), 3) == round(float(b), 3)


def price_for(s: Session, reseller_id: int, app: str, kind: str, days: float) -> int | None:
    """Unit price in 分 for one card, or None when no row matches. The most specific row wins: an exact app
    beats "*", then exact days beat "any validity"."""
    best: tuple[int, int] | None = None
    for row in s.scalars(select(ResellerPrice).where(ResellerPrice.reseller_id == reseller_id, ResellerPrice.kind == kind,
                                                     ResellerPrice.app.in_((app, "*")))):
        if row.days is not None and not same_days(row.days, days):
            continue
        rank = (2 if row.app == app and app != "*" else 0) + (1 if row.days is not None else 0)
        if best is None or rank > best[0]:
            best = (rank, int(row.price_cents))
    return best[1] if best else None


def charge(s: Session, reseller_id: int, batch: str, count: int, unit_cents: int, app: str, kind: str, days: float,
           actor: str) -> ResellerLedger:
    row = ResellerLedger(reseller_id=reseller_id, kind="charge", amount_cents=unit_cents * count, batch=batch, count=count,
                         unit_cents=unit_cents, app=app, card_kind=kind, days=float(days), actor=actor)
    s.add(row)
    return row


def balance(s: Session, reseller_id: int) -> dict:
    """{charged, paid, adjusted, balance} in 分; balance > 0 means the reseller owes that much."""
    rows = dict(s.execute(select(ResellerLedger.kind, func.coalesce(func.sum(ResellerLedger.amount_cents), 0))
                          .where(ResellerLedger.reseller_id == reseller_id).group_by(ResellerLedger.kind)).all())
    charged, paid, adjusted = int(rows.get("charge", 0)), int(rows.get("payment", 0)), int(rows.get("adjust", 0))
    return {"charged": charged, "paid": paid, "adjusted": adjusted, "balance": charged + adjusted - paid}


def ledger_stmt(reseller_id: int, since: int = 0, until: int = 0, kind: str = ""):
    stmt = select(ResellerLedger).where(ResellerLedger.reseller_id == reseller_id)
    if since:
        stmt = stmt.where(ResellerLedger.time >= since)
    if until:
        stmt = stmt.where(ResellerLedger.time <= until)
    if kind:
        stmt = stmt.where(ResellerLedger.kind == kind)
    return stmt


def row_dict(r: ResellerLedger) -> dict:
    return {"id": r.id, "time": r.time, "kind": r.kind, "amount_cents": r.amount_cents, "batch": r.batch,
            "count": r.count, "unit_cents": r.unit_cents, "app": r.app, "card_kind": r.card_kind, "days": r.days,
            "note": r.note, "actor": r.actor}


def price_dict(r: ResellerPrice) -> dict:
    return {"id": r.id, "app": r.app, "kind": r.kind, "days": r.days, "price_cents": r.price_cents,
            "updated_at": r.updated_at}


def _signed(kind: str, amount: int) -> int:
    return -amount if kind == "payment" else amount


def yuan(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return "%s%d.%02d" % (sign, abs(cents) // 100, abs(cents) % 100)


def statement_csv(s: Session, reseller_id: int, username: str, since: int = 0, until: int = 0) -> str:
    """UTF-8 (BOM) CSV for Excel: opening balance, every row in [since, until], closing balance."""
    import csv
    import io
    import time as _t

    opening = 0
    if since:
        opening = sum(_signed(k, int(a)) for k, a in s.execute(
            select(ResellerLedger.kind, func.coalesce(func.sum(ResellerLedger.amount_cents), 0))
            .where(ResellerLedger.reseller_id == reseller_id, ResellerLedger.time < since)
            .group_by(ResellerLedger.kind)).all())
    fmt = lambda t: _t.strftime("%Y-%m-%d %H:%M", _t.localtime(t)) if t else ""  # noqa: E731
    names = {"charge": "生成卡密", "payment": "收款", "adjust": "调整"}
    kinds = {"normal": "正式卡", "trial": "体验卡", "count": "按次卡"}
    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    w.writerow(["代理", username, "时间段", fmt(since) or "开始", fmt(until) or "现在"])
    w.writerow(["期初应付(元)", yuan(opening)])
    w.writerow(["时间", "类型", "金额(元)", "批次", "数量", "单价(元)", "应用", "卡类型", "天数", "备注", "操作人", "应付余额(元)"])
    bal = opening
    for r in s.scalars(ledger_stmt(reseller_id, since, until).order_by(ResellerLedger.time, ResellerLedger.id)):
        bal += _signed(r.kind, r.amount_cents)
        w.writerow([fmt(r.time), names.get(r.kind, r.kind), yuan(_signed(r.kind, r.amount_cents)), r.batch, r.count or "",
                    yuan(r.unit_cents) if r.kind == "charge" else "", r.app, kinds.get(r.card_kind, r.card_kind),
                    (round(r.days, 3) if r.days else "永久") if r.kind == "charge" else "", r.note, r.actor, yuan(bal)])
    w.writerow(["期末应付(元)", yuan(bal)])
    return buf.getvalue()
