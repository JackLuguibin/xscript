"""Run the backend tests on PostgreSQL instead of SQLite.

    XSCRIPT_TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/postgres python -m unittest discover -s tests

Every data directory a test loads gets its own new database (created through that URL, dropped at
exit), so test classes stay isolated exactly as with their per-directory SQLite files. Tests that
build an old SQLite file on purpose (migrations, legacy import) call `sqlite_only(cfg)`.
Unset (the default), nothing changes: the suite runs on SQLite.
"""
from __future__ import annotations

import atexit
import os
import uuid

URL = os.environ.get("XSCRIPT_TEST_DATABASE_URL", "").strip()
ON = bool(URL)
_installed = False


def install() -> None:
    global _installed
    if not ON or _installed:
        return
    _installed = True
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url

    from xscript_server.config import Config
    from xscript_server.db import normalize_url

    base = make_url(normalize_url(URL))
    admin = create_engine(base, isolation_level="AUTOCOMMIT", poolclass=None)
    by_dir: dict[str, str] = {}
    original = Config.load.__func__

    def load(cls, *args, **kwargs):
        cfg = original(cls, *args, **kwargs)
        key = str(cfg.data_dir)
        if key not in by_dir:
            name = "xs_test_" + uuid.uuid4().hex[:12]
            with admin.connect() as c:
                c.execute(text('CREATE DATABASE "%s"' % name))
            by_dir[key] = base.set(database=name).render_as_string(hide_password=False)
        cfg.database_url = by_dir[key]
        return cfg

    Config.load = classmethod(load)

    @atexit.register
    def _drop() -> None:
        with admin.connect() as c:
            for url in by_dir.values():
                c.execute(text('DROP DATABASE IF EXISTS "%s" WITH (FORCE)' % make_url(url).database))
        admin.dispose()


def sqlite_only(cfg):
    """Keep this config on its SQLite file (tests of SQLite files and their migrations)."""
    cfg.database_url = ""
    return cfg
