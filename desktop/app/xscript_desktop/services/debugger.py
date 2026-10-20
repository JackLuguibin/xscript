"""Breakpoint debugging of a device project: a DAP client over the device's HTTP bridge (/debug/*, docs/DEBUGGING.md).

Ported from ide/vscode-extension/src/dap.ts, but the "editor" here is our own page, so instead of proxying DAP verbatim the
session drives debugpy itself and pushes small, already-resolved snapshots to the UI:

    debug.state   {id, project, state: starting|running|stopped|ended, reason, line, path, frames, error}
    debug.output  {id, category, text}

Handshake (as the device requires): initialize → attach (response arrives only after configurationDone, never awaited) →
`initialized` event → setBreakpoints per file → setExceptionBreakpoints → configurationDone.
Paths: the page speaks project-relative paths ("lib/a.py"); debugpy speaks `remote_root/…`.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from .device_client import DeviceClient, DeviceError

log = logging.getLogger("xscript_desktop.debugger")

Emit = Callable[[str, Any], None]


class DebugError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class DebugSession:
    def __init__(self, device_id: str, client: DeviceClient, project: str, emit: Emit, *, poll_interval: float = 0.1,
                 log_interval: float = 0.4, connect_tries: int = 40, request_timeout: float = 30.0,
                 sleep: Callable[[float], Awaitable[None]] | None = None) -> None:
        self.device_id = device_id
        self.client = client
        self.project = project
        self._emit = emit
        self.poll_interval = poll_interval
        self.log_interval = log_interval
        self.connect_tries = connect_tries
        self.request_timeout = request_timeout
        self._sleep = sleep or asyncio.sleep
        self.remote_root = ""
        self.state = "idle"
        self.thread_id: int | None = None
        self.frames: list[dict[str, Any]] = []
        self.breakpoints: dict[str, list[dict[str, Any]]] = {}
        self._seq = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._cursor = 0
        self._log_since = 0
        self._initialized = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        self._connected = False
        self._ended = False
        self._launched = False  # True once *we* started the script; never stop a script we did not start

    # ---- paths ------------------------------------------------------------------------------------------------------------------

    def to_remote(self, rel: str) -> str:
        return self.remote_root.rstrip("/") + "/" + rel

    def to_rel(self, path: str | None) -> str | None:
        if not path:
            return None
        root = self.remote_root.rstrip("/") + "/"
        p = path.replace("\\", "/")
        return p[len(root):] if p.startswith(root) else None  # None: outside the project (stdlib, runtime)

    # ---- events to the page ----------------------------------------------------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        top = self.frames[0] if self.frames else {}
        return {"id": self.device_id, "project": self.project, "state": self.state, "threadId": self.thread_id,
                "frames": self.frames, "path": top.get("path"), "line": top.get("line"), "reason": getattr(self, "_reason", ""),
                "error": getattr(self, "_error", "")}

    def _set_state(self, state: str, **extra: Any) -> None:
        self.state = state
        for k, v in extra.items():
            setattr(self, "_" + k, v)
        self._emit("debug.state", self.snapshot())

    def _output(self, text: str, category: str = "console") -> None:
        self._emit("debug.output", {"id": self.device_id, "category": category, "text": text if text.endswith("\n") else text + "\n"})

    # ---- DAP plumbing ------------------------------------------------------------------------------------------------------------------

    async def request(self, command: str, arguments: dict[str, Any] | None = None, *, wait: bool = True) -> Any:
        if not self._connected:
            raise DebugError("debug.not_connected", "the debug session is not connected")
        self._seq += 1
        seq = self._seq
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[seq] = fut
        try:
            await self.client.debug_request({"seq": seq, "type": "request", "command": command, "arguments": arguments or {}})
        except DeviceError as e:
            self._pending.pop(seq, None)
            raise DebugError("debug.transport", "device request failed: %s" % e) from e
        if not wait:
            fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)  # never "exception was never retrieved"
            return seq
        try:
            msg = await asyncio.wait_for(fut, self.request_timeout)
        except asyncio.TimeoutError as e:
            raise DebugError("debug.timeout", "debugger did not answer %s" % command) from e
        finally:
            self._pending.pop(seq, None)
        if msg.get("success") is False:
            raise DebugError("debug.failed", msg.get("message") or "%s failed" % command)
        return msg.get("body") or {}

    def _receive(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "response":
            fut = self._pending.pop(msg.get("request_seq"), None)
            if fut is not None and not fut.done():
                fut.set_result(msg)
            return
        if kind != "event":
            return
        ev, body = msg.get("event"), msg.get("body") or {}
        if ev == "initialized":
            self._initialized.set()
        elif ev == "stopped":
            self.thread_id = body.get("threadId") or self.thread_id or 1
            self._spawn(self._on_stopped(body.get("reason") or "pause", body.get("text") or body.get("description") or ""))
        elif ev == "continued":
            if self.state != "ended":
                self.frames = []
                self._set_state("running", reason="")
        elif ev in ("terminated", "exited"):
            self._spawn(self._finish("脚本已结束" if ev == "terminated" else "exit %s" % body.get("exitCode", 0)))
        elif ev == "output":
            # the script's own stdout/stderr already comes through /logs; keep debugpy's own lines (logpoints, warnings).
            # debugpy sends a logpoint as category "stdout" with an empty `source: {}` (seen on the device), so the key's
            # presence marks it, not its value.
            if body.get("category") in ("stdout", "stderr") and "source" not in body and not body.get("line"):
                return
            self._output(str(body.get("output", "")), "console")

    def _spawn(self, coro: Awaitable[Any]) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.append(t)
        t.add_done_callback(lambda x: self._tasks.remove(x) if x in self._tasks else None)

    async def _on_stopped(self, reason: str, text: str) -> None:
        try:
            self.frames = await self.stack()
        except DebugError as e:
            self.frames = []
            self._output("[debug] stackTrace failed: %s" % e.message, "stderr")
        self._set_state("stopped", reason=reason, error=text if reason == "exception" else "")

    async def stack(self) -> list[dict[str, Any]]:
        body = await self.request("stackTrace", {"threadId": self.thread_id or 1, "startFrame": 0, "levels": 50})
        out = []
        for f in body.get("stackFrames") or []:
            src = f.get("source") or {}
            out.append({"id": f.get("id"), "name": f.get("name", ""), "line": f.get("line"), "column": f.get("column"),
                        "path": self.to_rel(src.get("path")), "file": src.get("name") or src.get("path") or ""})
        return out

    async def scopes(self, frame_id: int) -> list[dict[str, Any]]:
        body = await self.request("scopes", {"frameId": frame_id})
        return [{"name": s.get("name", ""), "ref": s.get("variablesReference", 0), "expensive": bool(s.get("expensive"))}
                for s in body.get("scopes") or []]

    async def variables(self, ref: int) -> list[dict[str, Any]]:
        body = await self.request("variables", {"variablesReference": ref})
        return [{"name": v.get("name", ""), "value": v.get("value", ""), "type": v.get("type", ""), "ref": v.get("variablesReference", 0)}
                for v in body.get("variables") or []]

    async def evaluate(self, expression: str, frame_id: int | None, context: str = "repl") -> dict[str, Any]:
        if context not in ("repl", "watch", "hover"):
            raise DebugError("rpc.bad_params", "unknown evaluate context: %s" % context)
        args: dict[str, Any] = {"expression": expression, "context": context}
        if frame_id is not None:
            args["frameId"] = frame_id
        body = await self.request("evaluate", args)
        return {"result": body.get("result", ""), "type": body.get("type", ""), "ref": body.get("variablesReference", 0)}

    async def step(self, command: str) -> None:
        if command not in ("continue", "next", "stepIn", "stepOut", "pause"):
            raise DebugError("rpc.bad_params", "unknown step command: %s" % command)
        if command != "pause" and self.state != "stopped":
            raise DebugError("debug.not_stopped", "the script is not paused")
        await self.request(command, {"threadId": self.thread_id or 1})
        if command != "pause":
            self.frames = []
            self._set_state("running", reason="")

    @staticmethod
    def normalize_breakpoints(items: list[Any]) -> list[dict[str, Any]]:
        """[3, {"line": 5, "condition": "i > 2"}] -> one spec per line (the last one wins), sorted, empty options dropped.

        Options are DAP SourceBreakpoint fields: condition (expression), hitCondition (e.g. "3", ">= 3", "% 2") and
        logMessage (a logpoint: prints instead of pausing; {expr} is interpolated by debugpy)."""
        by_line: dict[int, dict[str, Any]] = {}
        for it in items:
            spec: dict[str, Any] = {"line": it} if isinstance(it, int) else {"line": it["line"]}
            if isinstance(it, dict):
                for k in ("condition", "hitCondition", "logMessage"):
                    v = it.get(k)
                    if isinstance(v, str) and v.strip():
                        spec[k] = v.strip()
            by_line[spec["line"]] = spec
        return [by_line[k] for k in sorted(by_line)]

    async def set_breakpoints(self, rel: str, items: list[Any]) -> list[dict[str, Any]]:
        self.breakpoints[rel] = self.normalize_breakpoints(items)
        specs = self.breakpoints[rel]
        if not self._connected:
            return [{"line": b["line"], "verified": False} for b in specs]
        body = await self.request("setBreakpoints", {"source": {"path": self.to_remote(rel), "name": rel.rsplit("/", 1)[-1]},
                                                     "breakpoints": specs,
                                                     "lines": [b["line"] for b in specs]})
        return [{"line": b.get("line"), "verified": bool(b.get("verified")), "message": b.get("message", "")} for b in body.get("breakpoints") or []]

    # ---- lifecycle ---------------------------------------------------------------------------------------------------------------------

    async def start(self, breakpoints: dict[str, list[Any]]) -> dict[str, Any]:
        self.breakpoints = {k: self.normalize_breakpoints(v) for k, v in breakpoints.items()}
        self._set_state("starting")
        try:
            try:
                self._log_since = int((await self.client.logs(0)).get("next") or 0)
            except DeviceError:
                pass
            started = await self.client.debug_start(self.project)
            dbg = started.get("debug") if isinstance(started, dict) else None
            if started.get("error") or not isinstance(dbg, dict) or not dbg.get("remote_root"):
                why = str(started.get("error") or "device did not return a debug port")
                code = "debug.busy" if started.get("status") == 409 or "running" in why.lower() else "debug.start_failed"
                raise DebugError(code, why)
            self._launched = True
            self.remote_root = str(dbg["remote_root"])
            last: Any = None
            for _ in range(self.connect_tries):
                try:
                    r = await self.client.debug_connect()
                    if not r.get("error"):
                        break
                    last = r.get("error")
                except DeviceError as e:
                    last = e
                await self._sleep(0.25)
            else:
                raise DebugError("debug.connect_failed", "could not connect to the device debugger: %s" % last)
            self._connected = True
            self._spawn(self._poll())
            self._spawn(self._log_loop())
            await self.request("initialize", {"adapterID": "python", "clientID": "xscript-desktop", "clientName": "XScript Desktop",
                                              "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path",
                                              "supportsVariableType": True})
            await self.request("attach", {"justMyCode": True, "name": "XScript", "subProcess": False}, wait=False)
            try:
                await asyncio.wait_for(self._initialized.wait(), 20)
            except asyncio.TimeoutError as e:
                raise DebugError("debug.timeout", "timed out waiting for the debugger to initialise") from e
            for rel, lines in self.breakpoints.items():
                await self.set_breakpoints(rel, lines)
            await self.request("setExceptionBreakpoints", {"filters": ["uncaught"]})
            await self.request("configurationDone")
            if self.state == "starting":
                self._set_state("running", reason="")
            return self.snapshot()
        except DebugError as e:
            await self.stop(terminate=True, quiet=True)
            self._set_state("ended", error=e.message)
            raise

    async def _poll(self) -> None:
        while not self._ended:
            try:
                r = await self.client.debug_messages(self._cursor)
                self._cursor = int(r.get("next", self._cursor))
                for item in r.get("messages") or []:
                    m = item.get("message") if isinstance(item, dict) else None
                    if isinstance(m, dict):
                        self._receive(m)
                if r.get("connected") is False and self._connected and self._initialized.is_set():
                    await self._finish("调试连接已断开" if r.get("error") else "脚本已结束")
                    return
            except DeviceError as e:
                await self._finish("与设备的连接中断: %s" % e)
                return
            await self._sleep(self.poll_interval)

    async def _drain_logs(self) -> None:
        r = await self.client.logs(self._log_since)
        self._log_since = int(r.get("next", self._log_since))
        for e in r.get("entries") or []:
            self._output(str(e.get("line", "")), "stderr" if e.get("stream") == "stderr" else "stdout")

    async def _log_loop(self) -> None:
        while not self._ended:
            try:
                await self._drain_logs()
            except DeviceError:
                pass
            await self._sleep(self.log_interval)

    async def _finish(self, why: str) -> None:
        if self._ended:
            return
        self._ended = True
        try:
            await self._drain_logs()
        except DeviceError:
            pass
        self._output("[debug] %s" % why)
        self._connected = False
        try:
            await self.client.debug_close()
        except DeviceError:
            pass
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self.frames = []
        self._set_state("ended", reason=why)

    async def stop(self, terminate: bool = True, quiet: bool = False) -> None:
        """Detach properly (a TCP close alone leaves debugpy's threads suspended), close the bridge, optionally stop the script."""
        if self._connected and not self._ended:
            try:
                await asyncio.wait_for(self.request("disconnect", {"terminateDebuggee": False}), 1.5)
            except (DebugError, asyncio.TimeoutError):
                pass
        was_ended = self._ended
        self._ended = True
        self._connected = False
        try:
            await self.client.debug_close()
        except DeviceError:
            pass
        if terminate and self._launched:
            try:
                st = await self.client.status()
                if st.get("running") and (not st.get("project") or st.get("project") == self.project):
                    await self.client.stop_project(self.project)  # never stop someone else's script
            except DeviceError:
                pass
        for t in list(self._tasks):
            if t is not asyncio.current_task():
                t.cancel()
        if not quiet and not was_ended:
            self.frames = []
            self._set_state("ended", reason="已停止" if terminate else "已分离")
