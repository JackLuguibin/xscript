"""Async client for the device HTTP API (protocol/openapi.yaml), ported from ide/mcp-server/xscript_mcp/client.py
and the address rules of ide/vscode-extension/src/client.ts (`parseTarget`)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

DEFAULT_PORT = 9860
CLIENT_HEADER = {"X-XScript-Client": "desktop"}


class DeviceError(Exception):
    """HTTP or transport failure talking to a device."""

    def __init__(self, message: str, *, status: int | None = None, detail: str = "", kind: str = "http"):
        super().__init__(message)
        self.status = status
        self.detail = detail
        self.kind = kind  # "http" | "connect" | "timeout" | "protocol"

    @property
    def retryable(self) -> bool:
        return self.kind in ("connect", "timeout") or self.status in (429, 502, 503, 504)

    @property
    def code(self) -> str:
        """The RPC error code for this failure (the page maps codes to actionable hints)."""
        return {"connect": "device.unreachable", "timeout": "device.timeout", "protocol": "device.protocol",
                "auth": "device.unpaired"}.get(self.kind, "device.http")


@dataclass(frozen=True)
class DeviceTarget:
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT

    @property
    def base_url(self) -> str:
        host = "[%s]" % self.host if ":" in self.host else self.host
        return "http://%s:%d" % (host, self.port)

    @property
    def address(self) -> str:
        return "%s:%d" % (("[%s]" % self.host) if ":" in self.host else self.host, self.port)

    @classmethod
    def parse(cls, value: str) -> "DeviceTarget":
        """Same rules as client.ts parseTarget: scheme and path dropped, [v6]:port, bare v6, strict port."""
        text = (value or "").strip()
        if not text:
            return cls()
        if "://" in text:
            text = text.split("://", 1)[1]
        text = text.split("/", 1)[0]

        def port(s: str) -> int:
            if s == "":
                return DEFAULT_PORT
            if not re.fullmatch(r"\d+", s) or not (0 < int(s) <= 65535):
                raise ValueError("invalid port in device address: %s" % value)
            return int(s)

        if text.startswith("["):
            end = text.find("]")
            if end < 0:
                raise ValueError("invalid device address: %s" % value)
            rest = text[end + 1:]
            return cls(host=text[1:end] or "::1", port=port(rest[1:] if rest.startswith(":") else ""))
        if text.count(":") > 1:
            return cls(host=text, port=DEFAULT_PORT)
        i = text.rfind(":")
        if i < 0:
            return cls(host=text, port=DEFAULT_PORT)
        return cls(host=text[:i] or "127.0.0.1", port=port(text[i + 1:]))


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
        if isinstance(body, dict):
            return str(body.get("error") or body.get("msg") or "")
    except ValueError:
        return r.text[:200]
    return ""


def normalize_code(code: str) -> str:
    """"abcd-efgh" -> "ABCDEFGH": the pairing code as the device compares it."""
    return "".join(c for c in (code or "") if c.isalnum()).upper()


def valid_code(code: str) -> bool:
    return bool(re.fullmatch(r"[A-Z0-9]{8}", normalize_code(code)))


def needs_pairing(status: dict[str, Any]) -> bool:
    """/status of a device that has pairing on and did not accept (or was not given) our code."""
    return bool(status.get("pairing")) and status.get("paired") is False


class DeviceClient:
    """One device endpoint. Sends the pairing code (phone: 开发与连接 → 配对码) as a bearer token when it has one."""

    def __init__(self, target: DeviceTarget, timeout: float = 10.0, transport: httpx.AsyncBaseTransport | None = None,
                 token: str = ""):
        self.target = target
        self.timeout = timeout
        self._http = httpx.AsyncClient(
            base_url=target.base_url, timeout=timeout, headers=CLIENT_HEADER, transport=transport,
            trust_env=False,  # never route device traffic through a system proxy
        )
        self.token = ""
        self.set_token(token)

    def set_token(self, code: str) -> None:
        self.token = normalize_code(code)
        if self.token:
            self._http.headers["Authorization"] = "Bearer " + self.token
        else:
            self._http.headers.pop("Authorization", None)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, *, timeout: float | None = None, ok_status: tuple[int, ...] = (), **kw: Any) -> httpx.Response:
        try:
            r = await self._http.request(method, path, timeout=timeout or self.timeout, **kw)
        except httpx.TimeoutException as e:
            raise DeviceError("device %s %s timed out" % (method, path), kind="timeout") from e
        except httpx.TransportError as e:
            raise DeviceError("cannot reach %s: %s" % (self.target.address, e), kind="connect") from e
        if r.is_error and r.status_code not in ok_status:
            d = _detail(r)
            if r.status_code == 401:
                raise DeviceError("设备需要配对码（手机 XScript 首页「开发与连接 → 配对码」）", status=401, detail=d, kind="auth")
            raise DeviceError("device %s %s -> %d%s" % (method, path, r.status_code, (": " + d) if d else ""),
                              status=r.status_code, detail=d)
        return r

    async def _json(self, method: str, path: str, **kw: Any) -> Any:
        r = await self._request(method, path, **kw)
        try:
            return r.json()
        except ValueError as e:
            raise DeviceError("device %s %s returned non-JSON" % (method, path), kind="protocol") from e

    # ---- read ----------------------------------------------------------------------------------------------------------------

    async def status(self) -> dict[str, Any]:
        data = await self._json("GET", "/status")
        if not isinstance(data, dict):
            raise DeviceError("unexpected /status response", kind="protocol")
        return data

    async def screen(self, fmt: str = "jpg", quality: int = 60, max_side: int | None = None) -> tuple[bytes, str]:
        params: dict[str, Any] = {"format": fmt, "quality": int(quality)}
        if max_side:
            params["max"] = int(max_side)
        r = await self._request("GET", "/screen", params=params, timeout=max(self.timeout, 20))
        return r.content, r.headers.get("content-type", "image/jpeg" if fmt == "jpg" else "image/png")

    def open_screen_stream(self, fps: int = 12, scale: float = 0.5, quality: int = 60):
        """Long-lived MJPEG response (`async with`). Closing it is what frees the device's viewer slot (design §14.4).

        Read timeout is disabled: the proxy has its own 3 s watchdog and must not have httpx abort the body first."""
        timeout = httpx.Timeout(self.timeout, read=None)
        return self._http.stream("GET", "/screen/stream", params={"fps": int(fps), "scale": float(scale), "quality": int(quality)},
                                  timeout=timeout)

    async def projects(self) -> list[dict[str, Any]]:
        data = await self._json("GET", "/projects")
        details = data.get("details") if isinstance(data, dict) else None
        if isinstance(details, list):
            return details
        return [{"name": n} for n in (data.get("projects") or [])] if isinstance(data, dict) else []

    async def logs(self, since: int = 0) -> dict[str, Any]:
        return await self._json("GET", "/logs", params={"since": int(since)})

    # ---- projects / run (used by the entry-point investigation and later phases) -------------------------------------------

    @staticmethod
    def _p(project: str) -> str:
        return quote(project, safe="")

    async def files(self, project: str) -> dict[str, Any]:
        data = await self._json("GET", "/projects/%s/files" % self._p(project))
        if not isinstance(data, dict):
            raise DeviceError("unexpected /files response", kind="protocol")
        return {"project": data.get("project", project), "files": data.get("files") or [], "dirs": data.get("dirs") or []}

    async def read_file(self, project: str, path: str) -> dict[str, Any]:
        return await self._json("GET", "/projects/%s/file" % self._p(project), params={"path": path})

    async def write_file(self, project: str, path: str, content: str, encoding: str = "utf-8", create: bool = False) -> dict[str, Any]:
        body: dict[str, Any] = {"path": path, "content": content, "encoding": encoding}
        if create:
            body["create"] = True
        return await self._json("PUT", "/projects/%s/files" % self._p(project), json=body)

    async def upload_files(self, project: str, files: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._json("PUT", "/projects/%s/files" % self._p(project), json={"files": files}, timeout=max(self.timeout, 120))

    async def read_raw(self, project: str, path: str) -> bytes:
        r = await self._request("GET", "/projects/%s/file" % self._p(project), params={"path": path, "raw": "1"}, timeout=max(self.timeout, 60))
        return r.content

    async def files_or_none(self, project: str) -> list[dict[str, Any]] | None:
        """The project's file list, or None when the project does not exist yet (404)."""
        r = await self._request("GET", "/projects/%s/files" % self._p(project), ok_status=(404,))
        if r.status_code == 404:
            return None
        data = r.json()
        return data.get("files") or [] if isinstance(data, dict) else []

    async def delete_file(self, project: str, path: str, recursive: bool = False) -> dict[str, Any]:
        """DELETE /projects/{name}/file; `recursive` removes a folder with everything in it (reply carries `deleted`)."""
        params = {"path": path, "recursive": "1"} if recursive else {"path": path}
        return await self._json("DELETE", "/projects/%s/file" % self._p(project), params=params)

    async def move(self, project: str, src: str, dst: str) -> dict[str, Any]:
        return await self._json("POST", "/projects/%s/move" % self._p(project), json={"from": src, "to": dst})

    # ---- debugger bridge (/debug/*, docs/DEBUGGING.md) ---------------------------------------------------------------------------

    async def debug_start(self, project: str) -> dict[str, Any]:
        r = await self._request("POST", "/projects/%s/debug" % self._p(project), ok_status=(403, 404, 409), timeout=max(self.timeout, 30))
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.is_error and isinstance(data, dict):
            data.setdefault("error", "HTTP %d" % r.status_code)
            data["status"] = r.status_code
        return data if isinstance(data, dict) else {}

    async def debug_connect(self) -> dict[str, Any]:
        r = await self._request("POST", "/debug/connect", json={}, ok_status=(409,))
        data = r.json() if r.content else {}
        if r.status_code == 409 and isinstance(data, dict):
            data.setdefault("error", "debugger not ready")
        return data if isinstance(data, dict) else {}

    async def debug_request(self, message: dict[str, Any]) -> dict[str, Any]:
        return await self._json("POST", "/debug/request", json=message)

    async def debug_messages(self, since: int) -> dict[str, Any]:
        return await self._json("GET", "/debug/messages", params={"since": int(since)})

    async def debug_close(self) -> dict[str, Any]:
        return await self._json("DELETE", "/debug")

    async def create_project(self, project: str) -> dict[str, Any]:
        return await self._json("POST", "/projects/%s" % self._p(project))

    async def upload_zip(self, project: str, data: bytes, replace: bool = True) -> dict[str, Any]:
        return await self._json("PUT", "/projects/%s/zip" % self._p(project), params={"replace": "true" if replace else "false"},
                                content=data, headers={"Content-Type": "application/zip"}, timeout=max(self.timeout, 120))

    async def run_project(self, project: str) -> dict[str, Any]:
        r = await self._request("POST", "/projects/%s/run" % self._p(project), ok_status=(409,))
        return r.json()

    async def stop_project(self, project: str) -> dict[str, Any]:
        return await self._json("POST", "/projects/%s/stop" % self._p(project))

    async def delete_project(self, project: str) -> dict[str, Any]:
        return await self._json("DELETE", "/projects/%s" % self._p(project))

    async def eval_python(self, code: str, timeout_ms: int = 8000) -> dict[str, Any]:
        r = await self._request("POST", "/eval", json={"code": code, "timeout_ms": int(timeout_ms)},
                                timeout=max(self.timeout, timeout_ms / 1000.0 + 2), ok_status=(408,))
        if r.status_code == 408:
            return {"ok": False, "error": "timeout"}
        return r.json()

    async def action(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._json("POST", "/action", json=payload)

    async def request_capture(self) -> dict[str, Any]:
        """Bring up the screen-recording grant dialog on the phone (openapi /capture/request). Older apps answer 404."""
        r = await self._request("POST", "/capture/request", content=b"", ok_status=(404,))
        if r.status_code == 404:
            return {"ok": False, "unsupported": True}
        data = r.json()
        return data if isinstance(data, dict) else {"ok": False}

    async def ui_tree(self, mode: int = 0) -> dict[str, Any]:
        data = await self._json("GET", "/ui-tree", params={"mode": int(mode)})
        if not isinstance(data, dict):
            raise DeviceError("unexpected /ui-tree response", kind="protocol")
        return data

    async def capture_snapshot(self) -> dict[str, Any]:
        """Empty body freezes the current screen. A body would be uploaded as a PNG (openapi /tools/snapshots)."""
        data = await self._json("POST", "/tools/snapshots", content=b"")
        if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not data["id"]:
            raise DeviceError("unexpected /tools/snapshots response", kind="protocol")
        return data

    async def vision_pixel(self, snapshot: str, x: int, y: int) -> dict[str, Any]:
        data = await self._json("POST", "/tools/vision", json={"snapshot": snapshot, "op": "pixel", "x": int(x), "y": int(y)},
                                timeout=max(self.timeout, 20))
        if not isinstance(data, dict):
            raise DeviceError("unexpected /tools/vision response", kind="protocol")
        return data


def is_xscript_status(st: Any) -> bool:
    """Does a /status body look like an XScript device? (any JSON object is not enough: a random local web server answers too)"""
    return isinstance(st, dict) and any(k in st for k in ("device_id", "app_id", "model"))


def summarize_status(st: dict[str, Any]) -> dict[str, Any]:
    """The few fields the UI shows as 'device info' (full /status is also passed through)."""
    return {
        "name": st.get("name") or st.get("model") or "",
        "model": st.get("model", ""), "brand": st.get("brand", ""),
        "android": st.get("release", ""), "sdk": st.get("sdk"),
        "width": st.get("width"), "height": st.get("height"), "density": st.get("density"),
        "ip": st.get("ip", ""), "port": st.get("port"),
        "version": st.get("version", ""), "deviceId": st.get("device_id", ""), "appId": st.get("app_id", ""),
        "running": bool(st.get("running")), "project": st.get("project") or "",
        "accessibility": bool(st.get("accessibility")), "root": bool(st.get("root")),
        "capture": bool(st.get("capture")), "channel": st.get("channel", ""), "cloud": st.get("cloud", ""),
        # None: an app that does not report capture_via yet (the screen page then shows nothing about capture)
        "captureVia": str(st.get("capture_via") or "") if "capture_via" in st else None, "captureLost": bool(st.get("capture_lost")),
    }
