"""Backups of the data directory and storage retention.

A backup is one .tar.gz with a consistent copy of the database (SQLite online backup, safe
while the server runs), the 卡密 signing key and the 小程序 sources. Pack outputs (APKs,
build logs) are left out: they can be rebuilt and are large.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select

from . import __version__
from .config import Config
from .db import Database
from .migrate import LATEST
from .models import AuditLog, DeviceLog, PackJob, ShareLink

MANIFEST = "xscript-backup.json"


def _sqlite_copy(src: Path, dest: Path) -> None:
    with sqlite3.connect(src) as a, sqlite3.connect(dest) as b:
        a.backup(b)


def create_backup(cfg: Config, out: Path | None = None) -> Path:
    """Write <data>/backups/xscript-<time>.tar.gz (or `out`). Blocking."""
    out = out or cfg.backup_dir / time.strftime("xscript-%Y%m%d-%H%M%S.tar.gz")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    with tempfile.TemporaryDirectory(prefix="xs-backup-") as td:
        db_copy = Path(td) / "xscript.db"
        _sqlite_copy(cfg.db_path, db_copy)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # holds the signing key
        with os.fdopen(fd, "wb") as f, tarfile.open(fileobj=f, mode="w:gz") as tar:
            meta = {"version": __version__, "schema": LATEST, "created_at": int(time.time())}
            data = json.dumps(meta).encode()
            info = tarfile.TarInfo(MANIFEST)
            info.size, info.mtime = len(data), int(time.time())
            tar.addfile(info, io.BytesIO(data))
            tar.add(db_copy, "xscript.db")
            if cfg.key_path.is_file():
                tar.add(cfg.key_path, "keys/private.pem")
            if cfg.scripts_dir.is_dir():
                # Source zips only; bundles are rebuilt on demand.
                for p in sorted(cfg.scripts_dir.rglob("source.zip")):
                    tar.add(p, "scripts/" + p.relative_to(cfg.scripts_dir).as_posix())
    tmp.replace(out)
    return out


def _safe_members(tar: tarfile.TarFile):
    for m in tar.getmembers():
        name = m.name
        if name.startswith("/") or ".." in Path(name).parts or not (m.isfile() or m.isdir()):
            raise ValueError("备份里有不安全的路径: %s" % name)
        yield m


def read_manifest(path: Path) -> dict[str, Any]:
    with tarfile.open(path, "r:gz") as tar:
        f = tar.extractfile(MANIFEST)
        if f is None:
            raise ValueError("不是 xscript 备份文件")
        return json.loads(f.read())


def restore_backup(cfg: Config, path: Path, force: bool = False) -> dict[str, Any]:
    """Replace the database, signing key and 小程序 sources. The server must be stopped."""
    meta = read_manifest(path)
    if int(meta.get("schema", 0)) > LATEST:
        raise ValueError("备份来自更新的版本（schema %s），请先升级 xscript-server" % meta.get("schema"))
    if cfg.db_path.exists() and not force:
        raise ValueError("数据目录里已有数据库 %s；确认要覆盖请加 --force" % cfg.db_path)
    cfg.ensure_dirs()
    with tempfile.TemporaryDirectory(prefix="xs-restore-", dir=cfg.data_dir) as td:
        with tarfile.open(path, "r:gz") as tar:
            tar.extractall(td, members=list(_safe_members(tar)), filter="data")
        root = Path(td)
        if not (root / "xscript.db").is_file():
            raise ValueError("备份里没有数据库")
        for suffix in ("", "-wal", "-shm"):
            Path(str(cfg.db_path) + suffix).unlink(missing_ok=True)
        shutil.move(str(root / "xscript.db"), cfg.db_path)
        if (root / "keys/private.pem").is_file():
            cfg.key_path.parent.mkdir(parents=True, exist_ok=True)
            cfg.key_path.unlink(missing_ok=True)
            shutil.move(str(root / "keys/private.pem"), cfg.key_path)
            os.chmod(cfg.key_path, 0o600)
        if (root / "scripts").is_dir():
            shutil.rmtree(cfg.scripts_dir, ignore_errors=True)
            shutil.move(str(root / "scripts"), cfg.scripts_dir)
    Database(cfg.db_path).create_all()  # migrate an older backup forward
    return meta


def list_backups(cfg: Config) -> list[dict[str, Any]]:
    if not cfg.backup_dir.is_dir():
        return []
    out = []
    for p in sorted(cfg.backup_dir.glob("xscript-*.tar.gz"), reverse=True):
        st = p.stat()
        out.append({"name": p.name, "size": st.st_size, "created_at": int(st.st_mtime)})
    return out


def prune_backups(cfg: Config, keep: int) -> int:
    items = sorted(cfg.backup_dir.glob("xscript-*.tar.gz")) if cfg.backup_dir.is_dir() else []
    victims = items[:-keep] if keep > 0 else []
    for p in victims:
        p.unlink(missing_ok=True)
    return len(victims)


class Maintainer:
    """Background loop: daily backup + retention at backup_hour, offline and 卡密 stock alerts."""

    CARDS_LOW = 20

    def __init__(self, cfg: Config, db: Database, hub, alerts, interval: float = 60.0):
        self.cfg, self.db, self.hub, self.alerts, self.interval = cfg, db, hub, alerts, interval
        self.last_backup: dict[str, Any] | None = None
        self.last_retention: dict[str, Any] | None = None
        self._done_day = ""
        self.pending: list[tuple[str, str, str]] = []  # alerts found in the worker thread

    def tick(self, now: float | None = None) -> None:
        """One pass; blocking (call in a thread)."""
        from .audit import audit, get_settings
        from .models import Card

        now = now or time.time()
        with self.db.session() as s:
            policy = get_settings(s)
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        hour = time.localtime(now).tm_hour
        if day != self._done_day and hour >= int(policy.get("backup_hour") or 0):
            self._done_day = day
            if policy.get("backup_daily"):
                try:
                    path = create_backup(self.cfg)
                    self.last_backup = {"time": int(now), "name": path.name, "ok": True}
                except Exception as e:
                    self.last_backup = {"time": int(now), "ok": False, "error": str(e)[:300]}
            res = run_retention(self.cfg, self.db, policy, now)
            self.last_retention = {"time": int(now), **res}
            with self.db.session() as s:
                audit(s, "system", "system.maintenance", day, {"backup": self.last_backup, "retention": res})
                s.commit()
            # 卡密 stock: one check a day is enough.
            with self.db.session() as s:
                unused = s.query(Card).filter(Card.device.is_(None), Card.activated_at.is_(None),
                                              Card.revoked.is_(False)).count()
            if unused < self.CARDS_LOW:
                self.pending.append(("cards_low", "库存", "未使用的卡密只剩 %d 张" % unused))

    async def loop(self) -> None:
        import asyncio

        from starlette.concurrency import run_in_threadpool

        while True:
            await asyncio.sleep(self.interval)
            try:
                await run_in_threadpool(self.tick)
                for event, subject, text in self.pending:
                    self.alerts.emit(event, subject, text)
                self.pending.clear()
                self.hub.check_offline()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover
                import logging

                logging.getLogger("xscript.maint").exception("maintenance tick failed")


# ---------------------------------------------------------------- retention

def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def disk_usage(cfg: Config) -> dict[str, int]:
    db = sum(dir_size(Path(str(cfg.db_path) + s)) for s in ("", "-wal", "-shm"))
    return {"database": db, "pack": dir_size(cfg.pack_dir), "scripts": dir_size(cfg.scripts_dir),
            "backups": dir_size(cfg.backup_dir)}


def run_retention(cfg: Config, db: Database, policy: dict[str, Any], now: float | None = None) -> dict[str, int]:
    """Apply the 存储清理 settings. Returns counts of what was removed."""
    now = now or time.time()
    out = {"apks": 0, "audit": 0, "shares": 0, "backups": 0, "device_logs": 0}
    keep_jobs = int(policy.get("keep_pack_jobs") or 0)
    audit_days = int(policy.get("audit_days") or 0)
    with db.session() as s:
        if keep_jobs > 0:
            done = list(s.scalars(select(PackJob).where(PackJob.status.in_(("succeeded", "failed", "cancelled")))
                                  .order_by(PackJob.id.desc())))
            for j in done[keep_jobs:]:
                # Keep the row (history, audit) but drop the files.
                d = cfg.pack_dir / str(j.id)
                if d.exists():
                    shutil.rmtree(d, ignore_errors=True)
                    out["apks"] += 1
                if j.apk_file:
                    j.apk_file = None
        if audit_days > 0:
            res = s.execute(delete(AuditLog).where(AuditLog.time < int(now - audit_days * 86400)))
            out["audit"] = res.rowcount or 0
        # 设备运行日志: ts is in ms. 0 days means "don't keep", so anything left over goes.
        log_days = int(policy.get("device_log_days") or 0)
        cutoff_ms = int((now - log_days * 86400) * 1000)
        res = s.execute(delete(DeviceLog).where(DeviceLog.ts < cutoff_ms))
        out["device_logs"] = res.rowcount or 0
        res = s.execute(delete(ShareLink).where(ShareLink.expires_at.is_not(None),
                                                ShareLink.expires_at < int(now - 7 * 86400)))
        out["shares"] = res.rowcount or 0
        s.commit()
    out["backups"] = prune_backups(cfg, int(policy.get("keep_backups") or 0))
    return out
