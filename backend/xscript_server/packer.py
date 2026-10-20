"""APK 打包 jobs, run through backend/xscript_pack.py.

Two modes (Config.pack_mode, XSCRIPT_PACK_MODE):
  local  (default) this server builds one job at a time from an in-memory queue.
  remote jobs wait in the database; separate 打包机 (pack_worker.py) claim them over HTTP, send the build
         log with a heartbeat, and upload the APK. A job whose worker stops sending heartbeats for
         `lease_s` is queued again once (then failed), so a lost machine never leaves it "running".
"""

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

from sqlalchemy import func, select, update
from starlette.concurrency import run_in_threadpool

from .audit import audit
from .config import Config
from .db import Database
from .models import PackJob, PackWorker
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


def pack_command(python: str, pack_script: Path, d: Path, info: dict[str, Any], project: Path,
                 signing: tuple[str, str, str, str] | None) -> tuple[list[str], dict[str, str]]:
    """The xscript_pack.py command for one job (here or on a 打包机). `d` is the job directory, `signing` is
    (keystore, alias, store password, key password) when this machine can sign release builds."""
    o = info["options"]
    args = [python, str(pack_script), str(project),
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
    if o.get("ops_server"):
        args += ["--ops-server", o["ops_server"]]
    if o.get("update_channel"):
        args += ["--update-server", o["update_server"], "--update-channel", o["update_channel"],
                 "--update-pubkey", o["update_pubkey"], "--script-code", str(o.get("script_code") or 0)]
    if o.get("release") and signing:
        keystore, alias, store_pass, key_pass = signing
        # Passwords go through the environment so they never show up in `ps`.
        args += ["--keystore", keystore, "--key-alias", alias]
        env["XSCRIPT_STORE_PASS"] = store_pass
        env["XSCRIPT_KEY_PASS"] = key_pass or store_pass
    return args, env


def redacted_command(args: list[str], env: dict[str, str]) -> list[str]:
    """The log lines that show the command (the 云控 URL carries a device key)."""
    out = ["$ " + " ".join(args[1:])]
    if env.get("XSCRIPT_CLOUD_URL"):
        out.append("  XSCRIPT_CLOUD_URL=%s?token=***" % env["XSCRIPT_CLOUD_URL"].split("?")[0])
    return out


class WrongJob(Exception):
    """The job is not running on this 打包机 any more (cancelled, reassigned after a lost lease, deleted)."""


class Packer:
    lease_s = 90            # a worker sends a heartbeat every few seconds; this long without one = lost
    reap_interval = 10.0
    max_attempts = 2        # a lost worker's job is handed out once more, then failed

    def __init__(self, config: Config, db: Database, alerts=None):
        self.config, self.db, self.alerts = config, db, alerts
        self.loop: asyncio.AbstractEventLoop | None = None
        # Created on first use, inside the running loop: before Python 3.10 an asyncio.Queue binds to the loop
        # current at construction, and create_app() runs before uvicorn starts its own loop (harmless on 3.10+).
        self._queue: asyncio.Queue[int] | None = None
        self.current: int | None = None
        self.proc: asyncio.subprocess.Process | None = None
        self.cancelled: set[int] = set()

    @property
    def queue(self) -> asyncio.Queue:
        if self._queue is None:
            self._queue = asyncio.Queue()
        return self._queue

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

    @property
    def remote(self) -> bool:
        return self.config.pack_mode == "remote"

    def available(self) -> tuple[bool, str]:
        if self.remote:
            with self.db.session() as s:
                n = s.scalar(select(func.count()).select_from(PackWorker).where(PackWorker.disabled.is_(False)))
            if not n:
                return False, "还没有可用的打包机：在「APK 打包 → 打包机」里添加一台，并在那台机器上启动 pack-worker"
            return True, ""
        script = self.config.pack_script
        if not script:
            return False, "这台服务器没有开启 APK 打包（Docker 部署请使用 full 镜像）"
        if not Path(script).is_file():
            return False, "找不到打包脚本 xscript_pack.py"
        return True, ""

    def release_signing(self) -> bool:
        """Can a release (正式签名) build run? Remote: some enabled 打包机 reported a keystore."""
        if not self.remote:
            return self.config.release_signing
        with self.db.session() as s:
            caps = s.scalars(select(PackWorker.capabilities).where(PackWorker.disabled.is_(False))).all()
        return any((c or {}).get("release") for c in caps)

    def append_log(self, job_id: int, text: str) -> None:
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        with open(self.log_path(job_id), "ab") as f:
            f.write(text.encode("utf-8", "replace"))

    # ------------------------------------------------------------ queue

    def recover(self) -> None:
        """Jobs left running by a crash or restart are marked failed; queued ones run again.
        Remote mode: nothing to do, the jobs are in the database and running ones belong to their 打包机."""
        if self.remote:
            return
        with self.db.session() as s:
            for job in s.scalars(select(PackJob).where(PackJob.status == "running")):
                job.status, job.error, job.finished_at = "failed", "服务重启，任务中断", int(time.time())
            queued = list(s.scalars(select(PackJob.id).where(PackJob.status == "queued").order_by(PackJob.id)))
            s.commit()
        for jid in queued:
            self.queue.put_nowait(jid)

    def submit(self, job_id: int) -> None:
        if not self.remote:  # remote: the queued row is the queue
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
            if self.remote:  # the 打包机 sees it in its next heartbeat reply and stops the build
                job.cancel_requested = True
                s.commit()
                return True
        self.cancelled.add(job_id)
        if self.current == job_id and self.proc and self.proc.returncode is None:
            self.proc.terminate()
        return True

    def position(self, job_id: int) -> int | None:
        if self.remote:
            with self.db.session() as s:
                if s.scalar(select(PackJob.status).where(PackJob.id == job_id)) != "queued":
                    return None
                return s.scalar(select(func.count()).select_from(PackJob)
                                .where(PackJob.status == "queued", PackJob.id <= job_id)) or None
        items = list(self._queue._queue) if self._queue is not None else []  # type: ignore[attr-defined]
        return items.index(job_id) + 1 if job_id in items else None

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        if self.remote:
            while True:
                try:
                    await run_in_threadpool(self.reap)
                except Exception:  # pragma: no cover
                    log.exception("checking pack worker leases")
                await asyncio.sleep(self.reap_interval)
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

    # ------------------------------------------------------------ remote 打包机

    def _info(self, job: PackJob) -> dict[str, Any]:
        return {"app_id": job.app_id, "app_name": job.app_name, "version": job.version,
                "version_code": job.version_code, "project_name": job.project_name,
                "options": dict(job.options or {}), "created_by": job.created_by}

    def claim(self, worker_id: int, caps: dict[str, Any]) -> dict[str, Any] | None:
        """Hand the oldest queued job this worker can build to it, or None. Safe with several workers:
        the queued → running update only succeeds for one of them."""
        now = int(time.time())
        with self.db.session() as s:
            w = s.get(PackWorker, worker_id)
            if w is None or w.disabled:
                return None
            for job in s.scalars(select(PackJob).where(PackJob.status == "queued").order_by(PackJob.id).limit(50)).all():
                if (job.options or {}).get("release") and not caps.get("release"):
                    continue  # needs a keystore this machine does not have
                won = s.execute(update(PackJob).where(PackJob.id == job.id, PackJob.status == "queued").values(
                    status="running", worker_id=w.id, worker_name=w.name, started_at=now, heartbeat_at=now,
                    attempts=PackJob.attempts + 1, cancel_requested=False).execution_options(synchronize_session=False))
                if won.rowcount != 1:
                    continue
                s.refresh(job)
                audit(s, job.created_by or "system", "pack.claim", job.app_id,
                      {"job": job.id, "worker": w.name, "attempt": job.attempts})
                s.commit()
                self.append_log(job.id, "== 打包机「%s」开始构建（第 %d 次）\n" % (w.name, job.attempts))
                return {"id": job.id, **self._info(job), "has_icon": (self.job_dir(job.id) / "icon.png").is_file(),
                        "lease_s": self.lease_s}
        return None

    def _owned(self, s, worker_id: int, job_id: int) -> PackJob:
        job = s.get(PackJob, job_id)
        if job is None or job.status != "running" or job.worker_id != worker_id:
            raise WrongJob()
        return job

    def check_owner(self, worker_id: int, job_id: int) -> None:
        with self.db.session() as s:
            self._owned(s, worker_id, job_id)

    def heartbeat(self, worker_id: int, job_id: int, text: str = "") -> dict[str, Any]:
        """Extend the lease and append build output. Replies whether the job was cancelled."""
        with self.db.session() as s:
            job = self._owned(s, worker_id, job_id)
            job.heartbeat_at = int(time.time())
            cancel = bool(job.cancel_requested)
            s.commit()
        if text:
            self.append_log(job_id, text)
        return {"cancel": cancel, "lease_s": self.lease_s}

    def complete(self, worker_id: int, job_id: int, status: str, error: str | None,
                 apk: Path | None = None, apk_name: str = "") -> None:
        """The worker's result. A succeeded build brings its APK (already saved to a temp file)."""
        with self.db.session() as s:
            self._owned(s, worker_id, job_id)
        out = None
        if status == "succeeded":
            if apk is None:
                status, error = "failed", "打包机没有上传 APK"
            else:
                out_dir = self.job_dir(job_id) / "out"
                out_dir.mkdir(parents=True, exist_ok=True)
                out = out_dir / apk_name
                shutil.move(str(apk), out)
                error = None
        elif status == "cancelled":
            error = "已取消"
        self._finish(job_id, status, out, (error or "打包失败")[:2000] if status == "failed" else error)

    def reap(self, now: float | None = None) -> int:
        """Jobs whose 打包机 stopped sending heartbeats: queued again (once), else failed. Returns how many."""
        now = int(now or time.time())
        done: list[tuple[int, str, str]] = []
        with self.db.session() as s:
            stale = s.scalars(select(PackJob).where(
                PackJob.status == "running", PackJob.worker_id.is_not(None),
                func.coalesce(PackJob.heartbeat_at, PackJob.started_at, 0) < now - self.lease_s)).all()
            for job in stale:
                who = job.worker_name or "?"
                if job.cancel_requested:
                    done.append((job.id, "cancelled", "已取消"))
                elif job.attempts < self.max_attempts:
                    job.status, job.worker_id, job.started_at, job.heartbeat_at = "queued", None, None, None
                    audit(s, "system", "pack.requeue", job.app_id, {"job": job.id, "worker": who})
                    self.append_log(job.id, "== 打包机「%s」失联超过 %d 秒，任务重新排队\n" % (who, self.lease_s))
                else:
                    done.append((job.id, "failed", "打包机「%s」失联，任务中断" % who))
            s.commit()
        for job_id, status, error in done:
            self.append_log(job_id, "== %s\n" % error)
            self._finish(job_id, status, None, error)
        return len(stale)

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
        signing = (self.config.keystore, self.config.key_alias, self.config.store_pass, self.config.key_pass) \
            if self.config.release_signing else None
        return pack_command(sys.executable, Path(self.config.pack_script), self.job_dir(job_id), info, project, signing)

    async def _cancelled(self, job_id: int, say) -> None:
        self.cancelled.discard(job_id)
        say("cancelled")
        await run_in_threadpool(self._finish, job_id, "cancelled", None, "已取消")

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
            for line in redacted_command(args, env):
                say(line)
            # The job shows "running" from _start on, but there is no process to terminate until it has been spawned:
            # a cancel in that gap only marks the job, so honour the mark on both sides of the spawn. Otherwise the
            # build ran to the end (minutes for a real build) before the cancel took effect.
            if job_id in self.cancelled:
                await self._cancelled(job_id, say)
                return
            self.proc = await asyncio.create_subprocess_exec(
                *args, stdout=logf, stderr=asyncio.subprocess.STDOUT, env=env, cwd=str(d),
                start_new_session=True)
            if job_id in self.cancelled and self.proc.returncode is None:
                self.proc.terminate()
            code = await self.proc.wait()
            if job_id in self.cancelled:
                await self._cancelled(job_id, say)
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
