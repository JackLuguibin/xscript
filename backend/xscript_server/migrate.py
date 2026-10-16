"""Schema migrations for the SQLite database.

`create_all` only creates missing tables. Columns added to existing tables after a release
need a numbered step here; the applied version is kept in `PRAGMA user_version`.

Steps run in order inside one transaction each and must be idempotent (check before ALTER),
so a database created by `create_all` at the latest version is also valid.
"""

from __future__ import annotations

import logging
from typing import Callable

from sqlalchemy import inspect, text
from sqlalchemy.engine import Connection

log = logging.getLogger("xscript.migrate")


def _add_column(conn: Connection, table: str, column: str, ddl: str) -> None:
    cols = {c["name"] for c in inspect(conn).get_columns(table)}
    if column not in cols:
        conn.execute(text("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, ddl)))


def _v1(conn: Connection) -> None:
    """0.3 baseline (tables come from create_all)."""


def _v2(conn: Connection) -> None:
    """0.4: 小程序 bundle download counter, device crash report."""
    _add_column(conn, "script_versions", "downloads", "INTEGER NOT NULL DEFAULT 0")
    _add_column(conn, "devices", "last_run", "JSON")


def _v3(conn: Connection) -> None:
    """0.5: 两步验证 columns (device_logs is a new table from create_all)."""
    _add_column(conn, "users", "totp_secret", "VARCHAR(64)")
    _add_column(conn, "users", "totp_enabled", "BOOLEAN NOT NULL DEFAULT 0")
    _add_column(conn, "users", "totp_last_step", "INTEGER")


def _v4(conn: Connection) -> None:
    """0.6: 体验卡 / 多设备卡 / 续期叠加 columns (card_devices and trial_uses come from create_all)."""
    _add_column(conn, "cards", "kind", "VARCHAR(8) NOT NULL DEFAULT 'normal'")
    _add_column(conn, "cards", "max_devices", "INTEGER NOT NULL DEFAULT 1")
    _add_column(conn, "cards", "stack", "BOOLEAN NOT NULL DEFAULT 1")


def _v5(conn: Connection) -> None:
    """0.7: 按次卡 use counters."""
    _add_column(conn, "cards", "uses_total", "INTEGER NOT NULL DEFAULT 0")
    _add_column(conn, "cards", "uses_left", "INTEGER NOT NULL DEFAULT 0")


STEPS: list[Callable[[Connection], None]] = [_v1, _v2, _v3, _v4, _v5]
LATEST = len(STEPS)


def current(conn: Connection) -> int:
    return int(conn.execute(text("PRAGMA user_version")).scalar() or 0)


def migrate(engine) -> tuple[int, int]:
    """Bring the database to LATEST. Returns (from, to). Refuses databases from a newer release."""
    with engine.begin() as conn:
        start = current(conn)
    if start > LATEST:
        raise RuntimeError("数据库版本 %d 比这个程序支持的 %d 新，请升级 xscript-server" % (start, LATEST))
    for version in range(start + 1, LATEST + 1):
        with engine.begin() as conn:
            STEPS[version - 1](conn)
            conn.execute(text("PRAGMA user_version = %d" % version))
        log.info("database migrated to v%d", version)
    return start, LATEST
