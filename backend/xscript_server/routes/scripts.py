"""小程序管理: versioned projects, publish (热更新 channel), deploy to devices, public update API.

Roles: operators upload versions (and can pack them); publishing and deploying ship code to
devices, so they need admin, like writing files over the device relay.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import shutil
import time
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .. import licensing
from .. import scripts as store
from ..deps import Principal, admin, apk_limit, ctx, db_session, operator, pub_limit, record, viewer
from ..models import Script, ScriptVersion
from ..packer import PROJECT_NAME

router = APIRouter(prefix="/api/scripts", tags=["scripts"])
public = APIRouter(prefix="/pub", tags=["public"], dependencies=[Depends(pub_limit)])

VERSION_RE = r"^[0-9A-Za-z.\-_+]{1,32}$"
# A deploy travels as one base64 WebSocket frame; OkHttp and uvicorn both cap frames at 16 MiB.
MAX_DEPLOY_BUNDLE = 11 * 1024 * 1024
DEPLOY_PARALLEL = 8


def bump(version: str) -> str:
    m = re.match(r"^(.*?)(\d+)([^\d]*)$", version or "")
    return "%s%d%s" % (m.group(1), int(m.group(2)) + 1, m.group(3)) if m else "1.0.0"


def version_out(v: ScriptVersion, current_id: int | None = None) -> dict[str, Any]:
    return {"id": v.id, "version": v.version, "version_code": v.version_code, "notes": v.notes,
            "sha256": v.sha256, "size": v.size, "files": v.files, "downloads": v.downloads,
            "created_by": v.created_by, "created_at": v.created_at, "current": v.id == current_id}


def script_out(sc: Script, s: Session) -> dict[str, Any]:
    cur = s.get(ScriptVersion, sc.current_version_id) if sc.current_version_id else None
    latest = s.scalar(select(ScriptVersion).where(ScriptVersion.script_id == sc.id)
                      .order_by(ScriptVersion.version_code.desc()).limit(1))
    count = s.scalar(select(func.count()).select_from(ScriptVersion).where(ScriptVersion.script_id == sc.id)) or 0
    return {"id": sc.id, "name": sc.name, "project_name": sc.project_name, "description": sc.description,
            "protect": sc.protect, "channel": sc.channel, "created_by": sc.created_by, "created_at": sc.created_at,
            "updated_at": sc.updated_at, "versions": count,
            "current": version_out(cur, sc.current_version_id) if cur else None,
            "latest": version_out(latest, sc.current_version_id) if latest else None}


def _get(s: Session, script_id: int) -> Script:
    sc = s.get(Script, script_id)
    if sc is None:
        raise HTTPException(404, "小程序不存在")
    return sc


def _get_version(s: Session, sc: Script, version_id: int) -> ScriptVersion:
    v = s.get(ScriptVersion, version_id)
    if v is None or v.script_id != sc.id:
        raise HTTPException(404, "版本不存在")
    return v


# ---------------------------------------------------------------- scripts

class ScriptIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    project_name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=2000)
    protect: bool = False

    @field_validator("project_name")
    @classmethod
    def _project(cls, v: str) -> str:
        if not PROJECT_NAME.match(v):
            raise ValueError("工程名必须是合法的 Python 标识符，例如 my_game")
        return v


class ScriptPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=2000)
    protect: bool | None = None


@router.get("")
def list_scripts(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    rows = s.scalars(select(Script).order_by(Script.updated_at.desc()))
    return {"items": [script_out(sc, s) for sc in rows]}


@router.post("")
def create_script(body: ScriptIn, request: Request, p: Principal = Depends(operator),
                  s: Session = Depends(db_session)):
    sc = Script(name=body.name.strip(), project_name=body.project_name, description=body.description,
                protect=body.protect, channel=store.new_channel(), created_by=p.username)
    s.add(sc)
    s.flush()
    record(request, s, p, "script.create", sc.name, {"id": sc.id, "project": sc.project_name})
    s.commit()
    return script_out(sc, s)


@router.get("/{script_id}")
def get_script(script_id: int, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    return script_out(_get(s, script_id), s)


@router.patch("/{script_id}")
def update_script(script_id: int, body: ScriptPatch, request: Request, p: Principal = Depends(operator),
                  s: Session = Depends(db_session)):
    sc = _get(s, script_id)
    changes = body.model_dump(exclude_none=True)
    if "protect" in changes and changes["protect"] != sc.protect and not p.at_least("admin"):
        # Turning protection off changes what already-published apps download.
        raise HTTPException(403, "修改代码保护需要管理员权限")
    for k, v in changes.items():
        setattr(sc, k, v.strip() if isinstance(v, str) and k == "name" else v)
    sc.updated_at = int(time.time())
    record(request, s, p, "script.update", sc.name, changes)
    s.commit()
    return script_out(sc, s)


@router.delete("/{script_id}")
def delete_script(script_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    sc = _get(s, script_id)
    for v in s.scalars(select(ScriptVersion).where(ScriptVersion.script_id == sc.id)):
        s.delete(v)
    s.delete(sc)
    record(request, s, p, "script.delete", sc.name, {"id": script_id})
    s.commit()
    store.delete_script_files(ctx(request).config, script_id)
    return {"ok": True}


# ---------------------------------------------------------------- versions

@router.get("/{script_id}/versions")
def list_versions(script_id: int, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    sc = _get(s, script_id)
    rows = s.scalars(select(ScriptVersion).where(ScriptVersion.script_id == sc.id)
                     .order_by(ScriptVersion.version_code.desc()))
    return {"items": [version_out(v, sc.current_version_id) for v in rows]}


@router.post("/{script_id}/versions")
async def upload_version(script_id: int, request: Request, file: UploadFile = File(...),
                         version: str = Form(default=""), notes: str = Form(default="", max_length=4000),
                         publish: bool = Form(default=False), p: Principal = Depends(operator)):
    c = ctx(request)
    if publish and not p.at_least("admin"):
        raise HTTPException(403, "发布需要管理员权限")
    if version and not re.match(VERSION_RE, version):
        raise HTTPException(400, "版本号只能包含字母、数字和 . - _ +")
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "需要上传工程 .zip")

    with c.db.session() as s:
        sc = _get(s, script_id)
        last = s.scalar(select(ScriptVersion).where(ScriptVersion.script_id == sc.id)
                        .order_by(ScriptVersion.version_code.desc()).limit(1))
        code = (last.version_code if last else 0) + 1
        ver = version or (bump(last.version) if last else "1.0.0")

    tmp_dir = c.config.scripts_dir / str(script_id) / (".upload-%d" % time.time_ns())
    tmp_dir.mkdir(parents=True, exist_ok=True)
    src = tmp_dir / "source.zip"
    try:
        size = 0
        with open(src, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > store.MAX_SOURCE_ZIP:
                    raise HTTPException(413, "工程太大（上限 %d MB）" % (store.MAX_SOURCE_ZIP // 1024 // 1024))
                f.write(chunk)
        # The archive's top folder is stripped on install; the 小程序's project_name decides the
        # package name on devices, so any folder name works.
        try:
            _top, files = await run_in_threadpool(store.inspect_zip, src)
        except Exception as e:  # BadZipFile, unsafe paths, no entry
            raise HTTPException(400, "工程压缩包无效: %s" % e) from None
        digest = await run_in_threadpool(store.sha256_file, src)

        with c.db.session() as s:
            sc = _get(s, script_id)
            if s.scalar(select(ScriptVersion).where(ScriptVersion.script_id == sc.id,
                                                    ScriptVersion.version == ver)):
                raise HTTPException(409, "版本 %s 已存在" % ver)
            v = ScriptVersion(script_id=sc.id, version=ver, version_code=code, notes=notes, sha256=digest,
                              size=size, files=files, created_by=p.username)
            s.add(v)
            s.flush()
            dest = store.version_dir(c.config, sc.id, v.id)
            dest.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), dest / "source.zip")
            if publish:
                sc.current_version_id = v.id
            sc.updated_at = int(time.time())
            record(request, s, p, "script.version", "%s %s" % (sc.name, ver),
                   {"id": sc.id, "version_id": v.id, "code": code, "publish": publish, "sha256": digest})
            s.commit()
            out = version_out(v, sc.current_version_id)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return out


class PublishIn(BaseModel):
    version_id: int


@router.post("/{script_id}/publish")
def publish_version(script_id: int, body: PublishIn, request: Request, p: Principal = Depends(admin),
                    s: Session = Depends(db_session)):
    """Make a version current. Packed apps on this channel pick it up (热更新); older = rollback."""
    sc = _get(s, script_id)
    v = _get_version(s, sc, body.version_id)
    prev = sc.current_version_id
    sc.current_version_id = v.id
    sc.updated_at = int(time.time())
    record(request, s, p, "script.publish", "%s %s" % (sc.name, v.version), {"id": sc.id, "version_id": v.id,
                                                                            "previous": prev})
    s.commit()
    return script_out(sc, s)


@router.post("/{script_id}/unpublish")
def unpublish(script_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    sc = _get(s, script_id)
    sc.current_version_id = None
    record(request, s, p, "script.unpublish", sc.name, {"id": sc.id})
    s.commit()
    return script_out(sc, s)


@router.delete("/{script_id}/versions/{version_id}")
def delete_version(script_id: int, version_id: int, request: Request, p: Principal = Depends(admin),
                   s: Session = Depends(db_session)):
    sc = _get(s, script_id)
    v = _get_version(s, sc, version_id)
    if sc.current_version_id == v.id:
        raise HTTPException(400, "这是当前发布的版本，先发布其他版本")
    s.delete(v)
    record(request, s, p, "script.version_delete", "%s %s" % (sc.name, v.version), {"id": sc.id})
    s.commit()
    store.delete_script_files(ctx(request).config, script_id, version_id)
    return {"ok": True}


@router.get("/{script_id}/versions/{version_id}/source")
def download_source(script_id: int, version_id: int, request: Request, p: Principal = Depends(operator),
                    s: Session = Depends(db_session)):
    sc = _get(s, script_id)
    v = _get_version(s, sc, version_id)
    path = store.version_dir(ctx(request).config, sc.id, v.id) / "source.zip"
    if not path.is_file():
        raise HTTPException(404, "文件已丢失")
    return FileResponse(path, media_type="application/zip", filename="%s-%s.zip" % (sc.project_name, v.version))


# ---------------------------------------------------------------- deploy to 云控 devices

class DeployIn(BaseModel):
    target: str = Field(min_length=1, max_length=100000)
    version_id: int | None = None  # default: current, else latest
    run: bool = True
    params: dict[str, Any] = Field(default_factory=dict)
    timeout: float = Field(default=60, ge=5, le=300)


class DeployError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


async def deploy_script(c, script_id: int, target: str, version_id: int | None = None, run: bool = True,
                        params: dict[str, Any] | None = None, timeout: float = 60) -> dict[str, Any]:
    """Install a 小程序 version on online devices (PUT /projects/<name>/zip over the relay), then run it.

    version_id None = the published version, else the latest. Used by the API and by 定时任务
    (command {"path": "script_deploy", "script_id", "version_id"?, "run"?, "param"?}).
    """
    def _load():
        with c.db.session() as s:
            sc = s.get(Script, script_id)
            if sc is None:
                raise DeployError(404, "小程序不存在")
            vid = version_id or sc.current_version_id
            if vid is None:
                latest = s.scalar(select(ScriptVersion).where(ScriptVersion.script_id == sc.id)
                                  .order_by(ScriptVersion.version_code.desc()).limit(1))
                if latest is None:
                    raise DeployError(400, "还没有上传版本")
                vid = latest.id
            v = s.get(ScriptVersion, vid)
            if v is None or v.script_id != sc.id:
                raise DeployError(404, "版本不存在")
            return sc.name, sc.project_name, sc.protect, v.id, v.version

    name, project, protect, vid, ver = await run_in_threadpool(_load)
    try:
        path, digest, size = await run_in_threadpool(store.bundle, c.config, script_id, vid, protect)
    except RuntimeError as e:
        raise DeployError(500, str(e)) from None
    if size > MAX_DEPLOY_BUNDLE:
        raise DeployError(413, "工程 %.1f MB，云控下发上限 %d MB；大文件请用打包或热更新"
                          % (size / 1e6, MAX_DEPLOY_BUNDLE // 1024 // 1024))
    data = await run_in_threadpool(path.read_bytes)
    conns = await c.hub.select(target)
    sem = asyncio.Semaphore(DEPLOY_PARALLEL)

    async def one(conn) -> dict[str, Any]:
        async with sem:
            try:
                reply = await c.hub.relay(conn, "PUT", "/projects/%s/zip" % project, {"replace": "true"}, data, timeout)
            except asyncio.TimeoutError:
                return {"code": -1, "msg": "安装超时"}
            except Exception as e:  # socket closed
                return {"code": -1, "msg": str(e) or type(e).__name__}
            status = int(reply.get("status", 0) or 0)
            if status != 200:
                try:
                    err = json.loads(base64.b64decode(reply.get("body") or "")).get("error")
                except Exception:
                    err = None
                return {"code": -1, "msg": "安装失败: %s" % (err or reply.get("msg") or status)}
            if not run:
                return {"code": 1, "msg": "已安装"}
            r = await c.hub.call(conn, {"path": "app_run", "id": project, "param": params or {}}, 20)
            return {"code": r.get("code", -1), "msg": "已安装并启动" if r.get("code") == 1 else
                    "已安装，启动失败: %s" % r.get("msg")}

    results = await asyncio.gather(*(one(conn) for conn in conns))
    out = {conn.id: r for conn, r in zip(conns, results)}
    ok = sum(1 for r in out.values() if r.get("code") == 1)
    c.hub.note("下发 %s %s → %s（%d/%d 台）" % (name, ver, target[:40], ok, len(out)))
    return {"results": out, "devices": len(out), "ok": ok, "version": ver, "name": name, "version_id": vid,
            "sha256": digest}


@router.post("/{script_id}/deploy")
async def deploy(script_id: int, body: DeployIn, request: Request, p: Principal = Depends(admin)):
    """Install a version on online devices over the 云控 socket (PUT /projects/<name>/zip), then run it."""
    c = ctx(request)
    try:
        res = await deploy_script(c, script_id, body.target, body.version_id, body.run, body.params, body.timeout)
    except DeployError as e:
        raise HTTPException(e.status, str(e)) from None

    def _audit():
        with c.db.session() as s:
            record(request, s, p, "script.deploy", "%s %s" % (res["name"], res["version"]),
                   {"id": script_id, "version_id": res["version_id"], "target": body.target[:255], "run": body.run,
                    "devices": res["devices"], "ok": res["ok"], "sha256": res["sha256"]})
            s.commit()

    await run_in_threadpool(_audit)
    return {k: res[k] for k in ("results", "devices", "ok", "version")}


# ---------------------------------------------------------------- 热更新 (public, packed apps)

@public.get("/update")
def check_update(request: Request, channel: str = "", code: int = 0, s: Session = Depends(db_session)):
    """Latest published version for a channel, as a signed manifest the app verifies."""
    sc = s.scalar(select(Script).where(Script.channel == channel)) if channel else None
    if sc is None:
        raise HTTPException(404, "unknown channel")
    v = s.get(ScriptVersion, sc.current_version_id) if sc.current_version_id else None
    if v is None or v.version_code == code:
        return {"update": False}
    c = ctx(request)
    try:
        _, digest, size = store.bundle(c.config, sc.id, v.id, sc.protect)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from None
    manifest = {"channel": sc.channel, "project": sc.project_name, "version": v.version,
                "version_code": v.version_code, "sha256": digest, "size": size, "iat": int(time.time())}
    return {"update": True, "manifest": licensing.sign(c.key, manifest), "notes": v.notes,
            "url": "/pub/bundle/%s/%d.zip" % (sc.channel, v.version_code)}


@public.get("/bundle/{channel}/{code}.zip", dependencies=[Depends(apk_limit)])
def get_bundle(channel: str, code: int, request: Request, s: Session = Depends(db_session)):
    sc = s.scalar(select(Script).where(Script.channel == channel))
    v = s.scalar(select(ScriptVersion).where(ScriptVersion.script_id == sc.id, ScriptVersion.version_code == code)) \
        if sc else None
    # Only the current version is served: unpublished code stays private.
    if sc is None or v is None or v.id != sc.current_version_id:
        raise HTTPException(404, "not found")
    path, _, _ = store.bundle(ctx(request).config, sc.id, v.id, sc.protect)
    v.downloads += 1
    s.commit()
    return FileResponse(path, media_type="application/zip", filename="%s-%d.zip" % (sc.project_name, code),
                        headers={"Cache-Control": "no-store"})
