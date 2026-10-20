"""Connection to the XScript admin backend (xscript_server) for cloud control (design §12.1, P4).

The desktop signs in with an API token (``xsk_…``, created in the console under 账号 → API 令牌) sent as
``Authorization: Bearer``; the backend only accepts API tokens that way. The origin is a settings row; the token
lives in the OS keyring as the ``backend/<origin>`` credential slot (services/secrets.py) and is never returned
from an RPC, logged, or put into an error message. The role comes from ``/api/auth/me`` and is what the page uses
to grey out actions (viewer < operator < admin); the backend enforces it again on every call.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from .secrets import SecretError, SecretStore, normalize, redact

ORIGIN_KEY = "backendOrigin"  # settings row
ROLES = {"viewer": 0, "operator": 1, "admin": 2}
TIMEOUT = 15.0


class BackendError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 0, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text[:200]
    d = body.get("detail") if isinstance(body, dict) else None
    if isinstance(d, str):
        return d
    if isinstance(d, list) and d and isinstance(d[0], dict):  # FastAPI validation errors
        return str(d[0].get("msg", ""))
    return ""


class BackendClient:
    """Async JSON client for ``<origin>/api``. One per (origin, token); cheap to create."""

    def __init__(self, origin: str, token: str, transport: httpx.AsyncBaseTransport | None = None, timeout: float = TIMEOUT) -> None:
        self.origin = origin
        self._token = token
        self._http = httpx.AsyncClient(base_url=origin + "/api", transport=transport, timeout=timeout, trust_env=False,
                                       headers={"Authorization": "Bearer " + token, "Accept": "application/json"})

    async def aclose(self) -> None:
        await self._http.aclose()

    async def request(self, method: str, path: str, *, params: dict[str, Any] | None = None, json: Any = None) -> Any:
        try:
            r = await self._http.request(method, path, params=params, json=json)
        except httpx.TimeoutException:
            raise BackendError("backend.timeout", "后台响应超时：" + self.origin, retryable=True) from None
        except httpx.HTTPError as e:
            raise BackendError("backend.unreachable", redact("连不上后台 %s：%s" % (self.origin, type(e).__name__), self._token),
                               retryable=True) from None
        if r.status_code == 401:
            raise BackendError("backend.unauthorized", "后台令牌无效或已过期，请在「云控 → 连接」重新填写（%s）" % redact(_detail(r), self._token), status=401)
        if r.status_code == 403:
            raise BackendError("backend.forbidden", "当前账号没有权限：" + redact(_detail(r) or "403", self._token), status=403)
        if r.status_code == 404:
            raise BackendError("backend.not_found", redact(_detail(r) or "不存在", self._token), status=404)
        if r.status_code >= 400:
            raise BackendError("backend.http", redact("后台返回 %d：%s" % (r.status_code, _detail(r)), self._token),
                               status=r.status_code, retryable=r.status_code >= 500)
        if not r.content:
            return None
        try:
            return r.json()
        except ValueError:
            raise BackendError("backend.bad_response", "后台返回的不是 JSON（地址是否指向 XScript 后台？）", status=r.status_code) from None

    async def get(self, path: str, **params: Any) -> Any:
        return await self.request("GET", path, params={k: v for k, v in params.items() if v is not None and v != ""})

    async def post(self, path: str, body: Any = None) -> Any:
        return await self.request("POST", path, json=body if body is not None else {})

    async def patch(self, path: str, body: Any) -> Any:
        return await self.request("PATCH", path, json=body)

    async def delete(self, path: str) -> Any:
        return await self.request("DELETE", path)

    async def me(self) -> dict[str, Any]:
        me = await self.get("/auth/me")
        if not isinstance(me, dict) or "role" not in me:
            raise BackendError("backend.bad_response", "这个地址不像 XScript 后台（/api/auth/me 没有返回账号）")
        return me


@dataclass
class _Settings:
    get: Callable[[str], Any]      # async (key) -> str | None
    set: Callable[[str, str], Any]  # async (key, value)
    delete: Callable[[str], Any]   # async (key)


def account(me: dict[str, Any]) -> dict[str, Any]:
    role = str(me.get("role", ""))
    return {"username": str(me.get("username", "")), "role": role,
            "canOperate": ROLES.get(role, -1) >= ROLES["operator"], "isAdmin": role == "admin"}


class CloudService:
    """Which backend the desktop talks to, and a client for it. Never exposes the token."""

    def __init__(self, secrets: SecretStore, settings: _Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.secrets = secrets
        self.settings = settings
        self.transport = transport  # tests inject httpx.MockTransport / ASGITransport
        self._client: BackendClient | None = None
        self._lock = asyncio.Lock()

    async def origin(self) -> str:
        return (await self.settings.get(ORIGIN_KEY)) or ""

    async def _token(self, origin: str) -> str:
        try:
            return await asyncio.to_thread(self.secrets.reveal, "backend", origin) or ""
        except SecretError as e:
            raise BackendError(e.code, e.message) from None

    async def client(self) -> BackendClient:
        """The client for the saved backend; `backend.not_configured` until connect() succeeded once."""
        async with self._lock:
            origin = await self.origin()
            if not origin:
                raise BackendError("backend.not_configured", "还没有连接后台：在「云控 → 连接」填写后台地址和 API 令牌")
            token = await self._token(origin)
            if not token:
                raise BackendError("backend.not_configured", "后台令牌不在系统凭据库里，请重新填写")
            if self._client is None or self._client.origin != origin or self._client._token != token:
                if self._client is not None:
                    await self._client.aclose()
                self._client = BackendClient(origin, token, self.transport)
            return self._client

    async def connect(self, origin: str, token: str) -> dict[str, Any]:
        """Check the address and token against /api/auth/me, then keep them (token -> keyring)."""
        try:
            origin = normalize("backend", origin).name
        except ValueError as e:
            raise BackendError("backend.bad_origin", str(e)) from None
        token = (token or "").strip()
        if not token or len(token) > 512 or any(c.isspace() for c in token):
            raise BackendError("backend.bad_token", "请粘贴完整的 API 令牌（在后台「账号 → API 令牌」创建，以 xsk_ 开头）")
        probe = BackendClient(origin, token, self.transport)
        try:
            me = await probe.me()
        finally:
            await probe.aclose()
        if me.get("role") == "reseller":
            raise BackendError("backend.forbidden", "代理账号不能用于桌面端云控，请用管理员、操作员或只读账号的令牌")
        old = await self.origin()
        try:
            await asyncio.to_thread(self.secrets.set, "backend", origin, token)
        except (SecretError, ValueError) as e:
            raise BackendError(getattr(e, "code", "secret.invalid"), redact(str(getattr(e, "message", e)), token)) from None
        await self.settings.set(ORIGIN_KEY, origin)
        if old and old != origin:  # one backend at a time: forget the previous token
            await asyncio.to_thread(self._forget, old)
        return {"state": "connected", "origin": origin, "account": account(me)}

    def _forget(self, origin: str) -> None:
        try:
            self.secrets.delete("backend", origin)
        except (SecretError, ValueError):
            pass

    async def status(self) -> dict[str, Any]:
        """{state: not_configured | connected | expired | unreachable | error, origin, account?, message?}"""
        origin = await self.origin()
        if not origin:
            return {"state": "not_configured", "origin": ""}
        try:
            c = await self.client()
            me = await c.me()
        except BackendError as e:
            state = {"backend.unauthorized": "expired", "backend.unreachable": "unreachable", "backend.timeout": "unreachable",
                     "backend.not_configured": "expired"}.get(e.code, "error")
            return {"state": state, "origin": origin, "code": e.code, "message": e.message}
        return {"state": "connected", "origin": origin, "account": account(me)}

    async def disconnect(self) -> dict[str, Any]:
        origin = await self.origin()
        if origin:
            await asyncio.to_thread(self._forget, origin)
            await self.settings.delete(ORIGIN_KEY)
        async with self._lock:
            if self._client is not None:
                await self._client.aclose()
                self._client = None
        return {"state": "not_configured", "origin": ""}


# ---- P4.2 device fleet (read-only) -------------------------------------------------------------------------------
DEVICE_FIELDS = ("id", "model", "brand", "app", "group", "note", "online", "running", "project", "version", "release",
                 "width", "height", "last_seen")
PAGE_SIZES = (25, 50, 100, 200)


def device_view(d: dict[str, Any]) -> dict[str, Any]:
    """The columns the device table shows; drops `data`, `remote` and other bulky / sensitive fields."""
    out = {k: d.get(k) for k in DEVICE_FIELDS}
    out["id"] = str(out["id"] or "")
    out["online"] = bool(out["online"])
    out["running"] = bool(out["running"])
    return out


async def list_devices(c: BackendClient, *, q: str = "", group: str = "", app: str = "", online: bool | None = None,
                       page: int = 1, page_size: int = 50) -> dict[str, Any]:
    page_size = page_size if page_size in PAGE_SIZES else 50
    r = await c.get("/devices", q=q.strip()[:200], group=group, app=app,
                    online=None if online is None else str(online).lower(), page=max(1, page), page_size=page_size)
    items = r.get("items") if isinstance(r, dict) else None
    if not isinstance(items, list):
        raise BackendError("backend.bad_response", "后台设备列表格式不对")
    return {"items": [device_view(d) for d in items if isinstance(d, dict)], "total": int(r.get("total") or 0),
            "page": max(1, page), "pageSize": page_size}


async def list_groups(c: BackendClient) -> list[dict[str, Any]]:
    r = await c.get("/groups")
    return [{"name": str(g.get("name", "")), "total": int(g.get("total") or 0), "online": int(g.get("online") or 0)}
            for g in (r or {}).get("items", []) if isinstance(g, dict)]


async def list_apps(c: BackendClient) -> list[str]:
    r = await c.get("/apps")
    return [str(a) for a in (r or {}).get("items", []) if a]


# ---- P4.3 batch commands -----------------------------------------------------------------------------------------
MAX_BATCH = 500
_PROJECT_RE = __import__("re").compile(r"^[\w\-. \u4e00-\u9fff]{1,64}$")


def _targets(ids: list[str]) -> str:
    clean = [i.strip() for i in ids if isinstance(i, str) and i.strip()]
    if not clean:
        raise BackendError("backend.bad_request", "先在设备表里勾选设备")
    if len(clean) > MAX_BATCH:
        raise BackendError("backend.bad_request", "一次最多 %d 台设备" % MAX_BATCH)
    if any("," in i or ":" in i for i in clean):  # never let a selection turn into all / group: / app: targeting
        raise BackendError("backend.bad_request", "设备 ID 不合法")
    return ",".join(dict.fromkeys(clean))


def summarize(ids: list[str], r: Any) -> dict[str, Any]:
    """Per-device rows in the order the user selected them; ids the backend didn't reach are 'offline'."""
    res = (r or {}).get("results") if isinstance(r, dict) else None
    res = res if isinstance(res, dict) else {}
    rows = []
    for i in dict.fromkeys(ids):
        x = res.get(i)
        if not isinstance(x, dict):
            rows.append({"id": i, "ok": False, "offline": True, "msg": "离线，未下发"})
        else:
            rows.append({"id": i, "ok": x.get("code") == 1, "offline": False, "msg": str(x.get("msg") or "")[:300]})
    return {"rows": rows, "ok": sum(r["ok"] for r in rows), "total": len(rows)}


async def batch_command(c: BackendClient, ids: list[str], action: str, project: str = "", param: dict[str, Any] | None = None) -> dict[str, Any]:
    target = _targets(ids)
    if action == "run":
        project = project.strip()
        if not _PROJECT_RE.match(project):
            raise BackendError("backend.bad_request", "填写要运行的工程名")
        cmd: dict[str, Any] = {"path": "app_run", "id": project, "param": param or {}}
    elif action == "stop":
        cmd = {"path": "app_stop"}
    else:
        raise BackendError("backend.bad_request", "未知操作：%s" % action)
    r = await c.post("/command", {"target": target, "command": cmd, "timeout": 20})
    return summarize(target.split(","), r)


# ---- P4.4 logs and server tasks ----------------------------------------------------------------------------------
from urllib.parse import quote as _quote  # noqa: E402

STREAMS = ("", "stdout", "stderr", "system")
TASK_PATHS = ("app_run", "app_stop")  # deploy tasks are P4.5 / admin-only and stay in the web console


def _dev_path(dev_id: str) -> str:
    dev_id = (dev_id or "").strip()
    if not dev_id or len(dev_id) > 200:
        raise BackendError("backend.bad_request", "选择一台设备")
    return "/devices/" + _quote(dev_id, safe="")


async def device_logs(c: BackendClient, dev_id: str, *, q: str = "", stream: str = "", before: int = 0, limit: int = 300) -> dict[str, Any]:
    if stream not in STREAMS:
        raise BackendError("backend.bad_request", "未知日志流：%s" % stream)
    r = await c.get(_dev_path(dev_id) + "/logs", q=q.strip()[:200], stream=stream, before=before or None, limit=max(1, min(limit, 2000)))
    items = [{"id": int(x.get("id") or 0), "ts": int(x.get("ts") or 0), "stream": str(x.get("stream") or ""), "line": str(x.get("line") or "")}
             for x in (r or {}).get("items", []) if isinstance(x, dict)]
    return {"items": items, "more": bool((r or {}).get("more"))}


def task_view(x: dict[str, Any]) -> dict[str, Any]:
    cmd = x.get("command") if isinstance(x.get("command"), dict) else {}
    return {"id": int(x.get("id") or 0), "name": str(x.get("name") or ""), "target": str(x.get("target") or ""),
            "path": str(cmd.get("path") or ""), "project": str(cmd.get("id") or "") if cmd.get("path") == "app_run" else "",
            "daily": x.get("daily"), "every": x.get("every"), "enabled": bool(x.get("enabled")),
            "lastRun": x.get("last_run"), "nextRun": x.get("next_run"), "lastResult": x.get("last_result"),
            "createdBy": str(x.get("created_by") or "")}


def _task_target(target: str) -> str:
    target = (target or "").strip()
    if target == "all" or (target.startswith("group:") and 6 < len(target) <= 70):
        return target
    ids = [i.strip() for i in target.split(",") if i.strip()]
    if ids and all(":" not in i for i in ids):
        return _targets(ids)
    raise BackendError("backend.bad_request", "目标只能是 all、group:<分组> 或设备 ID 列表")


async def list_tasks(c: BackendClient) -> list[dict[str, Any]]:
    r = await c.get("/tasks")
    return [task_view(x) for x in (r or {}).get("items", []) if isinstance(x, dict)]


async def create_task(c: BackendClient, *, name: str, target: str, path: str, project: str = "", daily: str = "",
                      every: float | None = None, enabled: bool = True) -> dict[str, Any]:
    if path not in TASK_PATHS:
        raise BackendError("backend.bad_request", "桌面端只能建运行 / 停止任务")
    cmd: dict[str, Any] = {"path": path}
    if path == "app_run":
        if not _PROJECT_RE.match(project.strip()):
            raise BackendError("backend.bad_request", "填写要运行的工程名")
        cmd.update(id=project.strip(), param={})
    if bool(daily) == (every is not None):
        raise BackendError("backend.bad_request", "每天定时和间隔二选一")
    body: dict[str, Any] = {"name": name.strip()[:64], "target": _task_target(target), "command": cmd, "enabled": enabled}
    if daily:
        body["daily"] = daily
    else:
        body["every"] = every
    return task_view(await c.post("/tasks", body))


async def update_task(c: BackendClient, task_id: int, *, enabled: bool | None = None, name: str | None = None) -> dict[str, Any]:
    body = {k: v for k, v in (("enabled", enabled), ("name", None if name is None else name.strip()[:64])) if v is not None}
    if not body:
        raise BackendError("backend.bad_request", "没有要改的内容")
    return task_view(await c.patch("/tasks/%d" % task_id, body))


async def run_task(c: BackendClient, task_id: int) -> dict[str, Any]:
    r = await c.post("/tasks/%d/run" % task_id)
    r = r if isinstance(r, dict) else {}
    return {"devices": int(r.get("devices") or 0), "ok": int(r.get("ok") or 0)}


async def delete_task(c: BackendClient, task_id: int) -> dict[str, Any]:
    await c.delete("/tasks/%d" % task_id)
    return {"ok": True}
