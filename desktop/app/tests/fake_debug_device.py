"""A device whose /debug/* bridge fronts a tiny scripted debugpy (DAP), for the desktop debugger tests.

The "script" is a list of lines; execution stops at breakpoints (or after a step) and reports frames/variables that depend on
the current line, so step/continue are observable. Messages are buffered like the real bridge (monotonic cursor).
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

REMOTE_ROOT = "/data/user/0/com.xscript.app/files/projects/dbg"
STATUS = {"name": "dbg-phone", "model": "Fake", "device_id": "dbg01", "app_id": "com.xscript.app", "width": 1080, "height": 2340}


class FakeDebugDevice:
    def __init__(self, n_lines: int = 6) -> None:
        self.lock = threading.Lock()
        self.n_lines = n_lines
        self.source = "".join("v%d = %d\n" % (i, i) for i in range(1, n_lines + 1))
        self.mode = "ok"  # ok | busy | never_ready | no_initialized | stack_fails
        self.reset()
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a) -> None:
                pass

            def _send(self, code: int, body: object) -> None:
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)

            def _body(self) -> dict:
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}") if n else {}

            def do_GET(self) -> None:  # noqa: N802
                u = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                with outer.lock:
                    if u.path == "/status":
                        self._send(200, dict(STATUS, running=outer.running, project="dbg" if outer.running else ""))
                    elif u.path == "/logs":
                        since = int(q.get("since", 0))
                        ents = [e for e in outer.logs if e["seq"] > since]
                        self._send(200, {"entries": ents, "next": outer.logs[-1]["seq"] if outer.logs else since})
                    elif u.path == "/projects":
                        self._send(200, {"projects": ["dbg"], "details": [{"name": "dbg"}]})
                    elif u.path == "/projects/dbg/files":
                        self._send(200, {"project": "dbg", "files": [{"path": "__init__.py", "size": len(outer.source)}], "dirs": []})
                    elif u.path == "/projects/dbg/file" and q.get("path") == "__init__.py":
                        self._send(200, {"path": "__init__.py", "encoding": "utf-8", "content": outer.source})
                    elif u.path == "/debug/messages":
                        since = int(q.get("since", 0))
                        msgs = [m for m in outer.msgs if m["id"] > since]
                        self._send(200, {"messages": msgs, "next": outer.msgs[-1]["id"] if outer.msgs else since,
                                         "connected": outer.connected, "error": None, "dropped_before": 0})
                    else:
                        self._send(404, {"error": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                u = urlparse(self.path)
                body = self._body()
                with outer.lock:
                    outer.requests.append(("POST", u.path, body))
                    if u.path.endswith("/debug") and u.path.startswith("/projects/"):
                        if outer.mode == "busy" or outer.running:
                            self._send(409, {"error": "already running"})
                            return
                        outer.running = True
                        outer.project = unquote(u.path.split("/")[2])
                        self._send(200, {"ok": True, "debug": {"port": 5678, "remote_root": REMOTE_ROOT}})
                    elif u.path == "/debug/connect":
                        outer.connect_calls += 1
                        if outer.mode == "never_ready" or outer.connect_calls < 2:
                            self._send(409, {"error": "debugger not ready"})
                            return
                        outer.connected = True
                        self._send(200, {"ok": True, "next": 0})
                    elif u.path == "/debug/request":
                        if not outer.connected:
                            self._send(409, {"error": "disconnected"})
                            return
                        outer.dap(body)
                        self._send(200, {"ok": True})
                    elif u.path.endswith("/stop"):
                        outer.stopped_project = True
                        outer.running = False
                        outer.connected = False
                        self._send(200, {"ok": True, "running": False})
                    else:
                        self._send(404, {"error": "not found"})

            def do_DELETE(self) -> None:  # noqa: N802
                with outer.lock:
                    outer.requests.append(("DELETE", self.path, {}))
                    outer.connected = False
                    self._send(200, {"ok": True})

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self._httpd.daemon_threads = True
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    def reset(self) -> None:
        self.running = False
        self.connected = False
        self.connect_calls = 0
        self.msgs: list[dict] = []
        self.logs: list[dict] = [{"seq": 1, "ts": 0, "stream": "stdout", "line": "old run\n"}]
        self.requests: list[tuple] = []
        self.bps: dict[str, list[int]] = {}
        self.line = 0
        self.attach_seq: int | None = None
        self.stopped_project = False
        self.project = ""

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    # ---- scripted debugpy ----------------------------------------------------------------------------------------------------------

    def _push(self, msg: dict) -> None:
        self.msgs.append({"id": len(self.msgs) + 1, "message": msg})

    def _resp(self, req: dict, body: dict | None = None, success: bool = True, message: str = "") -> None:
        m = {"type": "response", "request_seq": req["seq"], "command": req["command"], "success": success, "body": body or {}}
        if message:
            m["message"] = message
        self._push(m)

    def _event(self, name: str, body: dict | None = None) -> None:
        self._push({"type": "event", "event": name, "body": body or {}})

    def _run_from(self, start: int, step: bool = False) -> None:
        """Advance from line `start` to the next breakpoint (or one line when stepping); finish after the last line."""
        main = self.bps.get(REMOTE_ROOT + "/__init__.py", [])
        for ln in range(start, self.n_lines + 1):
            self.logs.append({"seq": len(self.logs) + 1, "ts": 0, "stream": "stdout", "line": "line %d\n" % ln})
            if (step and ln >= start) or ln in main:
                self.line = ln
                self._event("stopped", {"reason": "step" if step else "breakpoint", "threadId": 1, "allThreadsStopped": True})
                return
        self.running = False
        self._event("terminated")
        self.connected = False

    def dap(self, req: dict) -> None:
        cmd, args = req.get("command"), req.get("arguments") or {}
        if cmd == "initialize":
            self._resp(req, {"supportsConfigurationDoneRequest": True})
        elif cmd == "attach":
            self.attach_seq = req["seq"]  # answered only after configurationDone (like debugpy)
            if self.mode != "no_initialized":
                self._event("initialized")
        elif cmd == "setBreakpoints":
            path = args["source"]["path"]
            self.bps[path] = [b["line"] for b in args.get("breakpoints", [])]
            self._resp(req, {"breakpoints": [{"line": b["line"], "verified": b["line"] <= self.n_lines} for b in args.get("breakpoints", [])]})
        elif cmd == "setExceptionBreakpoints":
            self._resp(req)
        elif cmd == "configurationDone":
            self._resp(req)
            if self.attach_seq:
                self._push({"type": "response", "request_seq": self.attach_seq, "command": "attach", "success": True, "body": {}})
            self._event("output", {"category": "stdout", "output": "dup of the script's stdout\n"})
            self._event("output", {"category": "console", "output": "logpoint hit\n", "line": 2})
            self._event("thread", {"reason": "started", "threadId": 1})
            self._run_from(1)
        elif cmd == "stackTrace":
            if self.mode == "stack_fails":
                self._resp(req, success=False, message="no frames")
                return
            self._resp(req, {"stackFrames": [
                {"id": 100, "name": "<module>", "line": self.line, "column": 1, "source": {"path": REMOTE_ROOT + "/__init__.py", "name": "__init__.py"}},
                {"id": 101, "name": "run", "line": 7, "column": 1, "source": {"path": "/system/lib/python/runpy.py", "name": "runpy.py"}},
            ], "totalFrames": 2})
        elif cmd == "scopes":
            self._resp(req, {"scopes": [{"name": "Locals", "variablesReference": 10, "expensive": False},
                                        {"name": "Globals", "variablesReference": 20, "expensive": True}]})
        elif cmd == "variables":
            ref = args["variablesReference"]
            if ref == 10:
                self._resp(req, {"variables": [{"name": "total", "value": str(self.line * 10), "type": "int", "variablesReference": 0},
                                               {"name": "cfg", "value": "{'a': 1}", "type": "dict", "variablesReference": 11}]})
            elif ref == 11:
                self._resp(req, {"variables": [{"name": "'a'", "value": "1", "type": "int", "variablesReference": 0}]})
            else:
                self._resp(req, {"variables": []})
        elif cmd == "evaluate":
            expr = args.get("expression", "")
            if expr == "boom":
                self._resp(req, success=False, message="NameError: name 'boom' is not defined")
            else:
                self._resp(req, {"result": "eval:" + expr, "type": "str", "variablesReference": 0})
        elif cmd == "continue":
            self._resp(req, {"allThreadsContinued": True})
            self._event("continued", {"threadId": 1})
            self._run_from(self.line + 1)
        elif cmd in ("next", "stepIn", "stepOut"):
            self._resp(req)
            self._run_from(self.line + 1, step=True)
        elif cmd == "pause":
            self._resp(req)
            self._event("stopped", {"reason": "pause", "threadId": 1})
        elif cmd == "disconnect":
            self._resp(req)
        else:
            self._resp(req, success=False, message="unsupported " + str(cmd))
