"""应用运营: 公告 (announcements shown at app start-up) and APK 更新策略 (含强制更新).

Roles: viewers read; operators manage announcements (plain text, no code); the update policy
points every installed app at an APK download, so it needs an admin.
Public side: /pub/app-notices and /pub/app-update, called by packed apps.
"""

from __future__ import annotations

import hashlib
import re
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..audit import get_settings
from ..deps import Principal, admin, apk_limit, ctx, db_session, operator, pub_limit, record, viewer
from ..models import Announcement, AppUpdate, PackJob

router = APIRouter(prefix="/api/app-notices", tags=["app-ops"])
update_router = APIRouter(prefix="/api/app-updates", tags=["app-ops"])
public = APIRouter(prefix="/pub", tags=["public"], dependencies=[Depends(pub_limit)])

APP_ID = r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$"
APP_ID_RE = re.compile(APP_ID)
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
NOTICE_APP = r"^(\*|[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+)$"
MAX_PUBLIC_NOTICES = 5


# ---------------------------------------------------------------- 公告

def _active(n: Announcement, now: float) -> bool:
    return bool(n.enabled and (not n.starts_at or n.starts_at <= now) and (not n.ends_at or n.ends_at > now))


def notice_out(n: Announcement, now: float | None = None) -> dict[str, Any]:
    return {"id": n.id, "app": n.app, "title": n.title, "body": n.body, "level": n.level, "enabled": n.enabled,
            "starts_at": n.starts_at, "ends_at": n.ends_at, "created_by": n.created_by, "created_at": n.created_at,
            "updated_at": n.updated_at, "active": _active(n, now or time.time())}


class NoticeIn(BaseModel):
    app: str = Field(default="*", max_length=128, pattern=NOTICE_APP)
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(default="", max_length=2000)
    level: Literal["info", "warning", "urgent"] = "info"
    enabled: bool = True
    starts_at: int | None = Field(default=None, ge=0)
    ends_at: int | None = Field(default=None, ge=0)

    @field_validator("ends_at")
    @classmethod
    def _order(cls, v, info):
        s = info.data.get("starts_at")
        if v and s and v <= s:
            raise ValueError("结束时间必须晚于开始时间")
        return v


class NoticePatch(BaseModel):
    app: str | None = Field(default=None, max_length=128, pattern=NOTICE_APP)
    title: str | None = Field(default=None, min_length=1, max_length=120)
    body: str | None = Field(default=None, max_length=2000)
    level: Literal["info", "warning", "urgent"] | None = None
    enabled: bool | None = None
    starts_at: int | None = Field(default=None, ge=0)
    ends_at: int | None = Field(default=None, ge=0)


@router.get("")
def list_notices(p: Principal = Depends(viewer), s: Session = Depends(db_session), app: str = ""):
    stmt = select(Announcement).order_by(Announcement.id.desc()).limit(500)
    if app:
        stmt = stmt.where(Announcement.app == app)
    now = time.time()
    return {"items": [notice_out(n, now) for n in s.scalars(stmt)]}


@router.post("")
def create_notice(body: NoticeIn, request: Request, p: Principal = Depends(operator),
                  s: Session = Depends(db_session)):
    n = Announcement(created_by=p.username, **body.model_dump())
    s.add(n)
    s.flush()
    record(request, s, p, "notice.create", "%s #%d" % (n.app, n.id), {"title": n.title, "level": n.level})
    s.commit()
    return notice_out(n)


@router.patch("/{notice_id}")
def update_notice(notice_id: int, body: NoticePatch, request: Request, p: Principal = Depends(operator),
                  s: Session = Depends(db_session)):
    n = s.get(Announcement, notice_id)
    if n is None:
        raise HTTPException(404, "公告不存在")
    changes = body.model_dump(exclude_unset=True)
    for k, v in changes.items():
        if k in ("title", "app", "level", "enabled") and v is None:
            continue
        setattr(n, k, v)
    if n.starts_at and n.ends_at and n.ends_at <= n.starts_at:
        raise HTTPException(400, "结束时间必须晚于开始时间")
    n.updated_at = int(time.time())
    record(request, s, p, "notice.update", "%s #%d" % (n.app, n.id), {k: v for k, v in changes.items() if k != "body"})
    s.commit()
    return notice_out(n)


@router.delete("/{notice_id}")
def delete_notice(notice_id: int, request: Request, p: Principal = Depends(operator),
                  s: Session = Depends(db_session)):
    n = s.get(Announcement, notice_id)
    if n is None:
        raise HTTPException(404, "公告不存在")
    s.delete(n)
    record(request, s, p, "notice.delete", "%s #%d" % (n.app, n.id), {"title": n.title})
    s.commit()
    return {"ok": True}


@public.get("/app-notices")
def public_notices(app: str = Query(max_length=128, pattern=APP_ID), version_code: int = Query(default=0, ge=0),
                   s: Session = Depends(db_session)):
    """Announcements for this app (and the * ones) that are enabled and inside their time window, newest first."""
    now = int(time.time())
    rows = s.scalars(select(Announcement).where(
        Announcement.enabled.is_(True), or_(Announcement.app == app, Announcement.app == "*"),
        or_(Announcement.starts_at.is_(None), Announcement.starts_at == 0, Announcement.starts_at <= now),
        or_(Announcement.ends_at.is_(None), Announcement.ends_at == 0, Announcement.ends_at > now),
    ).order_by(Announcement.id.desc()).limit(MAX_PUBLIC_NOTICES))
    return {"items": [{"id": n.id, "title": n.title, "body": n.body, "level": n.level, "created_at": n.created_at}
                      for n in rows]}


# ---------------------------------------------------------------- APK 更新策略 / 强制更新

def _apk_path(request: Request, job: PackJob | None):
    if job is None or not job.apk_file:
        return None
    path = ctx(request).packer.job_dir(job.id) / "out" / job.apk_file
    return path if path.is_file() else None


def update_out(request: Request, u: AppUpdate, s: Session) -> dict[str, Any]:
    job = s.get(PackJob, u.job_id) if u.job_id else None
    return {"app": u.app, "latest_code": u.latest_code, "latest_name": u.latest_name, "min_code": u.min_code,
            "job_id": u.job_id, "url": u.url, "sha256": u.sha256, "size": u.size, "notes": u.notes,
            "updated_by": u.updated_by, "updated_at": u.updated_at,
            "apk_available": bool(u.url) or _apk_path(request, job) is not None}


class UpdateIn(BaseModel):
    job_id: int | None = Field(default=None, ge=1)  # a finished pack job: version, size and sha256 come from it
    url: str = Field(default="", max_length=512, pattern=r"^(|https?://\S+)$")  # or an external download URL
    latest_code: int | None = Field(default=None, ge=1, le=2100000000)  # required with url
    latest_name: str = Field(default="", max_length=32, pattern=r"^[0-9A-Za-z.\-_+]*$")
    sha256: str = Field(default="", max_length=64)
    min_code: int = Field(default=0, ge=0, le=2100000000)  # 0 = nobody is forced
    notes: str = Field(default="", max_length=1000)


def _sha256_file(path) -> tuple[str, int]:
    h, n = hashlib.sha256(), 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            n += len(chunk)
    return h.hexdigest(), n


@update_router.get("")
def list_updates(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    rows = s.scalars(select(AppUpdate).order_by(AppUpdate.app))
    return {"items": [update_out(request, u, s) for u in rows]}


@update_router.put("/{app}")
async def set_update(app: str, body: UpdateIn, request: Request, p: Principal = Depends(admin)):
    if not APP_ID_RE.match(app):
        raise HTTPException(400, "无效的应用包名")
    c = ctx(request)
    digest, size, code, name = "", 0, body.latest_code, body.latest_name
    if body.job_id:
        with c.db.session() as s:
            job = s.get(PackJob, body.job_id)
            if job is None or job.status != "succeeded" or not job.apk_file:
                raise HTTPException(400, "只能选择打包成功且保留了 APK 的任务")
            if job.app_id != app:
                raise HTTPException(400, "这个打包任务的应用是 %s，不是 %s" % (job.app_id, app))
            path = _apk_path(request, job)
            code, name = job.version_code, job.version
        if path is None:
            raise HTTPException(400, "APK 文件已被清理")
        digest, size = await run_in_threadpool(_sha256_file, path)
    elif body.url:
        if not code:
            raise HTTPException(400, "使用下载链接时必须填写最新版本号")
        if body.sha256 and not SHA256_RE.match(body.sha256):
            raise HTTPException(400, "sha256 应为 64 位十六进制")
        digest = body.sha256.lower()
    else:
        raise HTTPException(400, "选择一个打包任务，或填写下载链接")
    if body.min_code > code:
        raise HTTPException(400, "最低版本号不能高于最新版本号 %d" % code)
    with c.db.session() as s:
        u = s.get(AppUpdate, app)
        if u is None:
            u = AppUpdate(app=app)
            s.add(u)
        u.latest_code, u.latest_name, u.min_code = code, name, body.min_code
        u.job_id, u.url, u.sha256, u.size, u.notes = body.job_id if body.job_id else None, \
            "" if body.job_id else body.url, digest, size, body.notes
        u.updated_by, u.updated_at = p.username, int(time.time())
        record(request, s, p, "app.update_set", app, {"latest": code, "min": body.min_code,
                                                      "job": body.job_id, "url": bool(body.url)})
        s.commit()
        return update_out(request, u, s)


@update_router.delete("/{app}")
def delete_update(app: str, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    u = s.get(AppUpdate, app)
    if u is None:
        raise HTTPException(404, "没有这个应用的更新策略")
    s.delete(u)
    record(request, s, p, "app.update_clear", app)
    s.commit()
    return {"ok": True}


@public.get("/app-update")
def public_update(request: Request, app: str = Query(max_length=128, pattern=APP_ID),
                  version_code: int = Query(ge=0, le=2100000000), s: Session = Depends(db_session)):
    """Is a newer APK available for this installed version, and must it be installed (强制更新)?"""
    u = s.get(AppUpdate, app)
    if u is None or not u.latest_code:
        return {"update": False, "force": False}
    job = s.get(PackJob, u.job_id) if u.job_id else None
    if u.job_id:
        url = "/pub/app-update/apk?app=" + app if _apk_path(request, job) is not None else ""
        base = (get_settings(s).get("public_url") or "").rstrip("/")
        url = base + url if url and base else url
    else:
        url = u.url
    force = bool(u.min_code and version_code < u.min_code)
    newer = version_code < u.latest_code
    if not url:  # the APK was cleaned up: do not lock users out of an app they cannot update
        return {"update": False, "force": False}
    return {"update": newer or force, "force": force, "latest_version_code": u.latest_code,
            "latest_version_name": u.latest_name, "min_version_code": u.min_code, "url": url,
            "sha256": u.sha256, "size": u.size, "notes": u.notes}


@public.get("/app-update/apk", dependencies=[Depends(apk_limit)])
def public_update_apk(request: Request, app: str = Query(max_length=128, pattern=APP_ID),
                      s: Session = Depends(db_session)):
    u = s.get(AppUpdate, app)
    job = s.get(PackJob, u.job_id) if u and u.job_id else None
    path = _apk_path(request, job)
    if path is None:
        raise HTTPException(404, "没有可下载的更新")
    return FileResponse(path, media_type="application/vnd.android.package-archive", filename=job.apk_file)
