from __future__ import annotations

import io
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

DEFAULT_PORT = 9860  # XScript's port; AScript uses 9096
CLIENT_HEADER = {"X-XScript-Client": "mcp"}

# Directories never worth shipping to the phone.
SKIP_DIRS = {"__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".venv", "venv", ".idea", ".vscode", "node_modules"}


class DeviceError(httpx.HTTPStatusError):
    """HTTP error from the device, carrying the device's own `error` text (e.g. 工程已存在: demo)."""

    def __init__(self, response: httpx.Response):
        detail = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                detail = str(body.get("error") or body.get("msg") or "")
        except ValueError:
            detail = response.text[:200]
        self.status_code = response.status_code
        if response.status_code == 401:
            detail = ("需要配对码：在手机 XScript 首页「开发与连接 → 配对码」查看，"
                      "设置环境变量 XSCRIPT_TOKEN，或调用 connect_device(ip, port, token)")
        self.detail = detail
        msg = "device %s %s -> %d" % (response.request.method, response.request.url.path, response.status_code)
        super().__init__(msg + (": " + detail if detail else ""), request=response.request, response=response)


def _check(r: httpx.Response) -> None:
    if r.is_error:
        raise DeviceError(r)


@dataclass
class DeviceTarget:
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT

    @property
    def base_url(self) -> str:
        host = "[%s]" % self.host if ":" in self.host else self.host
        return "http://%s:%d" % (host, self.port)

    @classmethod
    def parse(cls, value: str) -> "DeviceTarget":
        text = (value or "").strip()
        if not text:
            return cls()
        if "://" in text:
            text = text.split("://", 1)[1]
        text = text.split("/", 1)[0]  # drop any path, e.g. http://ip:9860/tools/
        if text.startswith("["):  # [IPv6]:port
            host, _, rest = text[1:].partition("]")
            port_s = rest[1:] if rest.startswith(":") else ""
            return cls(host=host or "::1", port=int(port_s) if port_s else DEFAULT_PORT)
        if text.count(":") > 1:  # bare IPv6 address, no port
            return cls(host=text, port=DEFAULT_PORT)
        if ":" in text:
            host, port_s = text.rsplit(":", 1)
            return cls(host=host or "127.0.0.1", port=int(port_s) if port_s else DEFAULT_PORT)
        return cls(host=text, port=DEFAULT_PORT)


def zip_directory(path: str | os.PathLike) -> bytes:
    """Zip a local project directory (entry __init__.py at the archive root)."""
    base = Path(path).expanduser().resolve()
    if not (base / "__init__.py").is_file():
        raise ValueError("%s has no __init__.py" % base)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            for name in files:
                if name.endswith((".pyc", ".pyo")) or name.startswith("."):
                    continue
                full = Path(root) / name
                zf.write(full, full.relative_to(base).as_posix())
    return buf.getvalue()


def auth_headers(token: str | None) -> dict[str, str]:
    """Client header plus the pairing code (phone: 开发与连接 → 配对码) as a bearer token."""
    code = "".join(c for c in (token or "") if c.isalnum()).upper()
    return dict(CLIENT_HEADER, **({"Authorization": "Bearer " + code} if code else {}))


class DeviceClient:
    def __init__(self, target: DeviceTarget | None = None, timeout: float = 15.0, token: str | None = None):
        self.target = target or DeviceTarget()
        self.timeout = timeout
        self.token = token if token is not None else os.environ.get("XSCRIPT_TOKEN", "")

    def set_target(self, host: str, port: int = DEFAULT_PORT, token: str | None = None) -> DeviceTarget:
        self.target = DeviceTarget(host=host, port=port)
        if token is not None:
            self.token = token
        return self.target

    def _url(self, path: str) -> str:
        return self.target.base_url + path

    def _client(self, timeout: float | None = None) -> httpx.Client:
        # trust_env=False: device traffic never goes through a system proxy (macOS proxies answer 502).
        return httpx.Client(timeout=timeout or self.timeout, headers=auth_headers(self.token), trust_env=False)

    @staticmethod
    def _p(project: str) -> str:
        return quote(project, safe="")

    def _get(self, route: str, /, **params) -> dict[str, Any]:
        # `route` is positional-only so query params may be named `path` (e.g. read_file).
        with self._client() as client:
            r = client.get(self._url(route), params=params or None)
            _check(r)
            return r.json()

    def status(self) -> dict[str, Any]:
        return self._get("/status")

    def screen_png(self) -> bytes:
        with self._client() as client:
            r = client.get(self._url("/screen"))
            _check(r)
            return r.content

    def screen_jpeg(self, quality: int = 70) -> bytes:
        with self._client() as client:
            r = client.get(self._url("/screen"), params={"format": "jpg", "quality": int(quality)})
            _check(r)
            return r.content

    def ui_tree(self, mode: int = 0) -> dict[str, Any]:
        return self._get("/ui-tree", mode=int(mode))

    def list_projects(self) -> list[str]:
        return list(self._get("/projects").get("projects") or [])

    def get_settings(self) -> dict[str, Any]:
        return self._get("/settings")

    def update_settings(self, changes: dict[str, Any]) -> dict[str, Any]:
        """Partial update of the runtime settings; returns the full settings afterwards."""
        with self._client() as client:
            r = client.put(self._url("/settings"), json=changes)
            _check(r)
            return r.json()

    def list_ascript_projects(self) -> list[str]:
        """AScript projects found on the phone (/sdcard/airscript/model)."""
        return list(self._get("/ascript/projects").get("projects") or [])

    def import_ascript_project(self, name: str) -> dict[str, Any]:
        """Copy an AScript project into XScript (needs root or shared storage access)."""
        with self._client() as client:
            r = client.post(self._url("/ascript/import"), json={"name": name})
            _check(r)
            return r.json()

    def list_files(self, project: str) -> list[dict[str, Any]]:
        return list(self._get("/projects/%s/files" % self._p(project)).get("files") or [])

    def read_file(self, project: str, path: str) -> dict[str, Any]:
        return self._get("/projects/%s/file" % self._p(project), path=path)

    def upload_file(self, project: str, path: str, content: str, encoding: str = "utf-8") -> dict[str, Any]:
        with self._client() as client:
            r = client.put(
                self._url("/projects/%s/files" % self._p(project)),
                json={"path": path, "content": content, "encoding": encoding},
            )
            _check(r)
            return r.json()

    def upload_zip(self, project: str, data: bytes, replace: bool = True) -> dict[str, Any]:
        with self._client(timeout=max(self.timeout, 120)) as client:
            r = client.put(
                self._url("/projects/%s/zip" % self._p(project)),
                params={"replace": "true" if replace else "false"},
                content=data,
                headers={"Content-Type": "application/zip"},
            )
            _check(r)
            return r.json()

    def upload_directory(self, project: str, path: str | os.PathLike, replace: bool = True) -> dict[str, Any]:
        return self.upload_zip(project, zip_directory(path), replace=replace)

    def delete_project(self, project: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.delete(self._url("/projects/%s" % self._p(project)))
            _check(r)
            return r.json()

    def run_project(self, project: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/projects/%s/run" % self._p(project)))
            if r.status_code == 409:
                return r.json()
            _check(r)
            return r.json()

    def stop_project(self, project: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/projects/%s/stop" % self._p(project)))
            _check(r)
            return r.json()

    def logs(self, since: int = 0) -> dict[str, Any]:
        return self._get("/logs", since=int(since))

    def action(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/action"), json=payload)
            _check(r)
            return r.json()

    # ---- tools: snapshots, 图色 checks, 标注 datasets ----

    def snapshot(self) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/tools/snapshots"))
            _check(r)
            return r.json()

    def snapshot_png(self, snapshot_id: str) -> bytes:
        with self._client() as client:
            r = client.get(self._url("/tools/snapshots/%s.png" % quote(snapshot_id, safe="")))
            _check(r)
            return r.content

    def vision(self, request: dict[str, Any]) -> dict[str, Any]:
        """POST /tools/vision. 400/408 carry a JSON error body, returned as-is."""
        # YOLO / PaddleOCR load models (and may download them) on the first call.
        heavy = request.get("op") == "yolo" or str(request.get("engine", "")).startswith("paddle")
        with self._client(timeout=max(self.timeout, 130 if heavy else 25)) as client:
            r = client.post(self._url("/tools/vision"), json=request)
            if r.status_code in (400, 404, 408):
                return r.json()
            _check(r)
            return r.json()

    def crop_snapshot(self, snapshot_id: str, rect: list[int], project: str, path: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(
                self._url("/tools/snapshots/%s/crop" % quote(snapshot_id, safe="")),
                json={"rect": rect, "project": project, "path": path},
            )
            _check(r)
            return r.json()

    def list_datasets(self) -> list[dict[str, Any]]:
        return list(self._get("/tools/datasets").get("datasets") or [])

    def dataset(self, name: str) -> dict[str, Any]:
        return self._get("/tools/datasets/%s" % self._p(name))

    def export_dataset(self, name: str) -> bytes:
        with self._client(timeout=max(self.timeout, 120)) as client:
            r = client.get(self._url("/tools/datasets/%s/export" % self._p(name)))
            _check(r)
            return r.content

    # ---- run options and 定时任务 ----

    def project_config(self, project: str) -> dict[str, Any]:
        return self._get("/projects/%s/config" % self._p(project))

    def set_project_config(self, project: str, **flags: bool) -> dict[str, Any]:
        with self._client() as client:
            r = client.put(self._url("/projects/%s/config" % self._p(project)), json=flags)
            if r.status_code == 404:
                return r.json()
            _check(r)
            return r.json()

    def list_schedules(self, project: str | None = None) -> dict[str, Any]:
        return self._get("/schedules", **({"project": project} if project else {}))

    def add_schedule(self, schedule: dict[str, Any]) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/schedules"), json=schedule)
            if r.status_code == 400:
                return r.json()
            _check(r)
            return r.json()

    def update_schedule(self, schedule_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        with self._client() as client:
            r = client.put(self._url("/schedules/%s" % quote(schedule_id, safe="")), json=fields)
            if r.status_code in (400, 404):
                return r.json()
            _check(r)
            return r.json()

    def delete_schedule(self, schedule_id: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.delete(self._url("/schedules/%s" % quote(schedule_id, safe="")))
            _check(r)
            return r.json()

    def run_schedule(self, schedule_id: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/schedules/%s/run" % quote(schedule_id, safe="")))
            if r.status_code == 404:
                return r.json()
            _check(r)
            return r.json()

    # ---- models (YOLO / PaddleOCR) and runtime packages ----

    def list_models(self) -> dict[str, Any]:
        return self._get("/models")

    def upload_model(self, local_path: str | os.PathLike, remote_path: str) -> dict[str, Any]:
        data = Path(local_path).expanduser().read_bytes()
        with self._client(timeout=max(self.timeout, 300)) as client:
            r = client.put(self._url("/models/" + quote(remote_path.lstrip("/"), safe="/")), content=data,
                           headers={"Content-Type": "application/octet-stream"})
            _check(r)
            return r.json()

    def delete_model(self, remote_path: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.delete(self._url("/models/" + quote(remote_path.lstrip("/"), safe="/")))
            _check(r)
            return r.json()

    def list_packages(self) -> dict[str, Any]:
        with self._client(timeout=max(self.timeout, 30)) as client:
            r = client.get(self._url("/packages"))
            return r.json()

    def pip(self, op: str, packages: list[str], upgrade: bool = False, index_url: str = "",
            timeout_s: float = 300) -> dict[str, Any]:
        """POST /packages. 400 / 408 carry a JSON error body, returned as-is."""
        body = {"op": op, "packages": list(packages), "upgrade": bool(upgrade), "index_url": index_url,
                "timeout_ms": int(timeout_s * 1000)}
        with self._client(timeout=timeout_s + 10) as client:
            r = client.post(self._url("/packages"), json=body)
            if r.status_code in (400, 408):
                return r.json()
            _check(r)
            return r.json()

    def eval_python(self, code: str, timeout_ms: int = 8000) -> dict[str, Any]:
        wait = max(self.timeout, timeout_ms / 1000.0 + 2)
        with self._client(timeout=wait) as client:
            r = client.post(self._url("/eval"), json={"code": code, "timeout_ms": int(timeout_ms)})
            if r.status_code == 408:
                return {"ok": False, "error": "timeout"}
            _check(r)
            return r.json()
