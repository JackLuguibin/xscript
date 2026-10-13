"""APK 打包 jobs: one Gradle build at a time, run through backend/xscript_pack.py."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from .audit import audit
from .config import Config
from .db import Database
from .models import PackJob
from .protect import has_entry

log = logging.getLogger("xscript.pack")

APP_ID = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")
PROJECT_NAME = re.compile(r"^[^\W\d]\w*$", re.UNICODE)
MAX_UNZIPPED = 512 * 1024 * 1024
MAX_FILES = 20000


def safe_extract(zip_path: Path, dest: Path) -> Path:
    """Extract without path traversal or zip bombs; return the project root (dir with __init__.py)."""
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    total = 0
    with zipfile.ZipFile(zip_path) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > MAX_FILES:
            raise ValueError("压缩包文件太多")
        for info in infos:
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/") or info.external_attr >> 28 == 0xA:  # symlink
                raise ValueError("压缩包里有不安全的路径: %s" % info.filename)
            total += info.file_size
            if total > MAX_UNZIPPED:
                raise ValueError("压缩包解压后超过 512 MB")
            target = (root / name).resolve()
            if root not in target.parents:
                raise ValueError("压缩包里有不安全的路径: %s" % info.filename)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    if has_entry(root):
        return root
    # AScript exports wrap the project in one top folder.
    subs = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith(("__MACOSX", "."))]
    if len(subs) == 1 and has_entry(subs[0]):
        return subs[0]
    raise ValueError("压缩包里没有 __init__.py（工程入口）")


class Packer:
    def __init__(self, config: Config, db: Database, alerts=None):
        self.config, self.db, self.alerts = config, db, alerts
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queue: asyncio.Queue[int] = asyncio.Queue()
        self.current: int | None = None
        self.proc: asyncio.subprocess.Process | None = None
        self.cancelled: set[int] = set()

    def job_dir(self, job_id: int) -> Path:
        return self.config.pack_dir / str(job_id)

    def log_path(self, job_id: int) -> Path:
        return self.job_dir(job_id) / "build.log"

    def read_log(self, job_id: int, offset: int = 0, limit: int = 256 * 1024) -> tuple[str, int]:
        p = self.log_path(job_id)
        if not p.is_file():
            return "", 0
        with open(p, "rb") as f:
            f.seek(max(0, offset))
            data = f.read(limit)
        return data.decode("utf-8", "replace"), max(0, offset) + len(data)

    def available(self) -> tuple[bool, str]:
        script = self.config.pack_script
        if not script:
            return False, "这台服务器没有开启 APK 打包（Docker 部署请使用 full 镜像）"
        if not Path(script).is_file():
            return False, "找不到打包脚本 xscript_pack.py"
        return True, ""

    # ------------------------------------------------------------ queue

    def recover(self) -> None:
        """Jobs left running by a crash or restart are marked failed; queued ones run again."""
        with self.db.session() as s:
            for job in s.scalars(select(PackJob).where(PackJob.status == "running")):
                job.status, job.error, job.finished_at = "failed", "服务重启，任务中断", int(time.time())
            queued = list(s.scalars(select(PackJob.id).where(PackJob.status == "queued").order_by(PackJob.id)))
            s.commit()
        for jid in queued:
            self.queue.put_nowait(jid)

    def submit(self, job_id: int) -> None:
        self.queue.put_nowait(job_id)

    async def cancel(self, job_id: int) -> bool:
        with self.db.session() as s:
            job = s.get(PackJob, job_id)
            if job is None or job.status not in ("queued", "running"):
                return False
            if job.status == "queued":
                job.status, job.finished_at = "cancelled", int(time.time())
                s.commit()
                return True
        self.cancelled.add(job_id)
        if self.current == job_id and self.proc and self.proc.returncode is None:
            self.proc.terminate()
        return True

    def position(self, job_id: int) -> int | None:
        items = list(self.queue._queue)  # type: ignore[attr-defined]
        return items.index(job_id) + 1 if job_id in items else None

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        while True:
            job_id = await self.queue.get()
            try:
                await self._run(job_id)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # pragma: no cover
                log.exception("pack job %s crashed", job_id)
                await run_in_threadpool(self._finish, job_id, "failed", None, str(e))
            finally:
                self.current, self.proc = None, None

    # ------------------------------------------------------------ one job

    def _start(self, job_id: int) -> dict[str, Any] | None:
        with self.db.session() as s:
            job = s.get(PackJob, job_id)
            if job is None or job.status != "queued":
                return None
            job.status, job.started_at = "running", int(time.time())
            s.commit()
            return {"app_id": job.app_id, "app_name": job.app_name, "version": job.version,
                    "version_code": job.version_code, "project_name": job.project_name,
                    "options": dict(job.options or {}), "created_by": job.created_by}

    def _finish(self, job_id: int, status: str, apk: Path | None, error: str | None) -> None:
        with self.db.session() as s:
            job = s.get(PackJob, job_id)
            if job is None:
                return
            job.status, job.finished_at, job.error = status, int(time.time()), error
            if apk is not None:
                job.apk_file, job.apk_size = apk.name, apk.stat().st_size
            audit(s, job.created_by or "system", "pack.finish", job.app_id,
                  {"job": job_id, "status": status, "error": (error or "")[:300]})
            s.commit()
            label = "%s v%s（#%d）" % (job.app_name or job.app_id, job.version, job_id)
        if self.alerts is not None and status in ("succeeded", "failed"):
            event = "pack_succeeded" if status == "succeeded" else "pack_failed"
            text = "打包 %s %s" % (label, "成功" if status == "succeeded" else "失败：%s" % (error or "")[:300])
            # _finish runs in a worker thread; hand the alert to the event loop.
            if self.loop is not None:
                self.loop.call_soon_threadsafe(self.alerts.emit, event, label, text)

    def build_args(self, job_id: int, info: dict[str, Any], project: Path) -> tuple[list[str], dict[str, str]]:
        o = info["options"]
        d = self.job_dir(job_id)
        args = [sys.executable, str(self.config.pack_script), str(project),
                "--app-id", info["app_id"], "--version", info["version"],
                "--version-code", str(info["version_code"]), "--out", str(d / "out"),
                "--abis", o.get("abis") or "arm64-v8a"]
        if info["app_name"]:
            args += ["--name", info["app_name"]]
        if info["project_name"]:
            args += ["--project-name", info["project_name"]]
        if (d / "icon.png").is_file():
            args += ["--icon", str(d / "icon.png")]
        if o.get("license_pubkey"):
            args += ["--license-pubkey", o["license_pubkey"]]
            if o.get("license_server"):
                args += ["--license-server", o["license_server"]]
        env = dict(os.environ)
        env.pop("XSCRIPT_CLOUD_URL", None)
        if o.get("cloud_url"):
            # The URL embeds a device key: pass it in the environment, not argv (visible in `ps`).
            env["XSCRIPT_CLOUD_URL"] = o["cloud_url"]
            if o.get("cloud_group"):
                args += ["--cloud-group", o["cloud_group"]]
        for flag in ("autostart", "dev_server", "bundle_requirements", "protect"):
            if o.get(flag):
                args.append("--" + flag.replace("_", "-"))
        if o.get("update_channel"):
            args += ["--update-server", o["update_server"], "--update-channel", o["update_channel"],
                     "--update-pubkey", o["update_pubkey"], "--script-code", str(o.get("script_code") or 0)]
        if o.get("release") and self.config.release_signing:
            # Passwords go through the environment so they never show up in `ps`.
            args += ["--keystore", self.config.keystore, "--key-alias", self.config.key_alias]
            env["XSCRIPT_STORE_PASS"] = self.config.store_pass
            env["XSCRIPT_KEY_PASS"] = self.config.key_pass or self.config.store_pass
        return args, env

    async def _run(self, job_id: int) -> None:
        info = await run_in_threadpool(self._start, job_id)
        if info is None:
            return
        self.current = job_id
        d = self.job_dir(job_id)
        logf = open(self.log_path(job_id), "ab")
        try:
            def say(text: str) -> None:
                logf.write((text + "\n").encode("utf-8"))
                logf.flush()

            try:
                project = await run_in_threadpool(safe_extract, d / "project.zip", d / "src")
            except (ValueError, zipfile.BadZipFile) as e:
                say("error: %s" % e)
                await run_in_threadpool(self._finish, job_id, "failed", None, str(e))
                return
            args, env = self.build_args(job_id, info, project)
            say("$ " + " ".join(args[1:]))
            if env.get("XSCRIPT_CLOUD_URL"):
                say("  XSCRIPT_CLOUD_URL=%s?token=***" % env["XSCRIPT_CLOUD_URL"].split("?")[0])
            self.proc = await asyncio.create_subprocess_exec(
                *args, stdout=logf, stderr=asyncio.subprocess.STDOUT, env=env, cwd=str(d),
                start_new_session=True)
            code = await self.proc.wait()
            if job_id in self.cancelled:
                self.cancelled.discard(job_id)
                say("cancelled")
                await run_in_threadpool(self._finish, job_id, "cancelled", None, "已取消")
                return
            apks = sorted((d / "out").glob("*.apk")) if (d / "out").is_dir() else []
            if code != 0 or not apks:
                err = "打包失败（退出码 %s），详见构建日志" % code if code != 0 else "没有生成 APK"
                await run_in_threadpool(self._finish, job_id, "failed", None, err)
                return
            await run_in_threadpool(self._finish, job_id, "succeeded", apks[0], None)
            # The extracted sources are no longer needed; keep project.zip for rebuilds.
            await run_in_threadpool(shutil.rmtree, d / "src", True)
        finally:
            logf.close()
