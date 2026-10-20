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
