"""The database through SQLAlchemy 2.x: SQLite by default (WAL, foreign keys on), PostgreSQL optionally.

PostgreSQL is selected with XSCRIPT_DATABASE_URL (postgresql://user:pass@host/db, needs the `postgres` extra:
psycopg 3). Everything else in the server is dialect-neutral; the few spots that differ go through
`dialect_insert`, `in_values` and migrate.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import ColumnElement, any_, create_engine, event, func, literal, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import String


class Base(DeclarativeBase):
    pass


def normalize_url(url: str) -> str:
    """postgres:// and postgresql:// use psycopg 3 (the only PostgreSQL driver we install)."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def redacted(url: str) -> str:
    """The URL with its password hidden, for logs and the console."""
    try:
        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        return "<invalid database URL>"


class Database:
    def __init__(self, target: Path | str):
        """`target` is a SQLite file path or a database URL (sqlite:///…, postgresql://…)."""
        target = str(target)
        self.url = normalize_url(target) if "://" in target else "sqlite:///" + target
        self.dialect = make_url(self.url).get_backend_name()
        if self.dialect == "sqlite":
            self.path: str | None = make_url(self.url).database
            self.engine = create_engine(self.url, connect_args={"check_same_thread": False, "timeout": 15})

            @event.listens_for(self.engine, "connect")
            def _pragmas(dbapi_conn, _record):  # noqa: ANN001
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA busy_timeout=15000")
                cur.close()
        elif self.dialect == "postgresql":
            self.path = None
            # The server is one process: a modest pool, checked before use so a restarted database
            # or a dropped idle connection does not fail the next request.
            self.engine = create_engine(self.url, pool_size=10, max_overflow=20, pool_pre_ping=True,
                                        pool_recycle=1800)
        else:
            raise ValueError("不支持的数据库 %s（只支持 SQLite 和 PostgreSQL）" % self.dialect)
        self.Session = sessionmaker(self.engine, expire_on_commit=False)

    @property
    def is_sqlite(self) -> bool:
        return self.dialect == "sqlite"

    def describe(self) -> str:
        return self.path if self.is_sqlite else redacted(self.url)

    def create_all(self) -> None:
        """Create missing tables, then apply numbered migrations (columns on existing tables)."""
        from sqlalchemy import inspect

        from . import models  # noqa: F401  (register tables)
        from .migrate import migrate

        fresh = not inspect(self.engine).get_table_names()  # nothing at all yet: a new database
        Base.metadata.create_all(self.engine)
        migrate(self.engine, fresh=fresh)

    def session(self) -> Session:
        return self.Session()

    def dispose(self) -> None:
        self.engine.dispose()


def in_values(column: Any, values: Iterable[str], dialect: str) -> ColumnElement[bool]:
    """``column IN (values)`` for long, in-memory id lists (e.g. every connected device) with one bound
    parameter however many ids: SQLite reads a JSON array through json_each (a plain ``in_(list)`` needs one
    parameter each and SQLite refuses more than 32 766), PostgreSQL compares against an array (= ANY)."""
    values = list(values)
    if dialect == "postgresql":
        return column == any_(literal(values, ARRAY(String)))
    return column.in_(select(func.json_each(json.dumps(values)).table_valued("value").c.value))


def dialect_insert(s: Session, table: Any):
    """INSERT that supports ``on_conflict_do_update`` on both backends."""
    if s.get_bind().dialect.name == "postgresql":
        return postgresql.insert(table)
    from sqlalchemy.dialects import sqlite

    return sqlite.insert(table)


def copy_database(src: Database, dst: Database, chunk: int = 2000) -> dict[str, int]:
    """Copy every table from `src` into the empty schema of `dst` (either backend, either direction).

    Backups use it to write a PostgreSQL database into the archive's SQLite file, restore uses it the
    other way, which is also how an existing SQLite install moves to PostgreSQL. `src` is read in one
    REPEATABLE READ transaction on PostgreSQL, so the copy is consistent while the server runs.
    Returns rows per table."""
    from . import models  # noqa: F401  (register tables)

    dst.create_all()
    counts: dict[str, int] = {}
    with src.engine.connect() as sc, dst.engine.begin() as dc:
        if not src.is_sqlite:
            sc = sc.execution_options(isolation_level="REPEATABLE READ")
        for table in Base.metadata.sorted_tables:  # parents before children (foreign keys)
            n = 0
            res = sc.execution_options(stream_results=True, yield_per=chunk).execute(table.select())
            for part in res.partitions(chunk):
                dc.execute(table.insert(), [dict(r._mapping) for r in part])
                n += len(part)
            counts[table.name] = n
        if not dst.is_sqlite:
            reset_sequences(dc)
    return counts


def reset_sequences(conn: Any) -> None:
    """After inserting explicit ids on PostgreSQL, move each serial past the largest id."""
    from sqlalchemy import text

    for table in Base.metadata.sorted_tables:
        pk = list(table.primary_key.columns)
        if len(pk) == 1 and pk[0].autoincrement in (True, "auto") and pk[0].type.python_type is int:
            conn.execute(text("SELECT setval(pg_get_serial_sequence(:t, :c), coalesce(max(%s), 1), max(%s) IS NOT NULL) "
                              "FROM %s" % (pk[0].name, pk[0].name, table.name)), {"t": table.name, "c": pk[0].name})


def is_empty(db: Database) -> bool:
    """No accounts yet (a database that was never initialised, or only has empty tables)."""
    from sqlalchemy import inspect, text

    if not inspect(db.engine).has_table("users"):
        return True
    with db.engine.connect() as c:
        return not c.execute(text("SELECT 1 FROM users LIMIT 1")).first()


def wipe(db: Database) -> None:
    """Delete every row (restore --force into PostgreSQL)."""
    from . import models  # noqa: F401
    from sqlalchemy import inspect

    names = [t.name for t in Base.metadata.sorted_tables if inspect(db.engine).has_table(t.name)]
    if names:
        from sqlalchemy import text

        with db.engine.begin() as c:
            c.execute(text("TRUNCATE %s RESTART IDENTITY CASCADE" % ", ".join(names)))
