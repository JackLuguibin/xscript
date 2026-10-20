"""Schema migrations (SQLite and PostgreSQL).

`create_all` only creates missing tables. Columns added to existing tables after a release
need a numbered step here. The applied version is kept in `PRAGMA user_version` on SQLite and in
the one-row table `xscript_schema` on PostgreSQL.

A brand-new database is stamped at LATEST without running the steps (create_all has just made the
current schema), so PostgreSQL support starts at v7 and steps up to v7 only ever run on SQLite.
Steps run in order inside one transaction each and must be idempotent (check before ALTER). New
steps must use DDL both databases accept: `BOOLEAN ... DEFAULT false`, `BIGINT` for times, `JSON`.
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


def _v6(conn: Connection) -> None:
    """0.8: device_logs indexes for paging by id per device and for retention by ts (create_all only
    indexes new tables). Large log tables take a moment to index on first start."""
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_logs_device_id ON device_logs (device, id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_logs_ts ON device_logs (ts)"))


def _v7(conn: Connection) -> None:
    """0.9: 代理 card owner (the resellers table comes from create_all)."""
    _add_column(conn, "cards", "owner_id", "INTEGER")
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_cards_owner_id ON cards (owner_id)"))


def _v8(conn: Connection) -> None:
    """0.10: 打包机 columns on pack jobs (the pack_workers table comes from create_all)."""
    if not inspect(conn).has_table("pack_jobs"):
        return  # create_all makes it whole
    _add_column(conn, "pack_jobs", "worker_id", "BIGINT")
    _add_column(conn, "pack_jobs", "worker_name", "VARCHAR(64) NOT NULL DEFAULT ''")
    _add_column(conn, "pack_jobs", "heartbeat_at", "BIGINT")
    _add_column(conn, "pack_jobs", "attempts", "BIGINT NOT NULL DEFAULT 0")
    _add_column(conn, "pack_jobs", "cancel_requested", "BOOLEAN NOT NULL DEFAULT false")


STEPS: list[Callable[[Connection], None]] = [_v1, _v2, _v3, _v4, _v5, _v6, _v7, _v8]
LATEST = len(STEPS)


def current(conn: Connection) -> int:
    if conn.dialect.name == "sqlite":
        return int(conn.execute(text("PRAGMA user_version")).scalar() or 0)
    conn.execute(text("CREATE TABLE IF NOT EXISTS xscript_schema (version INTEGER NOT NULL)"))
    return int(conn.execute(text("SELECT max(version) FROM xscript_schema")).scalar() or 0)


def stamp(conn: Connection, version: int) -> None:
    if conn.dialect.name == "sqlite":
        conn.execute(text("PRAGMA user_version = %d" % int(version)))
    else:
        conn.execute(text("DELETE FROM xscript_schema"))
        conn.execute(text("INSERT INTO xscript_schema (version) VALUES (:v)"), {"v": int(version)})


def migrate(engine, fresh: bool = False) -> tuple[int, int]:
    """Bring the database to LATEST. Returns (from, to). Refuses databases from a newer release.

    fresh: the tables were all just created by create_all, so the schema already is LATEST."""
    with engine.begin() as conn:
        start = current(conn)
        if fresh and start == 0:
            stamp(conn, LATEST)
            log.info("new database at v%d", LATEST)
            return 0, LATEST
    if start > LATEST:
        raise RuntimeError("数据库版本 %d 比这个程序支持的 %d 新，请升级 xscript-server" % (start, LATEST))
    for version in range(start + 1, LATEST + 1):
        with engine.begin() as conn:
            STEPS[version - 1](conn)
            stamp(conn, version)
        log.info("database migrated to v%d", version)
    return start, LATEST
