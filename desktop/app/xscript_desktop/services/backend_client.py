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

    async def request(self, method: str, path: str, *, params: dict[str, Any] | None = None, json: Any = None,
                      files: Any = None, data: dict[str, str] | None = None, timeout: float | None = None,
                      raw: bool = False) -> Any:
        try:
            if files is not None:  # multipart upload (script versions)
                r = await self._http.request(method, path, params=params, files=files, data=data,
                                             timeout=timeout or self._http.timeout)
            else:
                r = await self._http.request(method, path, params=params, json=json, timeout=timeout or self._http.timeout)
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
        if raw:
            return r.content, r.headers.get("content-type", "application/octet-stream")
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
    out["crash"] = crash_view(d.get("last_run"), out["running"])
    return out


def crash_view(last_run: Any, running: bool) -> dict[str, Any] | None:
    """The last run's crash (project, exit, time, last stderr line), or None when it ended cleanly or a run is in progress."""
    if running or not isinstance(last_run, dict) or not last_run.get("crashed"):
        return None
    tail = last_run.get("tail") if isinstance(last_run.get("tail"), list) else []
    error = next((str(t.get("line") or "").strip() for t in reversed(tail)
                  if isinstance(t, dict) and t.get("stream") == "stderr"), "")
    return {"project": str(last_run.get("project") or ""), "exit": str(last_run.get("exit") or ""),
            "time": last_run.get("time") if isinstance(last_run.get("time"), (int, float)) else None, "error": error[:200]}


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


# ---- P4.5 deploy a flow to a group, with rollback ----------------------------------------------------------------
import io  # noqa: E402
import posixpath  # noqa: E402
import re as _re  # noqa: E402
import zipfile  # noqa: E402

PROJECT_NAME = _re.compile(r"^[^\W\d]\w*$", _re.UNICODE)  # same rule as backend packer.PROJECT_NAME
VERSION_RE = _re.compile(r"^[0-9A-Za-z.\-_+]{1,32}$")
MAX_FILES = 200
MAX_ZIP = 8 * 1024 * 1024  # under the backend's 11 MB deploy bundle cap


def flow_zip(project: str, files: list[dict[str, Any]]) -> bytes:
    """The flow's deploy plan (traced build, .xflow, layout, entry stub) as a project zip under `<project>/`."""
    if not PROJECT_NAME.match(project or ""):
        raise BackendError("backend.bad_request", "流程名必须是合法的 Python 标识符，例如 daily_signin")
    if not files or len(files) > MAX_FILES:
        raise BackendError("backend.bad_request", "部署内容为空或文件太多")
    buf = io.BytesIO()
    seen: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            path = str(f.get("path") or "") if isinstance(f, dict) else ""
            content = f.get("content") if isinstance(f, dict) else None
            norm = posixpath.normpath(path)
            if not path or not isinstance(content, str) or norm != path or norm.startswith(("/", "..")) or "\\" in path or norm in seen:
                raise BackendError("backend.bad_request", "部署文件路径不合法：%s" % path[:80])
            seen.add(norm)
            info = zipfile.ZipInfo(project + "/" + norm, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, content.encode("utf-8"))
    if "__init__.py" not in seen:
        raise BackendError("backend.bad_request", "部署内容缺少入口 __init__.py")
    data = buf.getvalue()
    if len(data) > MAX_ZIP:
        raise BackendError("backend.bad_request", "流程工程太大（%.1f MB）" % (len(data) / 1e6))
    return data


def _group_target(group: str) -> str:
    group = (group or "").strip()
    if not group or len(group) > 64 or "," in group:
        raise BackendError("backend.bad_request", "选择要部署到的分组")
    return "group:" + group


def version_view(v: dict[str, Any]) -> dict[str, Any]:
    return {"id": int(v.get("id") or 0), "version": str(v.get("version") or ""), "code": int(v.get("version_code") or 0),
            "notes": str(v.get("notes") or ""), "createdBy": str(v.get("created_by") or ""),
            "createdAt": v.get("created_at"), "current": bool(v.get("current"))}


async def find_script(c: BackendClient, project: str) -> dict[str, Any] | None:
    r = await c.get("/scripts")
    for sc in (r or {}).get("items", []):
        if isinstance(sc, dict) and sc.get("project_name") == project:
            return sc
    return None


async def flow_versions(c: BackendClient, project: str) -> dict[str, Any]:
    """The backend 小程序 that holds this flow (matched by project name) and its versions, newest first."""
    if not PROJECT_NAME.match(project or ""):
        raise BackendError("backend.bad_request", "流程名必须是合法的 Python 标识符")
    sc = await find_script(c, project)
    if sc is None:
        return {"scriptId": None, "versions": []}
    r = await c.get("/scripts/%d/versions" % int(sc["id"]))
    return {"scriptId": int(sc["id"]), "versions": [version_view(v) for v in (r or {}).get("items", []) if isinstance(v, dict)]}


async def _deploy(c: BackendClient, script_id: int, version_id: int, target: str, run: bool) -> dict[str, Any]:
    r = await c.request("POST", "/scripts/%d/deploy" % script_id, json={"target": target, "version_id": version_id, "run": run,
                                                                        "timeout": 60}, timeout=120)
    res = (r or {}).get("results") if isinstance(r, dict) else None
    rows = [{"id": str(k), "ok": isinstance(v, dict) and v.get("code") == 1, "offline": False,
             "msg": str((v or {}).get("msg") or "")[:300] if isinstance(v, dict) else ""} for k, v in (res or {}).items()]
    return {"rows": rows, "ok": sum(x["ok"] for x in rows), "total": len(rows), "version": str((r or {}).get("version") or "")}


async def deploy_flow(c: BackendClient, *, project: str, files: list[dict[str, Any]], group: str, version: str = "",
                      notes: str = "", run: bool = True) -> dict[str, Any]:
    """Upload the flow as the next version of its 小程序 (created on first deploy), then install it on the group."""
    target = _group_target(group)
    if version and not VERSION_RE.match(version):
        raise BackendError("backend.bad_request", "版本号只能包含字母、数字和 . - _ +")
    blob = flow_zip(project, files)
    sc = await find_script(c, project)
    if sc is None:
        sc = await c.post("/scripts", {"name": project, "project_name": project,
                                       "description": "由桌面端流程编辑器部署"})
    sid = int(sc["id"])
    v = await c.request("POST", "/scripts/%d/versions" % sid, files={"file": (project + ".zip", blob, "application/zip")},
                        data={"version": version, "notes": notes[:4000], "publish": "false"}, timeout=120)
    out = await _deploy(c, sid, int(v["id"]), target, run)
    return {**out, "scriptId": sid, "versionId": int(v["id"]), "version": str(v.get("version") or out["version"])}


async def rollback_flow(c: BackendClient, *, script_id: int, version_id: int, group: str, run: bool = True) -> dict[str, Any]:
    """Install an earlier version on the group again (the backend keeps every uploaded version)."""
    out = await _deploy(c, script_id, version_id, _group_target(group), run)
    return {**out, "scriptId": script_id, "versionId": version_id}


# ---- P4.6 thumbnails, web console links, APK pack jobs -------------------------------------------------------------
MAX_APK = 300 * 1024 * 1024
CONSOLE_PAGES = ("devices", "wall", "tasks", "scripts", "pack", "audit")


async def thumb(c: BackendClient, dev_id: str, max_side: int = 480) -> tuple[bytes, str]:
    """One JPEG of a cloud device's screen through the backend relay (operator+; GET /screen is on its allow list)."""
    body = {"method": "GET", "path": "/screen", "query": {"format": "jpg", "quality": 60, "max": max(64, min(int(max_side), 1080))},
            "timeout": 20}
    data, mime = await c.request("POST", _dev_path(dev_id) + "/http", json=body, raw=True, timeout=30)
    if not mime.startswith("image/"):
        raise BackendError("backend.bad_response", "设备没有返回图片")
    return data, mime.split(";")[0]


def console_links(origin: str) -> list[dict[str, str]]:
    """Deep links into the web console. They open in the system browser, which has its own console session: the
    desktop's API token never leaves the keyring and is never put into a URL or a web view."""
    return [{"page": p, "url": "%s/%s" % (origin, p)} for p in CONSOLE_PAGES]


def pack_job_view(j: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "status", "app_id", "app_name", "version", "version_code", "project_name", "created_by", "created_at",
            "finished_at", "apk_size", "error", "has_apk", "queue_position")
    out = {k: j.get(k) for k in keys}
    out["has_apk"] = bool(out["has_apk"])
    return out


async def pack_jobs(c: BackendClient, page: int = 1) -> dict[str, Any]:
    info = await c.get("/pack/info")
    r = await c.get("/pack/jobs", page=max(1, page), page_size=20)
    return {"available": bool((info or {}).get("available")), "reason": str((info or {}).get("reason") or ""),
            "items": [pack_job_view(j) for j in (r or {}).get("items", []) if isinstance(j, dict)], "total": int((r or {}).get("total") or 0)}


async def pack_log(c: BackendClient, job_id: int, offset: int = 0) -> dict[str, Any]:
    r = await c.get("/pack/jobs/%d/log" % job_id, offset=max(0, offset))
    return {"text": str((r or {}).get("text") or ""), "next": int((r or {}).get("next") or 0)}


async def pack_cancel(c: BackendClient, job_id: int) -> dict[str, Any]:
    await c.post("/pack/jobs/%d/cancel" % job_id)
    return {"ok": True}


async def pack_apk(c: BackendClient, job_id: int) -> bytes:
    data, mime = await c.request("GET", "/pack/jobs/%d/apk" % job_id, raw=True, timeout=300)
    if len(data) > MAX_APK or not data.startswith(b"PK"):
        raise BackendError("backend.bad_response", "后台返回的不是 APK")
    return data
