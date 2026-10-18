"""Overview dashboard, audit log and system settings."""

from __future__ import annotations

import time
from typing import Any

from typing import Literal

from anyio import from_thread
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .. import __version__, maintenance, netcheck
from .. import cards as cardsvc
from ..audit import ALERT_EVENTS, get_settings, set_setting
from ..deps import Principal, admin, client_ip, ctx, db_session, like_contains, like_escape, paginate, record, viewer
from ..models import AuditLog, Device, PackJob, Script, Task, User

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/overview")
def overview(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    c = ctx(request)
    conns = list(c.hub.conns.values())
    day_ago = int(time.time()) - 86400
    return {
        "devices": {
            "online": len(conns),
            "running": sum(1 for x in conns if x.status.get("running")),
            "total": s.scalar(select(func.count()).select_from(Device)) or 0,
            "active_24h": s.scalar(select(func.count()).select_from(Device).where(Device.last_seen >= day_ago)) or 0,
        },
        "cards": cardsvc.stats(s),
        "tasks": {
            "total": s.scalar(select(func.count()).select_from(Task)) or 0,
            "enabled": s.scalar(select(func.count()).select_from(Task).where(Task.enabled.is_(True))) or 0,
        },
        "pack": {
            "queued": s.scalar(select(func.count()).select_from(PackJob).where(PackJob.status == "queued")) or 0,
            "running": s.scalar(select(func.count()).select_from(PackJob).where(PackJob.status == "running")) or 0,
        },
        "events": list(c.hub.events)[-30:][::-1],
        "crashes": _recent_crashes(s, day_ago),
        "scripts": {
            "total": s.scalar(select(func.count()).select_from(Script)) or 0,
            "published": s.scalar(select(func.count()).select_from(Script)
                                  .where(Script.current_version_id.is_not(None))) or 0,
        },
        "alerts_24h": sum(1 for a in c.alerts.recent if a["time"] >= day_ago) if c.alerts else 0,
        "last_backup": c.maint.last_backup if c.maint else None,
    }


def _recent_crashes(s: Session, since: int) -> list[dict[str, Any]]:
    """Devices whose last run crashed within the window, newest first."""
    out = []
    for d in s.scalars(select(Device).where(Device.last_run.is_not(None))):
        r = d.last_run or {}
        if r.get("crashed") and int(r.get("time") or 0) >= since:
            last = next((t["line"] for t in reversed(r.get("tail") or []) if t.get("stream") == "stderr"), "")
            out.append({"device": d.id, "model": " ".join(x for x in (d.brand, d.model) if x), "project": r.get("project"),
                        "exit": r.get("exit"), "time": r.get("time"), "error": last[:200]})
    return sorted(out, key=lambda x: -int(x["time"] or 0))[:8]


@router.get("/audit")
def audit_log(p: Principal = Depends(admin), s: Session = Depends(db_session), actor: str = "", action: str = "",
              q: str = "", since: int = 0, until: int = 0, page: int = 1, page_size: int = 50):
    stmt = select(AuditLog)
    if actor:
        stmt = stmt.where(AuditLog.actor == actor)
    if action:
        stmt = stmt.where(AuditLog.action.like(like_escape(action.rstrip("*")) + "%", escape="\\"))
    if q:
        stmt = stmt.where(AuditLog.target.like(like_contains(q), escape="\\"))
    if since:
        stmt = stmt.where(AuditLog.time >= since)
    if until:
        stmt = stmt.where(AuditLog.time <= until)
    total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    off, size = paginate(page, page_size)
    rows = s.scalars(stmt.order_by(AuditLog.id.desc()).offset(off).limit(size))
    return {"items": [{"id": r.id, "time": r.time, "actor": r.actor, "action": r.action, "target": r.target,
                       "detail": r.detail, "ip": r.ip} for r in rows], "total": total}


@router.get("/settings")
def read_settings(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    c = ctx(request)
    out: dict[str, Any] = get_settings(s)
    # Webhook URLs embed access tokens: admins see them, signing secrets are never returned.
    hooks = out.get("alert_webhooks") or []
    out["alert_webhooks"] = [{**{k: v for k, v in w.items() if k != "secret"}, "has_secret": bool(w.get("secret")),
                              **({} if p.at_least("admin") else {"url": ""})} for w in hooks]
    out["login_ip_allowlist_on"] = bool(out.get("login_ip_allowlist"))
    if not p.at_least("admin"):
        out["login_ip_allowlist"] = []  # network layout is for admins
    out.update(version=__version__, license_public_key=c.pubkey, release_signing=c.config.release_signing,
               alert_events=ALERT_EVENTS, your_ip=client_ip(request))
    return out


class WebhookIn(BaseModel):
    name: str = Field(default="", max_length=64)
    kind: Literal["wecom", "dingtalk", "feishu", "generic"] = "generic"
    url: str = Field(max_length=1024, pattern=r"^https?://\S+$")
    events: list[str] = Field(default_factory=list, max_length=20)
    secret: str = Field(default="", max_length=256)  # 钉钉 / 飞书 signing secret

    @field_validator("events")
    @classmethod
    def _events(cls, v: list[str]) -> list[str]:
        bad = [e for e in v if e not in ALERT_EVENTS]
        if bad:
            raise ValueError("未知事件 %s" % ",".join(bad))
        return v


class SettingsIn(BaseModel):
    site_name: str | None = Field(default=None, max_length=64)
    public_url: str | None = Field(default=None, max_length=255, pattern=r"^(|https?://[^\s/?#]+(:\d+)?(/[^\s?#]*)?)$")
    keep_pack_jobs: int | None = Field(default=None, ge=0, le=10000)
    audit_days: int | None = Field(default=None, ge=0, le=36500)
    backup_daily: bool | None = None
    backup_hour: int | None = Field(default=None, ge=0, le=23)
    keep_backups: int | None = Field(default=None, ge=0, le=365)
    alert_webhooks: list[WebhookIn] | None = Field(default=None, max_length=20)
    alert_offline_minutes: int | None = Field(default=None, ge=0, le=1440)
    require_totp_admin: bool | None = None
    device_log_days: int | None = Field(default=None, ge=0, le=365)
    abuse_card_devices: int | None = Field(default=None, ge=0, le=1000)
    abuse_device_cards: int | None = Field(default=None, ge=0, le=1000)
    abuse_ip_devices: int | None = Field(default=None, ge=0, le=10000)
    abuse_ip_failures: int | None = Field(default=None, ge=0, le=10000)
    login_ip_allowlist: list[str] | None = Field(default=None, max_length=100)


@router.put("/settings")
def write_settings(body: SettingsIn, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    changes = body.model_dump(exclude_none=True)
    if "public_url" in changes:
        changes["public_url"] = changes["public_url"].rstrip("/")
    if "alert_webhooks" in changes:
        # A secret left empty in the form keeps the stored one (secrets are never sent back).
        old = {w.get("url"): w for w in get_settings(s).get("alert_webhooks") or []}
        for w in changes["alert_webhooks"]:
            if not w.get("secret") and old.get(w["url"], {}).get("secret"):
                w["secret"] = old[w["url"]]["secret"]
    if "login_ip_allowlist" in changes:
        try:
            entries = netcheck.normalize(changes["login_ip_allowlist"])
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        # Refuse a list that shuts the saving admin out; the CLI `reset-allowlist` is the way back in.
        if entries and not netcheck.allowed(client_ip(request), entries):
            raise HTTPException(400, "你当前的 IP（%s）不在名单里，保存后会把你自己锁在外面" % client_ip(request))
        changes["login_ip_allowlist"] = entries
    if changes.get("require_totp_admin"):
        me = s.get(User, p.id)
        if not me.totp_enabled:
            # Otherwise the admin locks themself out of the console on the next request.
            raise HTTPException(400, "先为自己开启两步验证，再要求所有管理员开启")
    for k, v in changes.items():
        try:
            set_setting(s, k, v)
        except KeyError:
            raise HTTPException(400, "未知设置 " + k) from None
    if "alert_offline_minutes" in changes:
        ctx(request).hub.offline_minutes = float(changes["alert_offline_minutes"])
    if "device_log_days" in changes:
        # This endpoint runs in a worker thread; hub sockets live on the event loop.
        from_thread.run(ctx(request).hub.set_log_days, float(changes["device_log_days"]))
    logged = dict(changes)
    if "alert_webhooks" in logged:
        logged["alert_webhooks"] = [{"name": w["name"], "kind": w["kind"], "events": w["events"]}
                                    for w in logged["alert_webhooks"]]  # URLs carry tokens
    record(request, s, p, "settings.update", ",".join(changes), logged)
    s.commit()
    return read_settings(request, p, s)


# ---------------------------------------------------------------- 告警 / 备份 / 存储

@router.post("/alerts/test")
async def test_alert(body: WebhookIn, request: Request, p: Principal = Depends(admin)):
    """Send a test message to one webhook (unsaved form values)."""
    hook = body.model_dump()
    if not hook["secret"]:
        with ctx(request).db.session() as s:
            old = {w.get("url"): w for w in get_settings(s).get("alert_webhooks") or []}
        hook["secret"] = old.get(hook["url"], {}).get("secret", "")
    ok, msg = await ctx(request).alerts.send_one(hook, "测试通知", "这是一条来自 XScript 管理后台的测试消息。")
    if not ok:
        raise HTTPException(502, "发送失败: %s" % msg)
    return {"ok": True}


@router.get("/alerts/recent")
def recent_alerts(request: Request, p: Principal = Depends(viewer)):
    return {"items": list(ctx(request).alerts.recent)[::-1]}


@router.get("/maintenance")
def maintenance_info(request: Request, p: Principal = Depends(admin)):
    c = ctx(request)
    return {"usage": maintenance.disk_usage(c.config), "backups": maintenance.list_backups(c.config),
            "last_backup": c.maint.last_backup, "last_retention": c.maint.last_retention}


@router.post("/maintenance/backup")
async def backup_now(request: Request, p: Principal = Depends(admin)):
    c = ctx(request)
    path = await run_in_threadpool(maintenance.create_backup, c.config)

    def _audit():
        with c.db.session() as s:
            record(request, s, p, "system.backup", path.name, {"size": path.stat().st_size})
            s.commit()

    await run_in_threadpool(_audit)
    c.maint.last_backup = {"time": int(time.time()), "name": path.name, "ok": True}
    return {"name": path.name, "size": path.stat().st_size}


@router.get("/maintenance/backups/{name}")
def download_backup(name: str, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    c = ctx(request)
    path = (c.config.backup_dir / name).resolve()
    if path.parent != c.config.backup_dir.resolve() or not path.is_file() or not name.endswith(".tar.gz"):
        raise HTTPException(404, "备份不存在")
    record(request, s, p, "system.backup_download", name)  # contains the signing key
    s.commit()
    return FileResponse(path, media_type="application/gzip", filename=name)


@router.post("/maintenance/cleanup")
async def cleanup_now(request: Request, p: Principal = Depends(admin)):
    c = ctx(request)
    with c.db.session() as s:
        policy = get_settings(s)
    res = await run_in_threadpool(maintenance.run_retention, c.config, c.db, policy)
    c.maint.last_retention = {"time": int(time.time()), **res}

    def _audit():
        with c.db.session() as s:
            record(request, s, p, "system.cleanup", "", res)
            s.commit()

    await run_in_threadpool(_audit)
    return res
