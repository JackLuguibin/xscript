"""APK 打包 jobs: upload a project zip, build in the background, download the APK."""

from __future__ import annotations

import json
import shutil
import time
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import scripts as scripts_store
from ..audit import get_settings
from ..deps import Principal, apk_limit, ctx, db_session, operator, paginate, pub_limit, record, viewer
from ..models import AppUpdate, DeviceKey, PackJob, Script, ScriptVersion, ShareLink
from ..packer import APP_ID, PROJECT_NAME
from ..security import new_secret, token_hash

router = APIRouter(prefix="/api/pack", tags=["pack"])

MAX_ZIP = 256 * 1024 * 1024
MAX_ICON = 2 * 1024 * 1024


class PackOptions(BaseModel):
    app_id: str = Field(max_length=128)
    app_name: str = Field(default="", max_length=64)
    version: str = Field(default="1.0.0", max_length=32, pattern=r"^[0-9A-Za-z.\-_+]+$")
    version_code: int = Field(default=1, ge=1, le=2100000000)
    project_name: str = Field(default="", max_length=64)
    abis: str = Field(default="arm64-v8a", pattern=r"^(arm64-v8a|x86_64|arm64-v8a,x86_64)$")
    license: bool = False          # require 卡密, verified against this server
    cloud: bool = False            # connect to this server's 云控 on first start
    cloud_group: str = Field(default="", max_length=64)
    autostart: bool = False
    dev_server: bool = False
    bundle_requirements: bool = False
    release: bool = False          # sign with the server keystore (XSCRIPT_KEYSTORE)
    protect: bool = False          # 代码保护: ship bytecode only
    # Build from a 小程序 version instead of an uploaded zip; hot_update follows its channel.
    script_id: int | None = None
    script_version_id: int | None = None
    hot_update: bool = False

    @field_validator("app_id")
    @classmethod
    def _app_id(cls, v: str) -> str:
        if not APP_ID.match(v):
            raise ValueError("包名格式应为 com.example.app")
        return v

    @field_validator("project_name")
    @classmethod
    def _project(cls, v: str) -> str:
        if v and not PROJECT_NAME.match(v):
            raise ValueError("工程名必须是合法的 Python 标识符")
        return v


HIDDEN_OPTS = {"cloud_url", "license_pubkey", "update_pubkey"}  # the URL embeds a device key


def job_out(j: PackJob, position: int | None = None) -> dict[str, Any]:
    opts = {k: v for k, v in (j.options or {}).items() if k not in HIDDEN_OPTS}
    return {"id": j.id, "status": j.status, "app_id": j.app_id, "app_name": j.app_name, "version": j.version,
            "version_code": j.version_code, "project_name": j.project_name, "options": opts,
            "created_by": j.created_by, "created_at": j.created_at, "started_at": j.started_at,
            "finished_at": j.finished_at, "apk_size": j.apk_size, "error": j.error,
            "has_apk": bool(j.apk_file), "queue_position": position, "worker_name": j.worker_name or "",
            "attempts": j.attempts or 0, "cancel_requested": bool(j.cancel_requested)}


@router.get("/info")
def pack_info(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    c = ctx(request)
    ok, why = c.packer.available()
    return {"available": ok, "reason": why, "release_signing": c.packer.release_signing(), "mode": c.config.pack_mode,
            "public_url": get_settings(s)["public_url"]}


@router.get("/jobs")
def list_jobs(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session),
              page: int = 1, page_size: int = 20):
    packer = ctx(request).packer
    total = s.scalar(select(func.count()).select_from(PackJob)) or 0
    off, size = paginate(page, page_size)
    rows = s.scalars(select(PackJob).order_by(PackJob.id.desc()).offset(off).limit(size))
    return {"items": [job_out(j, packer.position(j.id)) for j in rows], "total": total}


@router.get("/jobs/{job_id}")
def get_job(job_id: int, request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    j = s.get(PackJob, job_id)
    if j is None:
        raise HTTPException(404, "任务不存在")
    return job_out(j, ctx(request).packer.position(j.id))


@router.get("/jobs/{job_id}/log")
def job_log(job_id: int, request: Request, offset: int = 0, p: Principal = Depends(viewer)):
    text, nxt = ctx(request).packer.read_log(job_id, offset)
    return {"text": text, "next": nxt}


@router.get("/jobs/{job_id}/apk")
def download_apk(job_id: int, request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    j = s.get(PackJob, job_id)
    if j is None or not j.apk_file:
        raise HTTPException(404, "没有 APK")
    path = ctx(request).packer.job_dir(job_id) / "out" / j.apk_file
    if not path.is_file():
        raise HTTPException(404, "APK 文件已被清理")
    return FileResponse(path, media_type="application/vnd.android.package-archive", filename=j.apk_file)


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: int, request: Request, p: Principal = Depends(operator)):
    if not await ctx(request).packer.cancel(job_id):
        raise HTTPException(400, "任务不在排队或运行中")
    return {"ok": True}


@router.delete("/jobs/{job_id}")
def delete_job(job_id: int, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    c = ctx(request)
    j = s.get(PackJob, job_id)
    if j is None:
        raise HTTPException(404, "任务不存在")
    if j.status in ("queued", "running"):
        raise HTTPException(400, "先取消任务")
    if s.scalar(select(AppUpdate).where(AppUpdate.job_id == job_id)) is not None:
        raise HTTPException(400, "这个任务的 APK 正在作为应用更新使用，先在「应用运营」里更换或清除更新策略")
    s.delete(j)
    record(request, s, p, "pack.delete", j.app_id, {"job": job_id})
    s.commit()
    shutil.rmtree(c.packer.job_dir(job_id), ignore_errors=True)
    return {"ok": True}


# ---------------------------------------------------------------- 分发: public download links

def share_out(l: ShareLink) -> dict[str, Any]:
    return {"id": l.id, "job_id": l.job_id, "token": l.token, "path": "/d/" + l.token, "created_by": l.created_by,
            "created_at": l.created_at, "expires_at": l.expires_at, "downloads": l.downloads, "disabled": l.disabled}


class ShareIn(BaseModel):
    days: float = Field(default=0, ge=0, le=3650)  # 0 = no expiry


@router.get("/jobs/{job_id}/shares")
def list_shares(job_id: int, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    rows = s.scalars(select(ShareLink).where(ShareLink.job_id == job_id).order_by(ShareLink.id.desc()))
    return {"items": [share_out(l) for l in rows]}


@router.post("/jobs/{job_id}/shares")
def create_share(job_id: int, body: ShareIn, request: Request, p: Principal = Depends(operator),
                 s: Session = Depends(db_session)):
    j = s.get(PackJob, job_id)
    if j is None or not j.apk_file:
        raise HTTPException(400, "只有打包成功的任务可以分发")
    now = int(time.time())
    link = ShareLink(job_id=job_id, token=new_secret("")[:22], created_by=p.username, created_at=now,
                     expires_at=now + int(body.days * 86400) if body.days else None)
    s.add(link)
    record(request, s, p, "pack.share", j.app_id, {"job": job_id, "days": body.days})
    s.commit()
    return share_out(link)


@router.delete("/shares/{share_id}")
def delete_share(share_id: int, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    link = s.get(ShareLink, share_id)
    if link is None:
        raise HTTPException(404, "链接不存在")
    s.delete(link)
    record(request, s, p, "pack.unshare", str(link.job_id), {"share": share_id})
    s.commit()
    return {"ok": True}


public = APIRouter(prefix="/pub/d", tags=["public"], dependencies=[Depends(pub_limit)])


def _live_share(s: Session, token: str) -> tuple[ShareLink, PackJob]:
    link = s.scalar(select(ShareLink).where(ShareLink.token == token)) if token else None
    j = s.get(PackJob, link.job_id) if link else None
    if link is None or j is None or link.disabled or not j.apk_file or \
            (link.expires_at and link.expires_at < time.time()):
        raise HTTPException(404, "链接不存在或已失效")
    return link, j


@public.get("/{token}")
def share_info(token: str, s: Session = Depends(db_session)):
    link, j = _live_share(s, token)
    site = get_settings(s)["site_name"]
    return {"app_name": j.app_name or j.app_id, "app_id": j.app_id, "version": j.version,
            "version_code": j.version_code, "size": j.apk_size, "built_at": j.finished_at,
            "expires_at": link.expires_at, "site_name": site, "apk": "/pub/d/%s/apk" % token}


@public.get("/{token}/apk", dependencies=[Depends(apk_limit)])
def share_apk(token: str, request: Request, s: Session = Depends(db_session)):
    link, j = _live_share(s, token)
    path = ctx(request).packer.job_dir(j.id) / "out" / j.apk_file
    if not path.is_file():
        raise HTTPException(404, "APK 文件已被清理")
    link.downloads += 1
    s.commit()
    return FileResponse(path, media_type="application/vnd.android.package-archive", filename=j.apk_file)


async def _save_upload(up: UploadFile, dest, limit: int) -> None:
    size = 0
    with open(dest, "wb") as f:
        while chunk := await up.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise HTTPException(413, "文件太大（上限 %d MB）" % (limit // 1024 // 1024))
            f.write(chunk)


@router.post("/jobs")
async def create_job(request: Request, options: str = Form(...), project: UploadFile | None = File(default=None),
                     icon: UploadFile | None = File(default=None), p: Principal = Depends(operator)):
    c = ctx(request)
    ok, why = c.packer.available()
    if not ok:
        raise HTTPException(503, why)
    try:
        o = PackOptions.model_validate(json.loads(options))
    except (ValueError, ValidationError) as e:
        msg = e.errors()[0]["msg"] if isinstance(e, ValidationError) else "options 不是合法 JSON"
        raise HTTPException(400, msg) from None
    if o.release and not c.packer.release_signing():
        raise HTTPException(400, "打包机没有配置签名证书（XSCRIPT_KEYSTORE / XSCRIPT_STORE_PASS）" if c.packer.remote
                            else "服务器没有配置签名证书（XSCRIPT_KEYSTORE / XSCRIPT_STORE_PASS）")
    from_script = o.script_id is not None
    if not from_script and (project is None or not (project.filename or "").lower().endswith(".zip")):
        raise HTTPException(400, "工程需要上传 .zip，或选择一个小程序版本")
    if o.hot_update and not from_script:
        raise HTTPException(400, "热更新需要从小程序版本打包")

    with c.db.session() as s:
        public_url = (get_settings(s)["public_url"] or "").rstrip("/")
        if (o.license or o.cloud or o.hot_update) and not public_url:
            raise HTTPException(400, "先在系统设置里填写服务器公网地址")
        source_zip = None
        if from_script:
            sc = s.get(Script, o.script_id)
            if sc is None:
                raise HTTPException(404, "小程序不存在")
            vid = o.script_version_id or sc.current_version_id
            v = s.get(ScriptVersion, vid) if vid else None
            if v is None or v.script_id != sc.id:
                raise HTTPException(400, "选择要打包的版本")
            source_zip = scripts_store.version_dir(c.config, sc.id, v.id) / "source.zip"
            if not source_zip.is_file():
                raise HTTPException(404, "版本文件已丢失")
            if o.hot_update and o.project_name and o.project_name != sc.project_name:
                # The update manifest names the 小程序's project; the app rejects any other name,
                # so a renamed pack would never apply an update.
                raise HTTPException(400, "热更新要求工程名和小程序一致（%s），请清空高级选项里的工程名" % sc.project_name)
            o.project_name = o.project_name or sc.project_name
            o.protect = o.protect or sc.protect
        opts: dict[str, Any] = o.model_dump(exclude={"app_id", "app_name", "version", "version_code", "project_name"})
        if from_script:
            opts.update(script_version_id=v.id, script_name=sc.name, script_version=v.version,
                        script_code=v.version_code)
            if o.hot_update:
                opts.update(update_server=public_url, update_channel=sc.channel, update_pubkey=c.pubkey)
        if public_url:
            opts["ops_server"] = public_url  # packed apps read /pub/app-notices and /pub/app-update from here
        if o.license:
            opts["license_pubkey"] = c.pubkey
            opts["license_server"] = public_url
        if o.cloud:
            # Device keys are stored hashed, so each packed app gets its own new key. Revoking
            # it on the 设备密钥 page cuts off that app without touching other devices.
            value = new_secret("xsd_")
            key = DeviceKey(name="打包 %s" % o.app_id, token_hash=token_hash(value),
                            hint=value[:4] + "…" + value[-4:], created_by=p.username)
            s.add(key)
            s.flush()
            opts["cloud_key_id"] = key.id
            ws = public_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
            opts["cloud_url"] = "%s/ws?token=%s" % (ws, value)
        job = PackJob(app_id=o.app_id, app_name=o.app_name, version=o.version, version_code=o.version_code,
                      project_name=o.project_name, options=opts, created_by=p.username, created_at=int(time.time()))
        s.add(job)
        s.flush()
        job_id = job.id
        d = c.packer.job_dir(job_id)
        d.mkdir(parents=True, exist_ok=True)
        try:
            if source_zip is not None:
                shutil.copyfile(source_zip, d / "project.zip")
            else:
                await _save_upload(project, d / "project.zip", MAX_ZIP)
            if icon is not None and icon.filename:
                if not icon.filename.lower().endswith(".png"):
                    raise HTTPException(400, "图标需要 .png")
                await _save_upload(icon, d / "icon.png", MAX_ICON)
        except HTTPException:
            s.rollback()
            shutil.rmtree(d, ignore_errors=True)
            raise
        record(request, s, p, "pack.create", o.app_id, {"job": job_id, "version": o.version,
                                                         "license": o.license, "cloud": o.cloud,
                                                         "script": opts.get("script_name"),
                                                         "hot_update": o.hot_update, "protect": o.protect})
        s.commit()
        out = job_out(job)
    c.packer.submit(job_id)
    out["queue_position"] = c.packer.position(job_id)
    return out
