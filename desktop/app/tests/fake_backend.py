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
        self.route("GET", r"/auth/me", "viewer", lambda req, user, m: {"id": 1, "username": user[0], "role": user[1], "disabled": False})

    def route(self, method: str, pattern: str, role: str, fn: Callable[..., Any]) -> None:
        """fn(request, (username, role), match) -> JSON body, or (status, body)."""
        self.routes.append((method, re.compile("^/api" + pattern + "$"), role, fn))

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
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
