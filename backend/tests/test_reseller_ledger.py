"""代理批发价与结算: price table, ledger, pricing on batch creation, settlement API and statements."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_server import SKIP  # noqa: E402

if not SKIP:
    from sqlalchemy import create_engine, inspect, select
    from sqlalchemy.orm import Session

    from xscript_server import migrate
    from xscript_server.db import Base
    from xscript_server.models import Reseller, ResellerLedger, ResellerPrice, User


@unittest.skipIf(SKIP, SKIP)
class SchemaTest(unittest.TestCase):
    def test_v9_adds_unpriced_policy_to_old_resellers_table(self):
        import sqlite3
        path = os.path.join(tempfile.mkdtemp(), "old.db")
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE resellers (user_id INTEGER PRIMARY KEY, quota BIGINT, used BIGINT)")
        con.execute("INSERT INTO resellers VALUES (7, 10, 2)")
        con.execute("PRAGMA user_version = 8")
        con.commit()
        con.close()
        eng = create_engine("sqlite:///" + path)
        self.assertEqual(migrate.migrate(eng), (8, migrate.LATEST))
        self.assertIn("unpriced", {c["name"] for c in inspect(eng).get_columns("resellers")})
        with eng.connect() as c:
            self.assertEqual(c.exec_driver_sql("SELECT unpriced FROM resellers WHERE user_id = 7").scalar(), "free")
        self.assertEqual(migrate.migrate(eng), (migrate.LATEST, migrate.LATEST))   # idempotent

    def test_v9_skips_a_database_without_resellers(self):
        import sqlite3
        path = os.path.join(tempfile.mkdtemp(), "older.db")
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE cards (card VARCHAR(40) PRIMARY KEY, batch VARCHAR(32))")
        con.execute("PRAGMA user_version = 6")
        con.commit()
        con.close()
        eng = create_engine("sqlite:///" + path)
        self.assertEqual(migrate.migrate(eng), (6, migrate.LATEST))

    def test_tables_and_round_trip(self):
        eng = create_engine("sqlite://")
        Base.metadata.create_all(eng)
        tables = set(inspect(eng).get_table_names())
        self.assertTrue({"reseller_prices", "reseller_ledger"} <= tables)
        with Session(eng) as s:
            s.add(User(id=1, username="r1", password_hash="x", role="reseller"))
            s.add(Reseller(user_id=1, quota=10, apps=["*"], kinds=["normal"]))
            s.flush()
            s.add(ResellerPrice(reseller_id=1, app="*", kind="normal", days=None, price_cents=150))
            s.add(ResellerLedger(reseller_id=1, kind="charge", amount_cents=300, count=2, unit_cents=150, batch="B1"))
            s.commit()
            r = s.get(Reseller, 1)
            self.assertEqual(r.unpriced, "free")
            self.assertEqual(s.scalar(select(ResellerPrice.price_cents)), 150)
            row = s.scalar(select(ResellerLedger))
            self.assertEqual((row.kind, row.amount_cents, row.count, row.unit_cents), ("charge", 300, 2, 150))
            self.assertGreater(row.time, 0)


if __name__ == "__main__":
    unittest.main()
