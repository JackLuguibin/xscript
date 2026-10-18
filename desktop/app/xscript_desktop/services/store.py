"""Application database: saved devices, settings, and the sync hash cache (design §14.5).

SQLite lives at ``<data dir>/desktop.db`` (macOS: ``~/Library/Application Support/XScript/desktop.db``).
Every statement runs on one dedicated thread — the design's ``ThreadPoolExecutor(max_workers=1)``.
The thread is a daemon so a store a test forgets to close cannot hang process exit. Callers use
``submit`` / ``run_in_executor``; the GUI thread never touches the connection.

No secrets. Settings keys that look like tokens or passwords are rejected. The devices table has
no column for them, and an adb row stores the serial, never the auto-assigned forward port.
"""
from __future__ import annotations

import asyncio
import json
import queue
import re
import shutil
import sqlite3
import threading
import time
from concurrent.futures import Executor, Future
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .sync import safe_relative

SCHEMA_VERSION = 2
_SECRET_KEY = re.compile(r"(secret|token|password|passwd|credential|api[_-]?key)", re.I)
_SHA1 = re.compile(r"[0-9a-f]{40}")
_TEXT_LIMITS = {"name": 80, "grp": 80, "note": 500}

# schema v1, design §14.5. One statement each so it can sit inside a single transaction.
_V1 = (
    """CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL DEFAULT '',
        grp          TEXT NOT NULL DEFAULT '',
        transport    TEXT NOT NULL CHECK (transport IN ('adb','lan','relay')),
        address      TEXT NOT NULL,
        device_id    TEXT NOT NULL DEFAULT '',
        model        TEXT NOT NULL DEFAULT '',
        note         TEXT NOT NULL DEFAULT '',
        auto_connect INTEGER NOT NULL DEFAULT 0 CHECK (auto_connect IN (0,1)),
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   REAL NOT NULL,
        last_seen    REAL,
        UNIQUE (transport, address)
    )""",
    "CREATE INDEX devices_grp ON devices(grp)",
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE sync_cache (
        device_key TEXT NOT NULL,
        project    TEXT NOT NULL,
        path       TEXT NOT NULL,
        sha1       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        PRIMARY KEY (device_key, project, path)
    ) WITHOUT ROWID""",
)

_V2 = (
    """CREATE TABLE runs (
        id         INTEGER PRIMARY KEY,
        flow       TEXT NOT NULL,
        project    TEXT NOT NULL DEFAULT '',
        device_id  TEXT NOT NULL DEFAULT '',
        started_at REAL NOT NULL,
        ended_at   REAL NOT NULL,
        status     TEXT NOT NULL,
        error_node TEXT NOT NULL DEFAULT '',
        error_line INTEGER,
        exit_code  INTEGER
    )""",
    """CREATE TABLE run_nodes (
        run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq      INTEGER NOT NULL,
        node     TEXT NOT NULL,
        enter_ms REAL,
        exit_ms  REAL,
        summary  TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, seq)
    ) WITHOUT ROWID""",
)


class StoreError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class SavedDevice:
    id: str
    name: str
    grp: str
    transport: str
    address: str
    device_id: str
    model: str
    note: str
    auto_connect: int
    sort_order: int
    created_at: float
    last_seen: float | None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "SavedDevice":
        return cls(
            id=row["id"], name=row["name"], grp=row["grp"], transport=row["transport"], address=row["address"],
            device_id=row["device_id"], model=row["model"], note=row["note"], auto_connect=row["auto_connect"],
            sort_order=row["sort_order"], created_at=row["created_at"], last_seen=row["last_seen"],
        )


def split_cache_key(key: str) -> tuple[str, str]:
    """``<device key>:<project>`` as stored by the old JSON cache. Project names contain no colon."""
    device_key, sep, project = (key or "").rpartition(":")
    if not sep or not device_key or not project or "/" in project or "\\" in project or "\0" in key:
        raise ValueError("invalid sync cache key: %r" % key)
    return device_key, project


class _DbThread(Executor):
    """One worker. ``loop.run_in_executor`` only needs ``submit``."""

    def __init__(self) -> None:
        self._q: queue.Queue = queue.Queue()
        self._closed = False
        self._t = threading.Thread(target=self._loop, name="xscript-db", daemon=True)
        self._t.start()

    def _loop(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            fn, fut = item
            if not fut.set_running_or_notify_cancel():
                continue
            try:
                fut.set_result(fn())
            except BaseException as exc:  # noqa: BLE001 - the future carries it back to the caller
                fut.set_exception(exc)

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future:  # type: ignore[override]
        if self._closed:
            raise RuntimeError("store is closed")
        fut: Future = Future()
        self._q.put((lambda: fn(*args, **kwargs), fut))
        return fut

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        self._q.put(None)
        if wait:
            self._t.join(timeout=5)


class AppStore:
    def __init__(self, path: Path | None, legacy_cache: Path | None = None) -> None:
        self.path = path
        self.notice = ""  # "" | "db.corrupt" | "db.newer"
        self.notice_detail = ""
        self.read_only = False
        self.user_version = 0
        self._legacy = legacy_cache
        self._existed = False
        self._conn: sqlite3.Connection | None = None
        self._worker = 0
        self._closed = False
        self._pool = _DbThread()
        try:
            self._pool.submit(self._open).result()
        except Exception:
            self._pool.shutdown(wait=True)
            raise

    # ---- threading ----------------------------------------------------------------------------------------------------------------

    def submit(self, fn: Callable[..., Any], *args: Any) -> Any:
        if threading.get_ident() == self._worker:
            raise RuntimeError("store.submit called from the store thread (would deadlock)")
        return self._pool.submit(fn, *args).result()

    async def aexec(self, fn: Callable[..., Any], *args: Any) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, lambda: fn(*args))

    def worker_ident(self) -> int:
        return self.submit(lambda: threading.get_ident())

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._pool.submit(self._close_conn).result(timeout=5)
        except Exception:
            pass
        self._pool.shutdown(wait=True)

    def _close_conn(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def _guard(self) -> sqlite3.Connection:
        if threading.get_ident() != self._worker:
            raise RuntimeError("sqlite must run on the store thread")
        assert self._conn is not None
        return self._conn

    def _writable(self) -> None:
        if self.read_only:
            raise StoreError("db.newer", "数据库来自更新的版本")

    # ---- open / migrate / quarantine ----------------------------------------------------------------------------------------------

    def _open(self) -> None:
        self._worker = threading.get_ident()
        if self.path is None:
            self._conn = sqlite3.connect(":memory:", check_same_thread=True)
            self._prepare(self._conn)
            self._migrate(0)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._existed = self.path.is_file() and self.path.stat().st_size > 0
        if self._existed and not _quick_ok(self.path):
            dest = _quarantine(self.path)
            self.notice = "db.corrupt"
            self.notice_detail = dest.name
            self._existed = False
        self._conn = sqlite3.connect(self.path, check_same_thread=True)
        self._prepare(self._conn)
        ver = int(self._conn.execute("PRAGMA user_version").fetchone()[0])
        if ver > SCHEMA_VERSION:
            self._become_readonly(ver)
            return
        if ver < SCHEMA_VERSION:
            self._migrate(ver)
        else:
            self.user_version = ver
        self._import_legacy()

    def _prepare(self, conn: sqlite3.Connection) -> None:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        if self.path is not None:
            conn.execute("PRAGMA journal_mode = WAL")

    def _become_readonly(self, ver: int) -> None:
        assert self.path is not None and self._conn is not None
        self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self._conn.close()
        uri = self.path.resolve().as_uri() + "?mode=ro"
        self._conn = sqlite3.connect(uri, uri=True, check_same_thread=True)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA query_only = ON")
        self._conn.execute("PRAGMA foreign_keys = ON")
        self.read_only = True
        self.user_version = ver
        self.notice = "db.newer"
        self.notice_detail = ""

    def _migrate(self, frm: int) -> None:
        assert self._conn is not None
        if self.path is not None and self._existed and frm < SCHEMA_VERSION:
            self._backup(frm)
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            if frm < 1:
                for sql in _V1:
                    conn.execute(sql)
                conn.execute("PRAGMA user_version = 1")
            if frm < 2:
                for sql in _V2:
                    conn.execute(sql)
                conn.execute("PRAGMA user_version = 2")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        self.user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])

    def _backup(self, version: int) -> None:
        assert self.path is not None and self._conn is not None
        self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dest = self.path.with_name("%s.bak-v%d" % (self.path.name, version))
        shutil.copy2(self.path, dest)

    def _import_legacy(self) -> None:
        """One-shot import of the pre-SQLite ``sync-cache.json`` (``<device key>:<project>`` → {path: sha1})."""
        path = self._legacy
        if path is None or not path.is_file() or self.read_only or self._conn is None:
            return
        try:
            raw = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict):
            path.replace(path.with_name(path.name + ".migrated"))
            return
        conn = self._conn
        for key, files in raw.items():
            if not isinstance(key, str) or not isinstance(files, dict):
                continue
            try:
                device_key, project = split_cache_key(key)
            except ValueError:
                continue
            for rel, sha in files.items():
                if not isinstance(rel, str) or not isinstance(sha, str) or not safe_relative(rel) or not _SHA1.fullmatch(sha):
                    continue
                conn.execute(
                    "INSERT OR IGNORE INTO sync_cache (device_key, project, path, sha1, size) VALUES (?,?,?,?,0)",
                    (device_key, project, rel, sha),
                )
        conn.commit()
        path.replace(path.with_name(path.name + ".migrated"))

    # ---- devices ------------------------------------------------------------------------------------------------------------------

    def list_devices(self) -> list[SavedDevice]:
        return self.submit(self._list_devices)

    def get(self, device_id: str) -> SavedDevice | None:
        return self.submit(self._get, device_id)

    def remember(self, device_id: str, transport: str, address: str, device_uid: str, model: str, last_seen: float,
                 auto_connect: bool = False) -> SavedDevice:
        return self.submit(self._remember, device_id, transport, address, device_uid, model, last_seen, auto_connect)

    def update(self, device_id: str, fields: dict[str, Any]) -> SavedDevice:
        return self.submit(self._update, device_id, fields)

    def forget(self, device_id: str) -> bool:
        return self.submit(self._forget, device_id)

    def forget_all(self) -> int:
        return self.submit(self._forget_all)

    def auto_connect(self) -> list[SavedDevice]:
        return self.submit(self._auto_connect)

    def touch(self, device_id: str, device_uid: str, model: str, last_seen: float) -> None:
        self.submit(self._touch, device_id, device_uid, model, last_seen)

    def dump_devices(self) -> str:
        """Text of the identity columns. Tests use it to prove a forward port was not stored."""
        return self.submit(self._dump_devices)

    def _list_devices(self) -> list[SavedDevice]:
        conn = self._guard()
        rows = conn.execute("SELECT * FROM devices ORDER BY sort_order, name, id").fetchall()
        return [SavedDevice.from_row(r) for r in rows]

    def _get(self, device_id: str) -> SavedDevice | None:
        conn = self._guard()
        row = conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        return SavedDevice.from_row(row) if row is not None else None

    def _remember(self, device_id: str, transport: str, address: str, device_uid: str, model: str, last_seen: float,
                  auto_connect: bool = False) -> SavedDevice:
        """Insert or refresh the row of a device that just connected. `auto_connect` only applies to a NEW row: an
        existing row keeps whatever the user chose (design §14.5: first connect opts the device in to auto-reconnect)."""
        conn = self._guard()
        self._writable()
        _check_identity(device_id, transport, address)
        now = float(last_seen or time.time())
        try:
            row = conn.execute("SELECT id FROM devices WHERE id = ?", (device_id,)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO devices (id, transport, address, device_id, model, created_at, last_seen, auto_connect) VALUES (?,?,?,?,?,?,?,?)",
                    (device_id, transport, address, device_uid or "", model or "", now, now, 1 if auto_connect else 0),
                )
            else:
                conn.execute(
                    "UPDATE devices SET transport=?, address=?, device_id=?, model=CASE WHEN ? != '' THEN ? ELSE model END, last_seen=? WHERE id=?",
                    (transport, address, device_uid or "", model or "", model or "", now, device_id),
                )
            conn.commit()
        except sqlite3.IntegrityError as e:
            conn.rollback()
            raise StoreError("db.constraint", "设备已存在或字段不合法") from e
        saved = self._get(device_id)
        assert saved is not None
        return saved

    def _update(self, device_id: str, fields: dict[str, Any]) -> SavedDevice:
        conn = self._guard()
        self._writable()
        if self._get(device_id) is None:
            raise StoreError("db.not_found", "没有这台已保存设备: %s" % device_id)
        sets: list[str] = []
        args: list[Any] = []
        for key, value in fields.items():
            if key in _TEXT_LIMITS:
                if not isinstance(value, str) or "\0" in value or len(value) > _TEXT_LIMITS[key]:
                    raise StoreError("db.bad_params", "%s 过长或含有非法字符" % key)
                sets.append("%s = ?" % key)
                args.append(value)
            elif key == "auto_connect":
                if isinstance(value, bool):
                    value = 1 if value else 0
                if value not in (0, 1):
                    raise StoreError("db.bad_params", "auto_connect 只能是 0 或 1")
                sets.append("auto_connect = ?")
                args.append(value)
            elif key == "sort_order":
                if isinstance(value, bool) or not isinstance(value, int) or not -1_000_000 <= value <= 1_000_000:
                    raise StoreError("db.bad_params", "sort_order 超出范围")
                sets.append("sort_order = ?")
                args.append(value)
            else:
                raise StoreError("db.bad_params", "不能修改字段: %s" % key)
        if not sets:
            raise StoreError("db.bad_params", "没有要修改的字段")
        args.append(device_id)
        conn.execute("UPDATE devices SET %s WHERE id = ?" % ", ".join(sets), args)
        conn.commit()
        saved = self._get(device_id)
        assert saved is not None
        return saved

    def _forget(self, device_id: str) -> bool:
        conn = self._guard()
        self._writable()
        cur = conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        conn.commit()
        return cur.rowcount > 0

    def _forget_all(self) -> int:
        conn = self._guard()
        self._writable()
        cur = conn.execute("DELETE FROM devices")
        conn.commit()
        return cur.rowcount

    def _auto_connect(self) -> list[SavedDevice]:
        conn = self._guard()
        rows = conn.execute("SELECT * FROM devices WHERE auto_connect = 1 ORDER BY sort_order, name, id").fetchall()
        return [SavedDevice.from_row(r) for r in rows]

    def _touch(self, device_id: str, device_uid: str, model: str, last_seen: float) -> None:
        conn = self._guard()
        self._writable()
        conn.execute(
            "UPDATE devices SET last_seen=?, device_id=CASE WHEN ? != '' THEN ? ELSE device_id END, "
            "model=CASE WHEN ? != '' THEN ? ELSE model END WHERE id=?",
            (float(last_seen), device_uid or "", device_uid or "", model or "", model or "", device_id),
        )
        conn.commit()

    def _dump_devices(self) -> str:
        conn = self._guard()
        rows = conn.execute("SELECT id, transport, address, device_id, model, note FROM devices ORDER BY id").fetchall()
        return "\n".join("|".join("" if v is None else str(v) for v in row) for row in rows)

    # ---- settings -----------------------------------------------------------------------------------------------------------------

    def get_setting(self, key: str) -> str | None:
        return self.submit(self._get_setting, key)

    def set_setting(self, key: str, value: str) -> None:
        self.submit(self._set_setting, key, value)

    def delete_setting(self, key: str) -> None:
        self.submit(self._delete_setting, key)

    def record_run(self, flow: str, nodes: list[dict[str, Any]], *, started_at: float, ended_at: float,
                   status: str = "success", project: str = "", device_id: str = "",
                   error_node: str = "", error_line: int | None = None, exit_code: int | None = None) -> int:
        return self.submit(
            self._record_run, flow, nodes, started_at, ended_at, status, project, device_id, error_node, error_line, exit_code,
        )

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        return self.submit(self._list_runs, limit)

    def _record_run(self, flow: str, nodes: list[dict[str, Any]], started_at: float, ended_at: float, status: str,
                    project: str, device_id: str, error_node: str, error_line: int | None, exit_code: int | None) -> int:
        conn = self._guard()
        self._writable()
        if status not in ("success", "error"):
            raise StoreError("db.bad_params", "运行状态不合法")
        cur = conn.execute(
            "INSERT INTO runs (flow, project, device_id, started_at, ended_at, status, error_node, error_line, exit_code) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (flow, project, device_id, float(started_at), float(ended_at), status, error_node, error_line, exit_code),
        )
        run_id = int(cur.lastrowid)
        for index, node in enumerate(nodes):
            conn.execute(
                "INSERT INTO run_nodes (run_id, seq, node, enter_ms, exit_ms, summary) VALUES (?, ?, ?, ?, ?, ?)",
                (run_id, index + 1, str(node.get("node", "")), node.get("enter_ms"), node.get("exit_ms"), str(node.get("summary", ""))),
            )
        conn.commit()
        return run_id

    def _list_runs(self, limit: int) -> list[dict[str, Any]]:
        conn = self._guard()
        rows = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (int(limit),)).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            nodes = conn.execute(
                "SELECT seq, node, enter_ms, exit_ms, summary FROM run_nodes WHERE run_id = ? ORDER BY seq", (row["id"],),
            ).fetchall()
            out.append({
                "id": row["id"], "flow": row["flow"], "project": row["project"], "device_id": row["device_id"],
                "started_at": row["started_at"], "ended_at": row["ended_at"], "status": row["status"],
                "error_node": row["error_node"], "error_line": row["error_line"], "exit_code": row["exit_code"],
                "nodes": [dict(item) for item in nodes],
            })
        return out

    def _get_setting(self, key: str) -> str | None:
        conn = self._guard()
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return None if row is None else str(row["value"])

    def _set_setting(self, key: str, value: str) -> None:
        conn = self._guard()
        self._writable()
        if not isinstance(key, str) or not key or len(key) > 64 or "\0" in key or _SECRET_KEY.search(key):
            raise StoreError("db.secret", "密钥不能写入应用数据库")
        if not isinstance(value, str) or "\0" in value or len(value) > 4096:
            raise StoreError("db.bad_params", "设置值不合法")
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()

    def _delete_setting(self, key: str) -> None:
        conn = self._guard()
        self._writable()
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        conn.commit()

    # ---- sync cache ----------------------------------------------------------------------------------------------------------------

    def cache_get(self, device_key: str, project: str) -> dict[str, str]:
        return self.submit(self._cache_get, device_key, project)

    def cache_put(self, device_key: str, project: str, hashes: dict[str, str], sizes: dict[str, int] | None = None) -> None:
        self.submit(self._cache_put, device_key, project, hashes, sizes or {})

    def cache_entries(self, device_key: str, project: str) -> list[tuple[str, str, int]]:
        return self.submit(self._cache_entries, device_key, project)

    def _cache_get(self, device_key: str, project: str) -> dict[str, str]:
        conn = self._guard()
        rows = conn.execute(
            "SELECT path, sha1 FROM sync_cache WHERE device_key = ? AND project = ? ORDER BY path", (device_key, project),
        ).fetchall()
        return {r["path"]: r["sha1"] for r in rows}

    def _cache_entries(self, device_key: str, project: str) -> list[tuple[str, str, int]]:
        conn = self._guard()
        rows = conn.execute(
            "SELECT path, sha1, size FROM sync_cache WHERE device_key = ? AND project = ? ORDER BY path", (device_key, project),
        ).fetchall()
        return [(r["path"], r["sha1"], r["size"]) for r in rows]

    def _cache_put(self, device_key: str, project: str, hashes: dict[str, str], sizes: dict[str, int]) -> None:
        conn = self._guard()
        self._writable()
        if not device_key or not project or "\0" in device_key or "\0" in project or len(device_key) > 256 or len(project) > 128:
            raise StoreError("db.bad_params", "同步缓存的设备或工程名不合法")
        try:
            conn.execute("DELETE FROM sync_cache WHERE device_key = ? AND project = ?", (device_key, project))
            for rel, sha in hashes.items():
                if not isinstance(rel, str) or not safe_relative(rel) or not isinstance(sha, str) or not _SHA1.fullmatch(sha):
                    raise StoreError("db.bad_params", "同步缓存路径或哈希不合法: %r" % rel)
                size = sizes.get(rel, 0)
                if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                    raise StoreError("db.bad_params", "同步缓存的文件大小不合法")
                conn.execute(
                    "INSERT INTO sync_cache (device_key, project, path, sha1, size) VALUES (?,?,?,?,?)",
                    (device_key, project, rel, sha, size),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    # ---- introspection (tests) ----------------------------------------------------------------------------------------------------

    def pragma(self, name: str) -> Any:
        if name not in ("journal_mode", "foreign_keys", "user_version", "quick_check", "query_only"):
            raise StoreError("db.bad_params", "unknown pragma")
        return self.submit(self._pragma, name)

    def _pragma(self, name: str) -> Any:
        conn = self._guard()
        return conn.execute("PRAGMA %s" % name).fetchone()[0]

    def columns(self, table: str) -> list[str]:
        if table not in ("devices", "settings", "sync_cache"):
            raise StoreError("db.bad_params", "unknown table")
        return self.submit(self._columns, table)

    def _columns(self, table: str) -> list[str]:
        conn = self._guard()
        return [r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]

    def exec_sql(self, sql: str, args: tuple = ()) -> None:
        """Run one statement on the worker. Tests use it to poke CHECK / UNIQUE."""
        self.submit(self._exec_sql, sql, args)

    def _exec_sql(self, sql: str, args: tuple) -> None:
        conn = self._guard()
        self._writable()
        try:
            conn.execute(sql, args)
            conn.commit()
        except sqlite3.IntegrityError:
            conn.rollback()
            raise


class StoreSyncCache:
    """Same ``get`` / ``put`` shape as the old JSON ``SyncCache``, backed by the ``sync_cache`` table."""

    def __init__(self, store: AppStore) -> None:
        self.store = store
        self.path = store.path

    def get(self, key: str) -> dict[str, str]:
        device_key, project = split_cache_key(key)
        return self.store.cache_get(device_key, project)

    def put(self, key: str, hashes: dict[str, str], sizes: dict[str, int] | None = None) -> None:
        device_key, project = split_cache_key(key)
        self.store.cache_put(device_key, project, hashes, sizes)


def _check_identity(device_id: str, transport: str, address: str) -> None:
    if transport not in ("adb", "lan", "relay"):
        raise StoreError("db.bad_params", "未知的传输方式: %s" % transport)
    if not device_id or not address or "\0" in device_id or "\0" in address or len(address) > 256:
        raise StoreError("db.bad_params", "设备标识不合法")
    if device_id != "%s:%s" % (transport, address):
        raise StoreError("db.bad_params", "设备 id 必须是 %s:<地址>" % transport)
    # the forward port is reallocated on every connect; storing it would reconnect to a dead port (design §14.5)
    if transport == "adb" and re.fullmatch(r"(127\.0\.0\.1|localhost|\[::1\]):\d+", address):
        raise StoreError("db.bad_params", "adb 地址必须是序列号，不能是本地转发端口")


def _quick_ok(path: Path) -> bool:
    try:
        conn = sqlite3.connect(path)
    except sqlite3.DatabaseError:
        return False
    try:
        row = conn.execute("PRAGMA quick_check").fetchone()
        return row is not None and row[0] == "ok"
    except sqlite3.DatabaseError:
        return False
    finally:
        conn.close()


def _quarantine(path: Path) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = path.with_name(path.name + ".corrupt-" + stamp)
    n = 0
    while dest.exists():
        n += 1
        dest = path.with_name("%s.corrupt-%s-%d" % (path.name, stamp, n))
    extras = [(Path(str(path) + suffix), Path(str(dest) + suffix)) for suffix in ("-wal", "-shm")]
    path.rename(dest)
    for src, dst in extras:
        if src.exists():
            src.rename(dst)
    return dest
