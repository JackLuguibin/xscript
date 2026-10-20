"""打包机: separate machines that build APKs (XSCRIPT_PACK_MODE=remote).

Admins add a worker and get its token once (`xsw_…`, only the hash is stored). The worker
(`python -m xscript_server pack-worker`) talks to /api/pack-worker with `Authorization: Bearer <token>`:

    POST /claim                    {"capabilities": {...}}  -> {"job": {...} | null, "poll_s": n}
    GET  /jobs/{id}/project        project.zip              GET /jobs/{id}/icon  icon.png
    POST /jobs/{id}/heartbeat      {"log": "<new output>"}  -> {"cancel": bool, "lease_s": n}
    POST /jobs/{id}/result         multipart: status, error, apk  (status: succeeded | failed | cancelled)

A worker may only touch the job it claimed and that is still running (409 otherwise: cancelled,
handed to another worker after its lease ran out, or deleted). Worker tokens open nothing else.
"""

from __future__ import annotations

import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..deps import Principal, admin, client_ip, ctx, db_session, record
from ..models import PackJob, PackWorker
from ..packer import WrongJob
from ..security import new_secret, token_hash

router = APIRouter(prefix="/api/pack/workers", tags=["pack"])
protocol = APIRouter(prefix="/api/pack-worker", tags=["pack-worker"])

TOKEN_PREFIX = "xsw_"
ONLINE_S = 60          # seen within this long = online (workers poll every few seconds)
POLL_S = 5
MAX_APK = 1024 * 1024 * 1024
MAX_LOG_CHUNK = 1024 * 1024
APK_NAME = re.compile(r"^(?!\.)[\w.\-+]{1,120}\.apk$")


# ---------------------------------------------------------------- admin: manage workers

class WorkerIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)


def worker_out(w: PackWorker, running: dict[int, int] | None = None, now: float | None = None) -> dict[str, Any]:
    now = now or time.time()
    caps = w.capabilities or {}
    return {"id": w.id, "name": w.name, "hint": w.hint, "created_at": w.created_at, "created_by": w.created_by,
            "disabled": w.disabled, "last_seen_at": w.last_seen_at, "last_ip": w.last_ip,
            "online": bool(w.last_seen_at and now - w.last_seen_at <= ONLINE_S and not w.disabled),
            "release": bool(caps.get("release")), "version": str(caps.get("version") or ""),
            "host": str(caps.get("host") or ""), "job_id": (running or {}).get(w.id)}


@router.get("")
def list_workers(request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    running = {wid: jid for jid, wid in s.execute(
        select(PackJob.id, PackJob.worker_id).where(PackJob.status == "running", PackJob.worker_id.is_not(None)))}
    rows = s.scalars(select(PackWorker).order_by(PackWorker.id))
    return {"items": [worker_out(w, running) for w in rows], "mode": ctx(request).config.pack_mode}


@router.post("")
def create_worker(body: WorkerIn, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    value = new_secret(TOKEN_PREFIX)
    w = PackWorker(name=body.name.strip(), token_hash=token_hash(value), hint=value[:4] + "…" + value[-4:],
                   created_by=p.username, created_at=int(time.time()), capabilities={})
    s.add(w)
    record(request, s, p, "pack_worker.create", w.name)
    s.commit()
    return {**worker_out(w), "token": value}


def _get(s: Session, worker_id: int) -> PackWorker:
    w = s.get(PackWorker, worker_id)
    if w is None:
        raise HTTPException(404, "打包机不存在")
    return w


@router.post("/{worker_id}/disable")
def disable_worker(worker_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    """Stops new claims and rejects the token. A build already running on it is lost: its lease runs out
    and the job is queued again for another worker."""
    w = _get(s, worker_id)
    w.disabled = True
    record(request, s, p, "pack_worker.disable", w.name)
    s.commit()
    return worker_out(w)


@router.post("/{worker_id}/enable")
def enable_worker(worker_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    w = _get(s, worker_id)
    w.disabled = False
    record(request, s, p, "pack_worker.enable", w.name)
    s.commit()
    return worker_out(w)


@router.delete("/{worker_id}")
def delete_worker(worker_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    w = _get(s, worker_id)
    if not w.disabled:
        raise HTTPException(400, "先停用再删除")
    if s.scalar(select(PackJob.id).where(PackJob.status == "running", PackJob.worker_id == w.id)):
        raise HTTPException(400, "这台打包机还有运行中的任务，等它结束或被重新排队后再删除")
    s.delete(w)
    record(request, s, p, "pack_worker.delete", w.name)
    s.commit()
    return {"ok": True}


# ---------------------------------------------------------------- the worker protocol

@dataclass
class Worker:
    id: int
    name: str


def current_worker(request: Request, s: Session = Depends(db_session)) -> Worker:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
    if not token.startswith(TOKEN_PREFIX):
        raise HTTPException(401, "需要打包机令牌")
    w = s.scalar(select(PackWorker).where(PackWorker.token_hash == token_hash(token)))
    if w is None:
        raise HTTPException(401, "打包机令牌无效")
    if w.disabled:
        raise HTTPException(403, "这台打包机已停用")
    now = int(time.time())
    ip = client_ip(request)
    if not w.last_seen_at or now - w.last_seen_at >= 5 or w.last_ip != ip:
        w.last_seen_at, w.last_ip = now, ip[:64]
        s.commit()
    return Worker(w.id, w.name)


def _not_mine() -> HTTPException:
    return HTTPException(409, "任务已不在这台打包机上（已取消、已重新分配或已删除）")


class ClaimIn(BaseModel):
    capabilities: dict[str, Any] = Field(default_factory=dict)


@protocol.post("/claim")
async def claim(body: ClaimIn, request: Request, w: Worker = Depends(current_worker),
                s: Session = Depends(db_session)):
    c = ctx(request)
    caps = {"release": bool(body.capabilities.get("release")),
            "version": str(body.capabilities.get("version") or "")[:32],
            "host": str(body.capabilities.get("host") or "")[:64]}
    row = s.get(PackWorker, w.id)
    if row is not None and (row.capabilities or {}) != caps:
        row.capabilities = caps
        s.commit()
    if not c.packer.remote:
        return {"job": None, "poll_s": POLL_S * 6, "mode": "local"}  # this server builds jobs itself
    job = await run_in_threadpool(c.packer.claim, w.id, caps)
    return {"job": job, "poll_s": POLL_S, "mode": "remote"}


def _file(request: Request, w: Worker, job_id: int, name: str, media: str) -> FileResponse:
    c = ctx(request)
    try:
        c.packer.check_owner(w.id, job_id)
    except WrongJob:
        raise _not_mine() from None
    path = c.packer.job_dir(job_id) / name
    if not path.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(path, media_type=media, filename=name)


@protocol.get("/jobs/{job_id}/project")
def get_project(job_id: int, request: Request, w: Worker = Depends(current_worker)):
    return _file(request, w, job_id, "project.zip", "application/zip")


@protocol.get("/jobs/{job_id}/icon")
def get_icon(job_id: int, request: Request, w: Worker = Depends(current_worker)):
    return _file(request, w, job_id, "icon.png", "image/png")


class BeatIn(BaseModel):
    log: str = Field(default="", max_length=MAX_LOG_CHUNK)


@protocol.post("/jobs/{job_id}/heartbeat")
def heartbeat(job_id: int, body: BeatIn, request: Request, w: Worker = Depends(current_worker)):
    try:
        return ctx(request).packer.heartbeat(w.id, job_id, body.log)
    except WrongJob:
        raise _not_mine() from None


@protocol.post("/jobs/{job_id}/result")
async def result(job_id: int, request: Request, status: Literal["succeeded", "failed", "cancelled"] = Form(...),
                 error: str = Form(default="", max_length=4000), apk: UploadFile | None = File(default=None),
                 w: Worker = Depends(current_worker)):
    c = ctx(request)
    try:
        await run_in_threadpool(c.packer.check_owner, w.id, job_id)
    except WrongJob:
        raise _not_mine() from None
    tmp: Path | None = None
    name = ""
    try:
        if status == "succeeded" and apk is not None and apk.filename:
            name = apk.filename
            if not APK_NAME.match(name):  # a bare file name: no directories, no "..", ends in .apk
                raise HTTPException(400, "APK 文件名不合法")
            fd, raw = tempfile.mkstemp(prefix="upload-", suffix=".apk", dir=c.packer.job_dir(job_id))
            tmp = Path(raw)
            size = 0
            with open(fd, "wb") as f:
                while chunk := await apk.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_APK:
                        raise HTTPException(413, "APK 太大")
                    f.write(chunk)
            if size == 0:
                raise HTTPException(400, "APK 是空文件")
        try:
            await run_in_threadpool(c.packer.complete, w.id, job_id, status, error or None, tmp, name)
        except WrongJob:
            raise _not_mine() from None
        tmp = None  # moved into out/
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    return {"ok": True}
