"""Devices: live + historical list, group / note edits, commands, HTTP relay, device keys, /ws."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import time
from typing import Any, Iterator, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..db import values_in
from ..deps import Principal, admin, ctx, db_session, like_contains, operator, paginate, record, viewer
from ..hub import Conn
from ..models import Device, DeviceKey, DeviceLog
from ..security import new_secret, token_hash

router = APIRouter(prefix="/api", tags=["devices"])
EXPORT_MAX = 100_000  # lines per 运行日志 export
EXPORT_CHUNK = 2000   # lines per streamed chunk
ws_router = APIRouter()

# Relayed device paths an operator may call. Everything else on the device API (upload
# files, /eval, packages, models, settings) runs or installs code and needs admin.
OPERATOR_RELAY = {
    ("GET", "/status"), ("GET", "/projects"), ("GET", "/logs"), ("GET", "/screen"), ("GET", "/ui-tree"),
    ("GET", "/schedules"), ("POST", "/action"),
}
OPERATOR_RELAY_PREFIX = (("POST", "/projects/", ("/run", "/stop")), ("GET", "/projects/", ("/files", "/config")))


def _live_view(d: Device, conn: Conn | None) -> dict[str, Any]:
    st = conn.status if conn else (d.status or {})
    return {
        "id": d.id, "device_id": d.device_id, "app": d.app,
        "model": d.model, "brand": d.brand,
        "group": d.group_override or (conn.reported_group if conn else d.reported_group),
        "reported_group": conn.reported_group if conn else d.reported_group,
        "group_override": d.group_override, "note": d.note,
        "online": conn is not None,
        "running": bool(st.get("running")) if conn else False,
        "project": st.get("project") if conn else None,
        "channel": st.get("channel"), "version": st.get("version"),
        "sdk": st.get("sdk"), "release": st.get("release"),
        "width": st.get("width"), "height": st.get("height"),
        "data": conn.data if conn else (d.data or {}), "remote": conn.remote if conn else d.remote,
        "first_seen": d.first_seen, "last_seen": int(conn.seen) if conn else d.last_seen,
        "connected_at": int(conn.connected) if conn else None,
        "last_run": d.last_run,
    }


# ---------------------------------------------------------------- list / edit

@router.get("/devices")
def list_devices(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session),
                 q: str = Query("", max_length=200), group: str = "", app: str = "", online: bool | None = None,
                 page: int = 1, page_size: int = 50):
    hub = ctx(request).hub
    live = dict(hub.conns)
    stmt = select(Device)
    if q:
        like = like_contains(q)
        stmt = stmt.where(or_(Device.id.like(like, escape="\\"), Device.model.like(like, escape="\\"),
                              Device.brand.like(like, escape="\\"), Device.note.like(like, escape="\\")))
    if app:
        stmt = stmt.where(Device.app == app)
    if online is True:
        stmt = stmt.where(Device.id.in_(values_in(live)))
    elif online is False:
        stmt = stmt.where(Device.id.not_in(values_in(live)))
    if group:
        stmt = stmt.where(or_(Device.group_override == group,
                              (Device.group_override == "") & (Device.reported_group == group)))
    total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    off, size = paginate(page, page_size)
    rows = s.scalars(stmt.order_by(Device.last_seen.desc()).offset(off).limit(size))
    return {"items": [_live_view(d, live.get(d.id)) for d in rows], "total": total}


@router.get("/groups")
def list_groups(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    hub = ctx(request).hub
    counts: dict[str, dict[str, int]] = {}
    # Three narrow columns, not whole rows: status / data / last_run JSON are the bulk of the table.
    for dev_id, override, reported in s.execute(select(Device.id, Device.group_override, Device.reported_group)):
        conn = hub.conns.get(dev_id)
        g = override or (conn.reported_group if conn else reported)
        if not g:
            continue
        c = counts.setdefault(g, {"total": 0, "online": 0})
        c["total"] += 1
        c["online"] += 1 if conn else 0
    return {"items": [{"name": g, **c} for g, c in sorted(counts.items())]}


@router.get("/apps")
def list_apps(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    return {"items": [a for a in s.scalars(select(Device.app).distinct().order_by(Device.app)) if a]}


@router.get("/devices/{dev_id}")
def get_device(dev_id: str, request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    d = s.get(Device, dev_id)
    if d is None:
        raise HTTPException(404, "设备不存在")
    conn = ctx(request).hub.conns.get(dev_id)
    out = _live_view(d, conn)
    out["status"] = conn.status if conn else d.status
    return out


# ---------------------------------------------------------------- 运行日志 history

def _log_query(dev_id: str, since_ts: int, until_ts: int, q: str, stream: str):
    stmt = select(DeviceLog).where(DeviceLog.device == dev_id)
    if since_ts:
        stmt = stmt.where(DeviceLog.ts >= since_ts * 1000)
    if until_ts:
        stmt = stmt.where(DeviceLog.ts < until_ts * 1000)
    if stream:
        stmt = stmt.where(DeviceLog.stream == stream)
    if q:
        stmt = stmt.where(DeviceLog.line.like(like_contains(q), escape="\\"))
    return stmt


@router.get("/devices/{dev_id}/logs")
def device_logs(dev_id: str, p: Principal = Depends(viewer), s: Session = Depends(db_session),
                since_ts: int = 0, until_ts: int = 0, q: str = Query("", max_length=200),
                stream: Literal["", "stdout", "stderr", "system"] = "",
                before: int = 0, after: int = 0, limit: int = Query(500, ge=1, le=2000)):
    """Stored 运行日志 lines (works while the device is offline). Times are epoch seconds.

    Default: the newest `limit` lines. `before=<id>` pages back to older lines, `after=<id>`
    polls for lines that arrived since. Items are always oldest first.
    """
    stmt = _log_query(dev_id, since_ts, until_ts, q, stream)
    more = False
    if after:
        rows = list(s.scalars(stmt.where(DeviceLog.id > after).order_by(DeviceLog.id).limit(limit)))
    else:
        if before:
            stmt = stmt.where(DeviceLog.id < before)
        rows = list(s.scalars(stmt.order_by(DeviceLog.id.desc()).limit(limit + 1)))
        more = len(rows) > limit
        rows = rows[:limit][::-1]
    items = [{"id": r.id, "seq": r.seq, "ts": r.ts, "stream": r.stream, "line": r.line} for r in rows]
    return {"items": items, "more": more}


@router.get("/devices/{dev_id}/logs/export")
def export_device_logs(dev_id: str, request: Request, p: Principal = Depends(viewer),
                       s: Session = Depends(db_session), since_ts: int = 0, until_ts: int = 0,
                       q: str = Query("", max_length=200), stream: Literal["", "stdout", "stderr", "system"] = ""):
    """Plain-text download, at most the newest 100 000 matching lines, oldest first.

    Streamed in chunks from its own session (the request's one is closed by then), so memory stays
    flat however many lines match.
    """
    newest = _log_query(dev_id, since_ts, until_ts, q, stream).order_by(DeviceLog.id.desc()).limit(EXPORT_MAX)
    count = s.scalar(select(func.count()).select_from(newest.subquery())) or 0
    name = "logs-%s-%s.txt" % (dev_id.replace("@", "_"), time.strftime("%Y%m%d-%H%M%S"))
    record(request, s, p, "device.logs_export", dev_id, {"lines": count})
    s.commit()
    ids = newest.with_only_columns(DeviceLog.id).subquery()
    rows = (select(DeviceLog.ts, DeviceLog.stream, DeviceLog.line).where(DeviceLog.id.in_(select(ids.c.id)))
            .order_by(DeviceLog.id).execution_options(yield_per=EXPORT_CHUNK))
    db = ctx(request).db

    def body() -> Iterator[bytes]:
        with db.session() as rs:
            for part in rs.execute(rows).partitions():
                yield "".join("%s [%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts / 1000)),
                                                st, line.rstrip("\n")) for ts, st, line in part).encode()
        if not count:
            yield b"\n"  # same as before for an empty export

    return StreamingResponse(body(), media_type="text/plain; charset=utf-8",
                             headers={"Content-Disposition": "attachment; filename=\"%s\"" % name})


class DevicePatch(BaseModel):
    group_override: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=255)


@router.patch("/devices/{dev_id}")
def update_device(dev_id: str, body: DevicePatch, request: Request, p: Principal = Depends(operator),
                  s: Session = Depends(db_session)):
    d = s.get(Device, dev_id)
    if d is None:
        raise HTTPException(404, "设备不存在")
    detail = body.model_dump(exclude_none=True)
    if body.group_override is not None:
        d.group_override = body.group_override.strip()
    if body.note is not None:
        d.note = body.note.strip()
    record(request, s, p, "device.update", dev_id, detail)
    s.commit()
    return _live_view(d, ctx(request).hub.conns.get(dev_id))


class BatchGroup(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=5000)
    group_override: str = Field(max_length=64)


@router.post("/devices/batch-group")
def batch_group(body: BatchGroup, request: Request, p: Principal = Depends(operator),
                s: Session = Depends(db_session)):
    n = 0
    for d in s.scalars(select(Device).where(Device.id.in_(body.ids))):
        d.group_override = body.group_override.strip()
        n += 1
    record(request, s, p, "device.group", "%d 台" % n, {"group": body.group_override, "ids": body.ids[:50]})
    s.commit()
    return {"updated": n}


@router.delete("/devices/{dev_id}")
def delete_device(dev_id: str, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    if dev_id in ctx(request).hub.conns:
        raise HTTPException(409, "设备在线，不能删除")
    d = s.get(Device, dev_id)
    if d is None:
        raise HTTPException(404, "设备不存在")
    s.delete(d)
    s.execute(delete(DeviceLog).where(DeviceLog.device == dev_id))
    record(request, s, p, "device.delete", dev_id)
    s.commit()
    return {"ok": True}


# ---------------------------------------------------------------- commands

class CommandIn(BaseModel):
    target: str = Field(default="all", max_length=100000)
    command: dict[str, Any]
    timeout: float = Field(default=20, ge=1, le=120)


@router.post("/command")
async def send_command(body: CommandIn, request: Request, p: Principal = Depends(operator)):
    c = ctx(request)
    path = str(body.command.get("path") or "")
    if not path:
        raise HTTPException(400, "command 需要 path")
    results = await c.hub.command(body.target, body.command, body.timeout)
    ok = sum(1 for r in results.values() if r.get("code") == 1)

    def _audit():
        with c.db.session() as s:
            cmd = {k: v for k, v in body.command.items() if k != "card"}  # never log 卡密 codes
            record(request, s, p, "device.command", body.target[:255],
                   {"command": cmd, "devices": len(results), "ok": ok})
            s.commit()

    await run_in_threadpool(_audit)
    return {"results": results, "devices": len(results), "ok": ok}


class RelayIn(BaseModel):
    method: str = Field(default="GET", pattern=r"^(GET|POST|PUT|DELETE)$")
    path: str = Field(default="/status", max_length=1024, pattern=r"^/")
    query: dict[str, Any] | None = None
    body: str | None = None
    body_b64: str | None = None
    timeout: float = Field(default=30, ge=1, le=300)


def _relay_allowed(p: Principal, method: str, path: str) -> bool:
    if p.at_least("admin"):
        return True
    if (method, path) in OPERATOR_RELAY:
        return True
    # Exactly /projects/<name>/<action>: a bare "/projects/run" would hit the device's create-project route.
    for m, pre, sfxs in OPERATOR_RELAY_PREFIX:
        if method != m or not path.startswith(pre):
            continue
        name, _, action = path[len(pre):].partition("/")
        if name and "/" + action in sfxs:
            return True
    return False


@router.post("/devices/{dev_id}/http")
async def relay_http(dev_id: str, body: RelayIn, request: Request, p: Principal = Depends(operator)):
    c = ctx(request)
    if not _relay_allowed(p, body.method, body.path.split("?")[0]):
        raise HTTPException(403, "这个设备接口需要管理员权限")
    conn = c.hub.conns.get(dev_id)
    if conn is None:
        raise HTTPException(404, "设备离线")
    try:
        raw = base64.b64decode(body.body_b64, validate=True) if body.body_b64 else (body.body or "").encode("utf-8")
    except (binascii.Error, ValueError):
        raise HTTPException(400, "body_b64 不是有效的 base64") from None
    try:
        reply = await c.hub.relay(conn, body.method, body.path, body.query, raw, body.timeout)
    except asyncio.TimeoutError:
        raise HTTPException(504, "设备响应超时") from None
    except (RuntimeError, OSError, WebSocketDisconnect):  # socket closed while sending
        raise HTTPException(502, "设备断开") from None
    if body.method != "GET":
        def _audit():
            with c.db.session() as s:
                record(request, s, p, "device.http", dev_id, {"method": body.method, "path": body.path})
                s.commit()

        await run_in_threadpool(_audit)
    if reply.get("code") == -1 and "status" not in reply:
        raise HTTPException(502, str(reply.get("msg") or "设备断开"))
    try:
        data = base64.b64decode(reply.get("body") or "")
        status = int(reply.get("status", 200))
    except (binascii.Error, TypeError, ValueError):
        raise HTTPException(502, "设备返回的数据无法解析") from None
    if not 100 <= status <= 599:
        raise HTTPException(502, "设备返回的数据无法解析")
    mime = str(reply.get("mime") or "application/octet-stream").split(";")[0]
    return Response(content=data, status_code=status, media_type=mime,
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


# ---------------------------------------------------------------- device keys

class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    # Optional fixed value, e.g. the --token of the old server so existing devices keep working.
    value: str | None = Field(default=None, min_length=16, max_length=256)


def _key_out(k: DeviceKey, online: int = 0) -> dict[str, Any]:
    return {"id": k.id, "name": k.name, "hint": k.hint, "created_at": k.created_at, "created_by": k.created_by,
            "revoked": k.revoked, "last_used_at": k.last_used_at, "online": online}


@router.get("/device-keys")
def list_keys(request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    hub = ctx(request).hub
    online: dict[int, int] = {}
    for conn in hub.conns.values():
        if conn.key_id is not None:
            online[conn.key_id] = online.get(conn.key_id, 0) + 1
    return {"items": [_key_out(k, online.get(k.id, 0)) for k in s.scalars(select(DeviceKey).order_by(DeviceKey.id))]}


@router.post("/device-keys")
def create_key(body: KeyIn, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    value = body.value or new_secret("xsd_")
    h = token_hash(value)
    if s.scalar(select(DeviceKey).where(DeviceKey.token_hash == h)):
        raise HTTPException(409, "这个密钥已存在")
    k = DeviceKey(name=body.name, token_hash=h, hint=value[:4] + "…" + value[-4:], created_by=p.username)
    s.add(k)
    record(request, s, p, "device_key.create", body.name, {"imported": bool(body.value)})
    s.commit()
    return {**_key_out(k), "token": value}


@router.post("/device-keys/{key_id}/revoke")
async def revoke_key(key_id: int, request: Request, p: Principal = Depends(admin)):
    c = ctx(request)

    def _revoke():
        with c.db.session() as s:
            k = s.get(DeviceKey, key_id)
            if k is None:
                return False
            k.revoked = True
            record(request, s, p, "device_key.revoke", k.name)
            s.commit()
            return True

    if not await run_in_threadpool(_revoke):
        raise HTTPException(404, "密钥不存在")
    kicked = await c.hub.disconnect_key(key_id)
    return {"ok": True, "disconnected": kicked}


@router.delete("/device-keys/{key_id}")
def delete_key(key_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    k = s.get(DeviceKey, key_id)
    if k is None:
        raise HTTPException(404, "密钥不存在")
    if not k.revoked:
        raise HTTPException(400, "先停用再删除")
    s.delete(k)
    record(request, s, p, "device_key.delete", k.name)
    s.commit()
    return {"ok": True}


# ---------------------------------------------------------------- device socket

def _check_device_key(c, token: str) -> int | None:
    if not token:
        return None
    with c.db.session() as s:
        k = s.scalar(select(DeviceKey).where(DeviceKey.token_hash == token_hash(token), DeviceKey.revoked.is_(False)))
        if k is None:
            return None
        if not k.last_used_at or time.time() - k.last_used_at > 300:
            k.last_used_at = int(time.time())
            s.commit()
        return k.id


@ws_router.websocket("/ws")
async def device_socket(ws: WebSocket):
    c = ws.app.state.ctx
    token = ws.query_params.get("token", "")
    auth = ws.headers.get("authorization", "")
    if not token and auth[:7].lower() == "bearer ":
        token = auth[7:].strip()
    key_id = await run_in_threadpool(_check_device_key, c, token)
    if key_id is None:
        await ws.close(code=4401, reason="unauthorized")
        return
    await ws.accept()
    conn: Conn | None = None
    remote = ws.client.host if ws.client else ""
    try:
        while True:
            text = await ws.receive_text()
            try:
                data = json.loads(text)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            if conn is None:
                if data.get("type") != "hello":
                    continue
                conn = Conn(ws, data, remote, key_id)
                await c.hub.attach(conn)
                continue
            await c.hub.on_frame(conn, data)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if conn is not None:
            await c.hub.detach(conn)
