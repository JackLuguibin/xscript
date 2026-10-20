"""Deterministic stand-in for the admin backend's /api (xscript_server) behind httpx.MockTransport.

Only the routes the desktop's cloud pages call, with the same status codes and JSON shapes as
backend/xscript_server/routes/*. Tokens map to users; `calls` records (method, path, json) for assertions.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable

import httpx

ORIGIN = "https://cloud.example.test"
TOKENS = {"xsk_admin": ("alice", "admin"), "xsk_op": ("olga", "operator"), "xsk_view": ("victor", "viewer"),
          "xsk_reseller": ("rita", "reseller")}
LEVEL = {"viewer": 0, "operator": 1, "admin": 2}


class FakeBackend:
    def __init__(self) -> None:
        self.tokens = dict(TOKENS)
        self.calls: list[tuple[str, str, Any]] = []
        self.down = False
        self.routes: list[tuple[str, re.Pattern[str], str, Callable[..., Any]]] = []
        self.devices: list[dict[str, Any]] = [
            {"id": "dev-a1", "device_id": "a1", "app": "com.xscript.app", "model": "Pixel 7", "brand": "google", "group": "farm-1",
             "note": "rack A", "online": True, "running": True, "project": "daily", "version": "0.4.0", "release": "14",
             "width": 1080, "height": 2400, "last_seen": 1760990000, "data": {"secret": "x"}, "remote": "10.0.0.5"},
            {"id": "dev-b2", "device_id": "b2", "app": "com.xscript.app", "model": "Mi 11", "brand": "xiaomi", "group": "farm-1",
             "note": "", "online": True, "running": False, "project": None, "version": "0.4.0", "release": "13",
             "width": 1080, "height": 2340, "last_seen": 1760990000, "data": {}, "remote": "10.0.0.6"},
            {"id": "dev-c3", "device_id": "c3", "app": "com.other.app", "model": "SM-A54", "brand": "samsung", "group": "farm-2",
             "note": "", "online": False, "running": False, "project": None, "version": "0.3.9", "release": "14",
             "width": 1080, "height": 2340, "last_seen": 1760900000, "data": {}, "remote": None},
        ]
        self.route("GET", r"/devices", "viewer", self._devices)
        self.route("GET", r"/groups", "viewer", lambda req, user, m: {"items": [
            {"name": g, "total": sum(d["group"] == g for d in self.devices),
             "online": sum(d["group"] == g and d["online"] for d in self.devices)} for g in sorted({d["group"] for d in self.devices})]})
        self.route("GET", r"/apps", "viewer", lambda req, user, m: {"items": sorted({d["app"] for d in self.devices})})
        self.route("POST", r"/command", "operator", self._command)
        self.logs = {"dev-a1": [{"id": i + 1, "seq": i, "ts": 1760990000000 + i, "stream": "stderr" if i % 4 == 3 else "stdout",
                                 "line": "step %d %s" % (i, "error" if i % 4 == 3 else "ok")} for i in range(10)]}
        self.tasks: dict[int, dict[str, Any]] = {1: {"id": 1, "name": "morning", "target": "group:farm-1",
                                                     "command": {"path": "app_run", "id": "daily", "param": {}}, "daily": "08:30",
                                                     "every": None, "enabled": True, "last_run": None, "next_run": 1761049800,
                                                     "last_result": None, "created_by": "alice", "created_at": 1}}
        self.route("GET", r"/devices/(?P<id>[^/]+)/logs", "viewer", self._logs)
        self.route("GET", r"/tasks", "viewer", lambda req, user, m: {"items": list(self.tasks.values())})
        self.route("POST", r"/tasks", "operator", self._task_create)
        self.route("PATCH", r"/tasks/(?P<id>\d+)", "operator", self._task_patch)
        self.route("DELETE", r"/tasks/(?P<id>\d+)", "operator", lambda req, user, m: (200, {"ok": True}) if self.tasks.pop(int(m["id"]), None) else (404, {"detail": "任务不存在"}))
        self.route("POST", r"/tasks/(?P<id>\d+)/run", "operator", lambda req, user, m: {"results": {}, "devices": 2, "ok": 2} if int(m["id"]) in self.tasks else (404, {"detail": "任务不存在"}))
        self.route("GET", r"/auth/me", "viewer", lambda req, user, m: {"id": 1, "username": user[0], "role": user[1], "disabled": False})

    def _devices(self, req: httpx.Request, user: Any, m: Any) -> dict[str, Any]:
        qp = req.url.params
        rows = [d for d in self.devices
                if (not qp.get("q") or qp["q"].lower() in (d["id"] + d["model"] + d["brand"] + d["note"]).lower())
                and (not qp.get("group") or d["group"] == qp["group"]) and (not qp.get("app") or d["app"] == qp["app"])
                and (qp.get("online") is None or d["online"] == (qp["online"] == "true"))]
        page, size = int(qp.get("page", 1)), int(qp.get("page_size", 50))
        return {"items": rows[(page - 1) * size: page * size], "total": len(rows)}

    def _command(self, req: httpx.Request, user: Any, m: Any) -> dict[str, Any]:
        body = json.loads(req.content)
        ids = body["target"].split(",")
        live = {d["id"]: d for d in self.devices if d["online"]}
        res = {}
        for i in ids:
            if i in live:
                ok = body["command"]["path"] == "app_stop" or body["command"].get("id") != "missing"
                res[i] = {"code": 1 if ok else -1, "msg": "ok" if ok else "工程不存在"}
        return {"results": res, "devices": len(res), "ok": sum(r["code"] == 1 for r in res.values())}

    def _logs(self, req: httpx.Request, user: Any, m: Any) -> dict[str, Any]:
        from urllib.parse import unquote
        qp = req.url.params
        rows = [x for x in self.logs.get(unquote(m["id"]), []) if (not qp.get("q") or qp["q"] in x["line"])
                and (not qp.get("stream") or x["stream"] == qp["stream"]) and (not qp.get("before") or x["id"] < int(qp["before"]))]
        limit = int(qp.get("limit", 500))
        return {"items": rows[-limit:], "more": len(rows) > limit}

    def _task_create(self, req: httpx.Request, user: Any, m: Any) -> Any:
        b = json.loads(req.content)
        if bool(b.get("daily")) == bool(b.get("every")):
            return 422, {"detail": [{"msg": "Value error, daily 和 every 二选一"}]}
        tid = max(self.tasks, default=0) + 1
        self.tasks[tid] = {"id": tid, "name": b["name"], "target": b["target"], "command": b["command"], "daily": b.get("daily"),
                           "every": b.get("every"), "enabled": b["enabled"], "last_run": None, "next_run": None,
                           "last_result": None, "created_by": user[0], "created_at": 2}
        return self.tasks[tid]

    def _task_patch(self, req: httpx.Request, user: Any, m: Any) -> Any:
        t = self.tasks.get(int(m["id"]))
        if t is None:
            return 404, {"detail": "任务不存在"}
        t.update(json.loads(req.content))
        return t

    def route(self, method: str, pattern: str, role: str, fn: Callable[..., Any]) -> None:
        """fn(request, (username, role), match) -> JSON body, or (status, body)."""
        self.routes.append((method, re.compile("^/api" + pattern + "$"), role, fn))

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.raw_path.decode().split("?")[0], body))
        auth = request.headers.get("authorization", "")
        token = auth[7:] if auth.lower().startswith("bearer ") else ""
        user = self.tokens.get(token)
        if user is None:
            # like deps.current_user; echo the token back to prove the desktop redacts it
            return httpx.Response(401, json={"detail": "登录已失效 " + token})
        for method, pat, role, fn in self.routes:
            m = pat.match(request.url.path)
            if m and method == request.method:
                if role != "any" and (user[1] == "reseller" and pat.pattern != "^/api/auth/me$" or LEVEL.get(user[1], -1) < LEVEL[role]):
                    return httpx.Response(403, json={"detail": "权限不足"})
                out = fn(request, user, m)
                status, out = out if isinstance(out, tuple) else (200, out)
                return httpx.Response(status, json=out)
        return httpx.Response(404, json={"detail": "Not Found"})
