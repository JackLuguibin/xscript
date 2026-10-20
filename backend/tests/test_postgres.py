"""Optional PostgreSQL: URL handling, dialect-neutral helpers, migrations and moving data between backends.

The backend-neutral checks run on every run. With XSCRIPT_TEST_DATABASE_URL set (see pgtest.py; CI does so
when backend files change) the PostgreSQL ones run too, and so does the rest of the suite on PostgreSQL.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import pgtest  # noqa: E402

pgtest.install()

from sqlalchemy import select, text  # noqa: E402

from xscript_server import maintenance, migrate  # noqa: E402
from xscript_server.abuse import AbuseMonitor  # noqa: E402
from xscript_server.config import Config  # noqa: E402
from xscript_server.db import Database, copy_database, in_values, is_empty, normalize_url, redacted  # noqa: E402
from xscript_server.models import AuditLog, Card, Device, User  # noqa: E402

FAR = 2**40  # a 64-bit time (int4 on PostgreSQL would overflow in 2038)


def fresh_cfg() -> Config:
    cfg = Config.load(tempfile.mkdtemp())
    cfg.ensure_dirs()
    return cfg


def seed(db: Database) -> None:
    with db.session() as s:
        s.add(User(username="alice", password_hash="x", role="admin", totp_enabled=True))
        s.add(Device(id="d1", device_id="d1", status={"battery": 80, "nested": {"ok": True}}))
        s.add(Card(card="XS-FAR", batch="b1", days=36500, app="*", expires_at=FAR, revoked=False))
        s.add(AuditLog(actor="alice", action="user.create", target="Bob", detail={"x": [1, 2]}))
        s.commit()


class UrlAndConfigTest(unittest.TestCase):
    def test_urls(self):
        self.assertEqual(normalize_url("postgres://u:p@h/db"), "postgresql+psycopg://u:p@h/db")
        self.assertEqual(normalize_url("postgresql://u:p@h:5433/db"), "postgresql+psycopg://u:p@h:5433/db")
        self.assertEqual(normalize_url("postgresql+psycopg://u@h/db"), "postgresql+psycopg://u@h/db")
        self.assertNotIn("secret", redacted("postgresql://u:secret@h/db"))
        with self.assertRaises(ValueError):
            Database("mysql://u:p@h/db")

    def test_sqlite_stays_the_default(self):
        with mock.patch.dict(os.environ, {"XSCRIPT_DATABASE_URL": ""}):
            cfg = pgtest.sqlite_only(Config.load(tempfile.mkdtemp()))
        self.assertEqual(cfg.db_url, str(cfg.db_path))
        db = Database(cfg.db_url)
        self.assertEqual((db.dialect, db.path), ("sqlite", str(cfg.db_path)))
        db.dispose()
        cfg.database_url = "postgresql://u:secret@h/db"
        self.assertEqual(cfg.db_url, "postgresql://u:secret@h/db")

    @unittest.skipIf(pgtest.ON, "pgtest replaces the URL")
    def test_env_selects_postgres(self):
        with mock.patch.dict(os.environ, {"XSCRIPT_DATABASE_URL": " postgresql://u:p@h/db "}):
            cfg = Config.load(tempfile.mkdtemp())
        self.assertEqual(cfg.db_url, "postgresql://u:p@h/db")


class NeutralHelpersTest(unittest.TestCase):
    """Run on whatever backend the suite uses (SQLite, or PostgreSQL under pgtest)."""

    def setUp(self):
        self.db = Database(fresh_cfg().db_url)
        self.db.create_all()

    def tearDown(self):
        self.db.dispose()

    def test_far_future_times_and_json_round_trip(self):
        seed(self.db)
        with self.db.session() as s:
            self.assertEqual(s.get(Card, "XS-FAR").expires_at, FAR)
            self.assertEqual(s.get(Device, "d1").status["nested"], {"ok": True})
            at = Device.status["battery"].as_integer()
            self.assertEqual(s.scalar(select(Device.id).where(at >= 50)), "d1")

    def test_case_insensitive_search(self):
        seed(self.db)
        with self.db.session() as s:
            self.assertEqual(s.scalar(select(AuditLog.target).where(AuditLog.target.ilike("%bob%"))), "Bob")

    def test_upsert_on_both_backends(self):
        th = {"abuse_ip_devices": 1}
        m = AbuseMonitor()
        for now in (1000.0, 2000.0):  # the second round hits ON CONFLICT DO UPDATE on both tables
            with self.db.session() as s:
                m.observe("ok", "XS-1", "dev-a", "1.2.3.4", th, now=now, s=s)
                s.commit()
        with self.db.engine.connect() as c:
            rows = c.execute(text("SELECT signal, ts FROM abuse_events ORDER BY signal")).all()
        self.assertTrue(rows)
        self.assertTrue(all(r.ts == 2000.0 for r in rows))
        with self.db.session() as s:
            self.assertGreater(AbuseMonitor().load(s, now=2001.0), 0)

    def test_in_values_long_list(self):
        seed(self.db)
        ids = ["d1"] + ["ghost%d" % i for i in range(40000)]
        with self.db.session() as s:
            self.assertEqual(s.scalars(select(Device.id).where(in_values(Device.id, ids, self.db.dialect))).all(),
                             ["d1"])
            self.assertEqual(s.scalars(select(Device.id).where(~in_values(Device.id, ids, self.db.dialect))).all(),
                             [])

    def test_copy_between_databases_keeps_rows_and_ids(self):
        seed(self.db)
        dst = Database(Path(tempfile.mkdtemp()) / "copy.db")
        counts = copy_database(self.db, dst)
        self.assertEqual((counts["users"], counts["devices"], counts["cards"], counts["audit_log"]), (1, 1, 1, 1))
        with dst.session() as s:
            u = s.scalar(select(User))
            self.assertEqual((u.username, u.totp_enabled), ("alice", True))
            self.assertEqual(s.get(Card, "XS-FAR").expires_at, FAR)
            s.add(User(username="carol", password_hash="x", role="viewer"))  # ids continue after copied ones
            s.commit()
            self.assertGreater(s.scalar(select(User.id).where(User.username == "carol")), u.id)
        self.assertFalse(is_empty(dst))
        dst.dispose()


@unittest.skipUnless(pgtest.ON, "set XSCRIPT_TEST_DATABASE_URL to run against PostgreSQL")
class PostgresTest(unittest.TestCase):
    def test_new_database_is_stamped_and_migrate_is_idempotent(self):
        db = Database(fresh_cfg().db_url)
        self.assertEqual(db.dialect, "postgresql")
        db.create_all()
        with db.engine.connect() as c:
            self.assertEqual(migrate.current(c), migrate.LATEST)
            self.assertEqual(c.execute(text("SELECT count(*) FROM xscript_schema")).scalar(), 1)
        self.assertEqual(migrate.migrate(db.engine), (migrate.LATEST, migrate.LATEST))
        with db.engine.begin() as c:
            migrate.stamp(c, migrate.LATEST + 3)
        with self.assertRaises(RuntimeError):
            migrate.migrate(db.engine)
        db.dispose()

    def test_sqlite_install_moves_to_postgres_through_a_backup(self):
        # An existing SQLite install with data and a signing key …
        old = pgtest.sqlite_only(fresh_cfg())
        src = Database(old.db_url)
        src.create_all()
        seed(src)
        src.dispose()
        old.key_path.parent.mkdir(parents=True, exist_ok=True)
        old.key_path.write_text("KEY")
        backup = maintenance.create_backup(old)

        # … restored with XSCRIPT_DATABASE_URL set lands in PostgreSQL; new rows get fresh ids.
        new = fresh_cfg()
        maintenance.restore_backup(new, backup)
        pg = Database(new.db_url)
        with pg.session() as s:
            self.assertEqual(s.scalar(select(User.username)), "alice")
            self.assertEqual(s.get(Card, "XS-FAR").expires_at, FAR)
            s.add(User(username="dave", password_hash="x", role="viewer"))
            s.commit()
        self.assertEqual(new.key_path.read_text(), "KEY")
        self.assertFalse(new.db_path.exists())  # nothing written to the SQLite path
        with self.assertRaises(ValueError):  # data present: needs --force
            maintenance.restore_backup(new, backup)
        maintenance.restore_backup(new, backup, force=True)
        with pg.session() as s:
            self.assertEqual(s.scalars(select(User.username)).all(), ["alice"])

        # A backup taken from PostgreSQL is a SQLite file again.
        again = maintenance.create_backup(new)
        self.assertGreater(maintenance.disk_usage(new, pg)["database"], 0)
        pg.dispose()
        back = pgtest.sqlite_only(fresh_cfg())
        maintenance.restore_backup(back, again)
        sq = Database(back.db_url)
        with sq.session() as s:
            self.assertEqual(s.scalar(select(User.username)), "alice")
        sq.dispose()


if __name__ == "__main__":
    unittest.main()
