"""Live device connections (云控 WebSocket), command routing, HTTP relay and 定时任务."""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import itertools
import json
import logging
import time
from collections import deque
from typing import Any

from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocket

from .audit import audit
from .db import Database
from .models import Device, DeviceLog, Task

log = logging.getLogger("xscript.hub")

XSCRIPT_APP = "com.xscript.app"
LOG_BATCH_MAX = 500      # lines per "logs" frame (the app sends at most 500)
LOG_LINE_MAX = 4000      # characters kept per line
LOG_STREAMS = {"stdout", "stderr", "system"}


def device_key(device_id: str, app: str) -> str:
    """Several apps on one phone (XScript and packaged apps) share an ANDROID_ID."""
    return device_id if app in ("", XSCRIPT_APP) else "%s@%s" % (device_id, app)


class Conn:
    def __init__(self, ws: WebSocket, hello: dict[str, Any], remote: str, key_id: int | None):
        self.ws = ws
        self.device_id = str(hello.get("device_id") or ("anon-%x" % id(ws)))[:128]
        self.app = str(hello.get("app") or "")[:128]
        self.id = device_key(self.device_id, self.app)
        self.reported_group = str(hello.get("group") or "")[:64]
        dev = hello.get("device")
        self.status: dict[str, Any] = dev if isinstance(dev, dict) else {}
        self.remote = remote
        self.key_id = key_id
        self.connected = time.time()
        self.seen = time.time()
        self.pending: dict[str, asyncio.Future] = {}
        self._send_lock = asyncio.Lock()
        self.log_cursor_sent = False  # 运行日志 upload was started on this connection

    async def send(self, frame: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.ws.send_text(json.dumps(frame, ensure_ascii=False))

    async def close(self) -> None:
        try:
            await self.ws.close()
        except Exception:  # already closed
            pass

    def fail_pending(self, msg: str) -> None:
        for fut in self.pending.values():
            if not fut.done():
                fut.set_result({"code": -1, "msg": msg})


class Hub:
    def __init__(self, db: Database, alerts=None):
        self.db = db
        self.alerts = alerts
        self.conns: dict[str, Conn] = {}
        self.seq = itertools.count(1)
        self.events: deque[dict[str, Any]] = deque(maxlen=200)
        # Devices that went offline and have not been alerted yet: id → disconnect time.
        self.gone: dict[str, float] = {}
        self.alerted_offline: set[str] = set()
        self.offline_minutes: float = 5
        # 运行日志 history kept on the server; 0 = devices are not asked to upload.
        self.log_days: float = 7
        self.log_lines_saved = 0

    def note(self, text: str) -> None:
        self.events.append({"time": int(time.time()), "text": text})

    # ------------------------------------------------------------ persistence

    def _save(self, conn: Conn, hello: bool = False) -> None:
        st = conn.status
        with self.db.session() as s:
            row = s.get(Device, conn.id)
            if row is None:
                row = Device(id=conn.id, device_id=conn.device_id, app=conn.app, first_seen=int(conn.connected))
                s.add(row)
            row.model = str(st.get("model") or row.model or "")[:128]
            row.brand = str(st.get("brand") or row.brand or "")[:64]
            row.reported_group = conn.reported_group
            row.status = st
            row.last_seen = int(conn.seen)
            if hello:
                row.remote = conn.remote
                row.key_id = conn.key_id
                # Script data belongs to the current connection.
                row.data = {}
            s.commit()

    def _merge_data(self, conn: Conn, payload: Any) -> None:
        """cloud.send() data: dict keys overwrite, anything else is stored as "value"."""
        with self.db.session() as s:
            row = s.get(Device, conn.id)
            if row is None:
                return
            merged = dict(row.data or {})
            if isinstance(payload, dict):
                merged.update(payload)
            else:
                merged["value"] = payload
            row.data = merged
            row.last_seen = int(conn.seen)
            s.commit()

    # ------------------------------------------------------------ 运行日志 history

    def _last_log_seq(self, dev_id: str) -> int:
        """seq of the newest stored line (by arrival, not max: the app's seq restarts after a data wipe)."""
        with self.db.session() as s:
            seq = s.scalar(select(DeviceLog.seq).where(DeviceLog.device == dev_id)
                           .order_by(DeviceLog.id.desc()).limit(1))
        return int(seq or 0)

    async def start_logs(self, conn: Conn) -> None:
        """Tell the device which lines the server already has; it then uploads newer ones."""
        if not self.log_days or conn.log_cursor_sent:
            return
        seq = await run_in_threadpool(self._last_log_seq, conn.id)
        try:
            await conn.send({"type": "log_cursor", "seq": seq})
            conn.log_cursor_sent = True
        except Exception:  # socket closed meanwhile
            pass

    async def set_log_days(self, days: float) -> None:
        """Settings change: devices already online start uploading when storage is turned on."""
        self.log_days = days
        if days:
            for conn in list(self.conns.values()):
                await self.start_logs(conn)

    def _save_logs(self, dev_id: str, entries: list[Any]) -> int:
        rows = []
        for e in entries[:LOG_BATCH_MAX]:
            if not isinstance(e, dict):
                continue
            try:
                seq, ts = int(e.get("seq") or 0), int(e.get("ts") or 0)
            except (TypeError, ValueError):
                continue
            stream = str(e.get("stream") or "stdout")
            rows.append({"device": dev_id, "seq": seq, "ts": ts or int(time.time() * 1000),
                         "stream": stream if stream in LOG_STREAMS else "stdout",
                         "line": str(e.get("line") or "")[:LOG_LINE_MAX]})
        if rows:
            with self.db.session() as s:
                s.execute(DeviceLog.__table__.insert(), rows)
                s.commit()
        return len(rows)

    # ------------------------------------------------------------ connection lifecycle

    def _alert(self, event: str, subject: str, text: str) -> None:
        if self.alerts is not None:
            self.alerts.emit(event, subject, text)

    def _label(self, conn: Conn) -> str:
        st = conn.status
        name = " ".join(x for x in (st.get("brand"), st.get("model")) if x) or conn.id
        return "%s（%s）" % (name, conn.id) if name != conn.id else conn.id

    def check_offline(self, now: float | None = None) -> None:
        """Alert for devices offline longer than offline_minutes (brief reconnects stay quiet)."""
        if not self.offline_minutes:
            self.gone.clear()
            return
        now = now or time.time()
        for dev_id, since in list(self.gone.items()):
            if dev_id in self.conns:
                self.gone.pop(dev_id, None)
            elif now - since >= self.offline_minutes * 60:
                self.gone.pop(dev_id, None)
                self.alerted_offline.add(dev_id)
                self._alert("device_offline", dev_id, "设备 %s 已离线 %d 分钟" % (dev_id, (now - since) // 60))

    async def attach(self, conn: Conn) -> None:
        old = self.conns.get(conn.id)
        self.conns[conn.id] = conn
        if old is not None and old is not conn:
            old.fail_pending("replaced by a new connection")
            await old.close()
        await run_in_threadpool(self._save, conn, True)
        await self.start_logs(conn)
        self.note("设备 %s 上线" % conn.id)
        self.gone.pop(conn.id, None)
        if conn.id in self.alerted_offline:
            self.alerted_offline.discard(conn.id)
            self._alert("device_online", conn.id, "设备 %s 已恢复在线" % self._label(conn))

    def _save_run_end(self, conn: Conn, data: dict[str, Any]) -> dict[str, Any]:
        tail = data.get("tail")
        tail = [{"stream": str(t.get("stream", ""))[:8], "line": str(t.get("line", ""))[:500]}
                for t in tail[-40:] if isinstance(t, dict)] if isinstance(tail, list) else []
        run = {"project": str(data.get("project") or "")[:64], "exit": str(data.get("exit") or "")[:16],
               "crashed": bool(data.get("crashed")), "time": int(data.get("time") or time.time()), "tail": tail}
        with self.db.session() as s:
            row = s.get(Device, conn.id)
            if row is not None:
                row.last_run = run
                s.commit()
        return run

    async def detach(self, conn: Conn) -> None:
        if self.conns.get(conn.id) is conn:
            del self.conns[conn.id]
            self.note("设备 %s 离线" % conn.id)
            self.gone[conn.id] = time.time()
            try:
                await run_in_threadpool(self._save, conn)
            except Exception:  # pragma: no cover - db closed during shutdown
                log.exception("saving %s on disconnect", conn.id)
        conn.fail_pending("disconnected")

    async def on_frame(self, conn: Conn, data: dict[str, Any]) -> None:
        conn.seen = time.time()
        t = data.get("type")
        if t == "status":
            dev = data.get("device")
            if isinstance(dev, dict):
                conn.status = dev
            conn.reported_group = str(data.get("group", conn.reported_group) or "")[:64]
            await run_in_threadpool(self._save, conn)
        elif t == "data":
            await run_in_threadpool(self._merge_data, conn, data.get("data"))
        elif t == "logs":
            entries = data.get("entries")
            if self.log_days and isinstance(entries, list) and entries:
                try:
                    self.log_lines_saved += await run_in_threadpool(self._save_logs, conn.id, entries)
                except Exception:  # never drop the connection over a bad batch
                    log.exception("saving logs from %s", conn.id)
        elif t == "run_end":
            run = await run_in_threadpool(self._save_run_end, conn, data)
            if run["crashed"]:
                last = next((x["line"] for x in reversed(run["tail"]) if x["stream"] == "stderr" and x["line"]), "")
                self.note("设备 %s 的 %s 异常退出（%s）" % (conn.id, run["project"], run["exit"]))
                self._alert("script_crash", "%s/%s" % (conn.id, run["project"]),
                            "%s 上的 %s 异常退出，退出码 %s\n%s" % (self._label(conn), run["project"], run["exit"],
                                                                 last[:300]))
        elif t == "response" or "path" in data:
            key = data.get("id", "") if t == "response" else data.get("seq", "")
            fut = conn.pending.get(str(key))
            if fut is not None and not fut.done():
                fut.set_result(data)

    async def disconnect_key(self, key_id: int) -> int:
        victims = [c for c in self.conns.values() if c.key_id == key_id]
        for c in victims:
            await c.close()
        return len(victims)

    # ------------------------------------------------------------ targeting and commands

    def _overrides(self, ids: list[str]) -> dict[str, str]:
        if not ids:
            return {}
        with self.db.session() as s:
            rows = s.execute(select(Device.id, Device.group_override).where(Device.id.in_(ids))).all()
        return {r[0]: r[1] for r in rows if r[1]}

    async def select(self, target: str) -> list[Conn]:
        target = (target or "all").strip()
        conns = list(self.conns.values())
        if target == "all":
            return conns
        if target.startswith("group:"):
            g = target[6:]
            over = await run_in_threadpool(self._overrides, [c.id for c in conns])
            return [c for c in conns if (over.get(c.id) or c.reported_group) == g]
        if target.startswith("app:"):
            return [c for c in conns if c.app == target[4:]]
        ids = {t.strip() for t in target.split(",") if t.strip()}
        return [c for c in conns if c.id in ids]

    async def call(self, conn: Conn, frame: dict[str, Any], timeout: float = 20.0) -> dict[str, Any]:
        """Send one AScript-style command and wait for the reply matched by "seq"."""
        cid = "c%d" % next(self.seq)
        frame = dict(frame, seq=cid)
        fut = asyncio.get_running_loop().create_future()
        conn.pending[cid] = fut
        try:
            await conn.send(frame)
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return {"code": -1, "msg": "timeout", "path": frame.get("path")}
        except Exception as e:  # socket closed
            return {"code": -1, "msg": str(e) or type(e).__name__, "path": frame.get("path")}
        finally:
            conn.pending.pop(cid, None)

    async def command(self, target: str, command: dict[str, Any], timeout: float = 20.0) -> dict[str, dict[str, Any]]:
        if not isinstance(command, dict) or not command.get("path"):
            raise ValueError("command needs a path")
        conns = await self.select(target)
        if command["path"] == "message":
            # Fire-and-forget to running scripts.
            frame = {"type": "message", "data": command.get("data")}
            out: dict[str, dict[str, Any]] = {}
            for c in conns:
                try:
                    await c.send(frame)
                    out[c.id] = {"code": 1, "msg": "sent"}
                except Exception as e:
                    out[c.id] = {"code": -1, "msg": str(e)}
            return out
        results = await asyncio.gather(*(self.call(c, command, timeout) for c in conns))
        self.note("%s → %s（%d 台）" % (command["path"], target, len(conns)))
        return {c.id: r for c, r in zip(conns, results)}

    async def relay(self, conn: Conn, method: str, path: str, query: dict[str, Any] | None = None,
                    body: bytes = b"", timeout: float = 30.0) -> dict[str, Any]:
        """Forward one device HTTP request (protocol/openapi.yaml) over the socket."""
        cid = "r%d" % next(self.seq)
        fut = asyncio.get_running_loop().create_future()
        conn.pending[cid] = fut
        frame = {"type": "request", "id": cid, "method": method.upper(), "path": path,
                 "query": {k: str(v) for k, v in (query or {}).items()},
                 "body": base64.b64encode(body).decode("ascii")}
        try:
            await conn.send(frame)
            return await asyncio.wait_for(fut, timeout)
        finally:
            conn.pending.pop(cid, None)


# ---------------------------------------------------------------- 定时任务

def validate_daily(text: str) -> str:
    try:
        hh, mm = [int(x) for x in text.split(":")]
    except ValueError:
        raise ValueError("daily 必须是 HH:MM") from None
    if not (0 <= hh < 24 and 0 <= mm < 60):
        raise ValueError("daily 必须是 HH:MM")
    return "%02d:%02d" % (hh, mm)


def is_due(daily: str | None, every: float | None, last: float, now: float) -> bool:
    if every:
        return now - last >= float(every) * 60
    if daily:
        hh, mm = [int(x) for x in daily.split(":")]
        at = dt.datetime.fromtimestamp(now).replace(hour=hh, minute=mm, second=0, microsecond=0).timestamp()
        return now >= at > last
    return False


def next_run(daily: str | None, every: float | None, last: float, now: float) -> float | None:
    if every:
        return max(last + float(every) * 60, now)
    if daily:
        hh, mm = [int(x) for x in daily.split(":")]
        at = dt.datetime.fromtimestamp(now).replace(hour=hh, minute=mm, second=0, microsecond=0)
        if at.timestamp() <= last:  # already ran today
            at += dt.timedelta(days=1)
        return max(at.timestamp(), now)
    return None


class Scheduler:
    def __init__(self, hub: Hub, db: Database, interval: float = 15.0):
        self.hub, self.db, self.interval = hub, db, interval
        # Set by the app: async (script_id, target, version_id, run, params) -> deploy result.
        self.deploy = None

    def _claim_due(self, now: float) -> list[tuple[int, str, dict[str, Any]]]:
        with self.db.session() as s:
            due = []
            for t in s.scalars(select(Task).where(Task.enabled.is_(True))):
                if is_due(t.daily, t.every, t.last_run, now):
                    t.last_run = now
                    due.append((t.id, t.target, dict(t.command)))
            s.commit()
            return due

    def _finish(self, task_id: int, result: dict[str, Any], manual_by: str = "") -> str:
        with self.db.session() as s:
            t = s.get(Task, task_id)
            name = (t.name if t else "") or "任务 #%d" % task_id
            if t is not None:
                t.last_result = result
            audit(s, manual_by or "scheduler", "task.run", str(task_id), {"result": result})
            s.commit()
        return name

    async def run_task(self, task_id: int, target: str, command: dict[str, Any], by: str = "") -> dict[str, Any]:
        try:
            if command.get("path") == "script_deploy":
                # 定时下发小程序: install a version (default: the published one) and optionally run it.
                if self.deploy is None:
                    raise RuntimeError("小程序下发不可用")
                res = (await self.deploy(int(command.get("script_id") or 0), target, command.get("version_id"),
                                         bool(command.get("run", True)), command.get("param") or {}))["results"]
            else:
                res = await self.hub.command(target, command)
            summary: dict[str, Any] = {"time": int(time.time()), "devices": len(res),
                                       "ok": sum(1 for r in res.values() if r.get("code") == 1),
                                       "results": {k: {"code": v.get("code"), "msg": v.get("msg")} for k, v in res.items()}}
        except Exception as e:  # keep the loop alive
            summary = {"time": int(time.time()), "error": str(e)}
        name = await run_in_threadpool(self._finish, task_id, summary, by)
        failed = summary.get("error") or (summary.get("devices") and summary.get("ok", 0) < summary["devices"])
        if failed:
            text = summary.get("error") or "%d/%d 台设备成功" % (summary["ok"], summary["devices"])
            self.hub._alert("task_failed", name, "定时任务「%s」执行失败：%s" % (name, text))
        return summary

    async def loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            try:
                for task_id, target, command in await run_in_threadpool(self._claim_due, time.time()):
                    await self.run_task(task_id, target, command)
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover
                log.exception("scheduler tick failed")
