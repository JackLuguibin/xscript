"""SQLite through SQLAlchemy 2.x (WAL, foreign keys on)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from sqlalchemy import Select, create_engine, event, func, select
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self.engine = create_engine(
            "sqlite:///" + self.path,
            connect_args={"check_same_thread": False, "timeout": 15},
        )

        @event.listens_for(self.engine, "connect")
        def _pragmas(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=15000")
            cur.close()

        self.Session = sessionmaker(self.engine, expire_on_commit=False)

    def create_all(self) -> None:
        """Create missing tables, then apply numbered migrations (columns on existing tables)."""
        from . import models  # noqa: F401  (register tables)
        from .migrate import migrate

        Base.metadata.create_all(self.engine)
        migrate(self.engine)

    def session(self) -> Session:
        return self.Session()


def values_in(values: Iterable[str]) -> Select:
    """``SELECT value FROM json_each(?)``: use as ``column.in_(values_in(ids))`` for long, in-memory id
    lists (e.g. every connected device). One bound parameter however many ids; a plain ``in_(list)``
    needs one each and SQLite refuses more than 32 766."""
    return select(func.json_each(json.dumps(list(values))).table_valued("value").c.value)
