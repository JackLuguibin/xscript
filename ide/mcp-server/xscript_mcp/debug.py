"""Breakpoint debugging for MCP clients over the device's /debug/* HTTP bridge to debugpy.

Same handshake as the VS Code adapter (docs/DEBUGGING.md): POST /projects/{name}/debug, poll
/debug/connect, initialize, attach (its response only arrives after configurationDone), wait for the
`initialized` event, setBreakpoints, configurationDone. Each MCP tool call then blocks until the program
stops, ends, or the wait runs out, and returns a compact snapshot (location, stack, locals).
"""

from __future__ import annotations

import time
from typing import Any, Callable

from .client import DeviceClient, _check


class DebugError(RuntimeError):
    pass


class DebugSession:
    def __init__(self, client: DeviceClient, *, sleep: Callable[[float], None] = time.sleep,
                 poll_interval: float = 0.2, request_timeout: float = 15.0):
        self.client = client
        self.sleep = sleep
        self.poll_interval = poll_interval
        self.request_timeout = request_timeout
        self.project = ""
        self.remote_root = ""
        self.seq = 0
        self.cursor = 0
        self.responses: dict[int, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.output: list[str] = []
        self.state = "idle"  # idle | running | stopped | terminated
        self.thread_id: int | None = None
        self.stop_reason = ""
        self.breakpoints: dict[str, list[int]] = {}

    # ------------------------------------------------------------------ transport
    def _http(self, method: str, path: str, **kw) -> dict[str, Any]:
        with self.client._client() as c:
            r = c.request(method, self.client._url(path), **kw)
            if r.status_code == 409 and path != "/debug/request":
                body = r.json() if r.content else {}
                raise DebugError(str(body.get("error") or "device busy (409)"))
            _check(r)
            return r.json() if r.content else {}

    def _send(self, command: str, arguments: dict[str, Any] | None = None) -> int:
        self.seq += 1
        frame = {"seq": self.seq, "type": "request", "command": command, "arguments": arguments or {}}
        with self.client._client() as c:
            r = c.post(self.client._url("/debug/request"), json=frame)
            if r.status_code == 409:
                self.state = "terminated"
                raise DebugError("debugger disconnected")
            _check(r)
        return self.seq

    def _pump(self) -> bool:
        """Fetch new DAP messages. Returns False once the transport reports it is gone."""
        body = self._http("GET", "/debug/messages", params={"since": self.cursor})
        for item in body.get("messages") or []:
            msg = item.get("message") or {}
            self._handle(msg)
        self.cursor = int(body.get("next", self.cursor))
        if body.get("connected") is False and self.state not in ("idle",):
            self.state = "terminated"
            return False
        return True

    def _handle(self, msg: dict[str, Any]) -> None:
        if msg.get("type") == "response":
            self.responses[int(msg.get("request_seq", -1))] = msg
            return
        if msg.get("type") != "event":
            return
        ev, body = msg.get("event"), msg.get("body") or {}
        self.events.append(msg)
        if ev == "stopped":
            self.state = "stopped"
            self.stop_reason = str(body.get("reason") or "")
            if body.get("threadId") is not None:
                self.thread_id = int(body["threadId"])
        elif ev == "continued":
            self.state = "running"
        elif ev in ("terminated", "exited"):
            self.state = "terminated"
        elif ev == "output":
            text = str(body.get("output") or "")
            if text and body.get("category") != "telemetry":
                self.output.append(text)
                del self.output[:-200]

    def _request(self, command: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        seq = self._send(command, arguments)
        deadline = time.monotonic() + self.request_timeout
        while seq not in self.responses:
            if time.monotonic() > deadline:
                raise DebugError("debugger did not answer " + command)
            if not self._pump() and seq not in self.responses:
                raise DebugError("debugger disconnected while waiting for " + command)
            if seq not in self.responses:
                self.sleep(self.poll_interval)
        resp = self.responses.pop(seq)
        if not resp.get("success", False):
            raise DebugError("%s failed: %s" % (command, resp.get("message") or "unknown error"))
        return resp.get("body") or {}

    def _wait_event(self, name: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            if any(e.get("event") == name for e in self.events):
                return True
            if time.monotonic() > deadline or not self._pump():
                return any(e.get("event") == name for e in self.events)
            self.sleep(self.poll_interval)

    def _remote(self, path: str) -> str:
        path = path.replace("\\", "/").lstrip("/")
        return self.remote_root.rstrip("/") + "/" + path

    def _local(self, path: str) -> str:
        root = self.remote_root.rstrip("/") + "/"
        return path[len(root):] if path.startswith(root) else path

    # ------------------------------------------------------------------ session
    def start(self, project: str, breakpoints: dict[str, list[int]] | None = None, connect_tries: int = 120,
              wait_seconds: float = 30.0) -> dict[str, Any]:
        if self.state in ("running", "stopped"):
            raise DebugError("a debug session is already active for %s; call debug_stop first" % self.project)
        self.__init__(self.client, sleep=self.sleep, poll_interval=self.poll_interval,
                      request_timeout=self.request_timeout)
        self.project = project
        started = self._http("POST", "/projects/%s/debug" % self.client._p(project))
        info = started.get("debug") or {}
        if not info:
            raise DebugError(str(started.get("error") or "device did not return a debug port"))
        self.remote_root = str(info.get("remote_root") or "")
        last = ""
        for _ in range(connect_tries):
            try:
                self._http("POST", "/debug/connect")
                break
            except Exception as e:  # debugpy not listening yet
                last = str(e)
                self.sleep(0.25)
        else:
            raise DebugError("could not connect to the device debugger: " + last)
        self.cursor = 0
        self.state = "running"
        self._request("initialize", {"adapterID": "python", "clientID": "xscript-mcp", "clientName": "XScript MCP",
                                     "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path"})
        self._send("attach", {"justMyCode": True, "name": "XScript", "subProcess": False})
        if not self._wait_event("initialized", 20.0):
            raise DebugError("timed out waiting for the debugger to initialise")
        for f, lines in (breakpoints or {}).items():
            self.set_breakpoints(f, lines)
        self._request("configurationDone")
        return self.wait(wait_seconds)

    def set_breakpoints(self, file: str, lines: list[int]) -> list[dict[str, Any]]:
        body = self._request("setBreakpoints", {"source": {"path": self._remote(file)},
                                                "breakpoints": [{"line": int(n)} for n in lines]})
        self.breakpoints[file] = [int(n) for n in lines]
        return [{"line": b.get("line"), "verified": bool(b.get("verified")), "message": b.get("message", "")}
                for b in body.get("breakpoints") or []]

    def wait(self, wait_seconds: float = 30.0) -> dict[str, Any]:
        deadline = time.monotonic() + max(0.0, wait_seconds)
        while self.state == "running" and time.monotonic() < deadline:
            if not self._pump():
                break
            if self.state == "running":
                self.sleep(self.poll_interval)
        return self.snapshot()

    def step(self, action: str, wait_seconds: float = 30.0) -> dict[str, Any]:
        commands = {"continue": "continue", "next": "next", "step_in": "stepIn", "step_out": "stepOut"}
        if action == "pause":
            self._request("pause", {"threadId": self.thread_id or 0})
            return self.wait(wait_seconds)
        if action not in commands:
            raise DebugError("action must be one of continue, next, step_in, step_out, pause")
        if self.state != "stopped" or self.thread_id is None:
            raise DebugError("the program is not stopped (state: %s)" % self.state)
        self.state = "running"  # before the request: its stopped event may arrive while we wait for the reply
        self._request(commands[action], {"threadId": self.thread_id})
        return self.wait(wait_seconds)

    def evaluate(self, expression: str, frame_id: int | None = None) -> dict[str, Any]:
        if self.state != "stopped":
            raise DebugError("evaluate needs a stopped program (state: %s)" % self.state)
        if frame_id is None:
            frames = self._frames(1)
            frame_id = frames[0]["id"] if frames else None
        body = self._request("evaluate", {"expression": expression, "frameId": frame_id, "context": "repl"})
        return {"result": body.get("result"), "type": body.get("type", "")}

    def stop(self, terminate: bool = True) -> dict[str, Any]:
        was = self.project
        if self.state in ("running", "stopped"):
            try:
                self._request("disconnect", {"terminateDebuggee": bool(terminate)})
            except DebugError:
                pass
        if terminate and was:
            try:
                self.client.stop_project(was)
            except Exception:
                pass
        try:
            self._http("DELETE", "/debug")
        except Exception:
            pass
        self.state = "idle" if not terminate else "terminated"
        return {"ok": True, "project": was, "terminated": bool(terminate)}

    # ------------------------------------------------------------------ inspection
    def _frames(self, levels: int = 20) -> list[dict[str, Any]]:
        body = self._request("stackTrace", {"threadId": self.thread_id, "startFrame": 0, "levels": levels})
        return body.get("stackFrames") or []

    def _locals(self, frame_id: int, limit: int = 50) -> list[dict[str, Any]]:
        scopes = self._request("scopes", {"frameId": frame_id}).get("scopes") or []
        ref = next((s["variablesReference"] for s in scopes if str(s.get("name", "")).lower().startswith("local")),
                   scopes[0]["variablesReference"] if scopes else 0)
        if not ref:
            return []
        out = []
        for v in (self._request("variables", {"variablesReference": ref}).get("variables") or [])[:limit]:
            if str(v.get("name", "")).startswith("__") or v.get("name") in ("special variables", "function variables"):
                continue
            out.append({"name": v.get("name"), "value": v.get("value"), "type": v.get("type", "")})
        return out

    def snapshot(self) -> dict[str, Any]:
        out: dict[str, Any] = {"project": self.project, "state": self.state, "output": "".join(self.output[-30:])}
        if self.state == "stopped" and self.thread_id is not None:
            frames = self._frames()
            out["reason"] = self.stop_reason
            out["stack"] = [{"id": f.get("id"), "name": f.get("name"), "line": f.get("line"),
                             "file": self._local(str((f.get("source") or {}).get("path") or ""))} for f in frames]
            if frames:
                out["file"], out["line"] = out["stack"][0]["file"], out["stack"][0]["line"]
                out["locals"] = self._locals(int(frames[0]["id"]))
        return out
