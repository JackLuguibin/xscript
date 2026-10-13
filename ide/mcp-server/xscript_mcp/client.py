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


@dataclass
class DeviceTarget:
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT

    @property
    def base_url(self) -> str:
        return "http://%s:%d" % (self.host, self.port)

    @classmethod
    def parse(cls, value: str) -> "DeviceTarget":
        text = (value or "").strip()
        if not text:
            return cls()
        if "://" in text:
            text = text.split("://", 1)[1]
        text = text.rstrip("/")
        if ":" in text:
            host, port_s = text.rsplit(":", 1)
            return cls(host=host or "127.0.0.1", port=int(port_s))
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


class DeviceClient:
    def __init__(self, target: DeviceTarget | None = None, timeout: float = 15.0):
        self.target = target or DeviceTarget()
        self.timeout = timeout

    def set_target(self, host: str, port: int = DEFAULT_PORT) -> DeviceTarget:
        self.target = DeviceTarget(host=host, port=port)
        return self.target

    def _url(self, path: str) -> str:
        return self.target.base_url + path

    def _client(self, timeout: float | None = None) -> httpx.Client:
        return httpx.Client(timeout=timeout or self.timeout, headers=CLIENT_HEADER)

    @staticmethod
    def _p(project: str) -> str:
        return quote(project, safe="")

    def _get(self, route: str, /, **params) -> dict[str, Any]:
        # `route` is positional-only so query params may be named `path` (e.g. read_file).
        with self._client() as client:
            r = client.get(self._url(route), params=params or None)
            r.raise_for_status()
            return r.json()

    def status(self) -> dict[str, Any]:
        return self._get("/status")

    def screen_png(self) -> bytes:
        with self._client() as client:
            r = client.get(self._url("/screen"))
            r.raise_for_status()
            return r.content

    def screen_jpeg(self, quality: int = 70) -> bytes:
        with self._client() as client:
            r = client.get(self._url("/screen"), params={"format": "jpg", "quality": int(quality)})
            r.raise_for_status()
            return r.content

    def ui_tree(self, mode: int = 0) -> dict[str, Any]:
        return self._get("/ui-tree", mode=int(mode))

    def list_projects(self) -> list[str]:
        return list(self._get("/projects").get("projects") or [])

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
            r.raise_for_status()
            return r.json()

    def upload_zip(self, project: str, data: bytes, replace: bool = True) -> dict[str, Any]:
        with self._client(timeout=max(self.timeout, 120)) as client:
            r = client.put(
                self._url("/projects/%s/zip" % self._p(project)),
                params={"replace": "true" if replace else "false"},
                content=data,
                headers={"Content-Type": "application/zip"},
            )
            r.raise_for_status()
            return r.json()

    def upload_directory(self, project: str, path: str | os.PathLike, replace: bool = True) -> dict[str, Any]:
        return self.upload_zip(project, zip_directory(path), replace=replace)

    def delete_project(self, project: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.delete(self._url("/projects/%s" % self._p(project)))
            r.raise_for_status()
            return r.json()

    def run_project(self, project: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/projects/%s/run" % self._p(project)))
            if r.status_code == 409:
                return r.json()
            r.raise_for_status()
            return r.json()

    def stop_project(self, project: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/projects/%s/stop" % self._p(project)))
            r.raise_for_status()
            return r.json()

    def logs(self, since: int = 0) -> dict[str, Any]:
        return self._get("/logs", since=int(since))

    def action(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/action"), json=payload)
            r.raise_for_status()
            return r.json()

    # ---- tools: snapshots, 图色 checks, 标注 datasets ----

    def snapshot(self) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/tools/snapshots"))
            r.raise_for_status()
            return r.json()

    def snapshot_png(self, snapshot_id: str) -> bytes:
        with self._client() as client:
            r = client.get(self._url("/tools/snapshots/%s.png" % quote(snapshot_id, safe="")))
            r.raise_for_status()
            return r.content

    def vision(self, request: dict[str, Any]) -> dict[str, Any]:
        """POST /tools/vision. 400/408 carry a JSON error body, returned as-is."""
        # YOLO / PaddleOCR load models (and may download them) on the first call.
        heavy = request.get("op") == "yolo" or str(request.get("engine", "")).startswith("paddle")
        with self._client(timeout=max(self.timeout, 130 if heavy else 25)) as client:
            r = client.post(self._url("/tools/vision"), json=request)
            if r.status_code in (400, 404, 408):
                return r.json()
            r.raise_for_status()
            return r.json()

    def crop_snapshot(self, snapshot_id: str, rect: list[int], project: str, path: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(
                self._url("/tools/snapshots/%s/crop" % quote(snapshot_id, safe="")),
                json={"rect": rect, "project": project, "path": path},
            )
            r.raise_for_status()
            return r.json()

    def list_datasets(self) -> list[dict[str, Any]]:
        return list(self._get("/tools/datasets").get("datasets") or [])

    def dataset(self, name: str) -> dict[str, Any]:
        return self._get("/tools/datasets/%s" % self._p(name))

    def export_dataset(self, name: str) -> bytes:
        with self._client(timeout=max(self.timeout, 120)) as client:
            r = client.get(self._url("/tools/datasets/%s/export" % self._p(name)))
            r.raise_for_status()
            return r.content

    # ---- run options and 定时任务 ----

    def project_config(self, project: str) -> dict[str, Any]:
        return self._get("/projects/%s/config" % self._p(project))

    def set_project_config(self, project: str, **flags: bool) -> dict[str, Any]:
        with self._client() as client:
            r = client.put(self._url("/projects/%s/config" % self._p(project)), json=flags)
            if r.status_code == 404:
                return r.json()
            r.raise_for_status()
            return r.json()

    def list_schedules(self, project: str | None = None) -> dict[str, Any]:
        return self._get("/schedules", **({"project": project} if project else {}))

    def add_schedule(self, schedule: dict[str, Any]) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/schedules"), json=schedule)
            if r.status_code == 400:
                return r.json()
            r.raise_for_status()
            return r.json()

    def update_schedule(self, schedule_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        with self._client() as client:
            r = client.put(self._url("/schedules/%s" % quote(schedule_id, safe="")), json=fields)
            if r.status_code in (400, 404):
                return r.json()
            r.raise_for_status()
            return r.json()

    def delete_schedule(self, schedule_id: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.delete(self._url("/schedules/%s" % quote(schedule_id, safe="")))
            r.raise_for_status()
            return r.json()

    def run_schedule(self, schedule_id: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.post(self._url("/schedules/%s/run" % quote(schedule_id, safe="")))
            if r.status_code == 404:
                return r.json()
            r.raise_for_status()
            return r.json()

    # ---- models (YOLO / PaddleOCR) and runtime packages ----

    def list_models(self) -> dict[str, Any]:
        return self._get("/models")

    def upload_model(self, local_path: str | os.PathLike, remote_path: str) -> dict[str, Any]:
        data = Path(local_path).expanduser().read_bytes()
        with self._client(timeout=max(self.timeout, 300)) as client:
            r = client.put(self._url("/models/" + quote(remote_path.lstrip("/"), safe="/")), content=data,
                           headers={"Content-Type": "application/octet-stream"})
            r.raise_for_status()
            return r.json()

    def delete_model(self, remote_path: str) -> dict[str, Any]:
        with self._client() as client:
            r = client.delete(self._url("/models/" + quote(remote_path.lstrip("/"), safe="/")))
            r.raise_for_status()
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
            r.raise_for_status()
            return r.json()

    def eval_python(self, code: str, timeout_ms: int = 8000) -> dict[str, Any]:
        wait = max(self.timeout, timeout_ms / 1000.0 + 2)
        with self._client(timeout=wait) as client:
            r = client.post(self._url("/eval"), json={"code": code, "timeout_ms": int(timeout_ms)})
            if r.status_code == 408:
                return {"ok": False, "error": "timeout"}
            r.raise_for_status()
            return r.json()
