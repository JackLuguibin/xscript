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

from test_server import CSRF, SKIP, Server  # noqa: E402

if not SKIP:
    from sqlalchemy import create_engine, inspect, select
    from sqlalchemy.orm import Session

    import httpx

    from xscript_server import migrate, settlement
    from xscript_server.__main__ import main as cli
    from xscript_server.config import Config
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

    def test_price_lookup_most_specific_wins(self):
        eng = create_engine("sqlite://")
        Base.metadata.create_all(eng)
        with Session(eng) as s:
            s.add(User(id=1, username="r1", password_hash="x", role="reseller"))
            s.add(Reseller(user_id=1, quota=10))
            s.flush()
            self.assertIsNone(settlement.price_for(s, 1, "com.a", "normal", 30))
            s.add(ResellerPrice(reseller_id=1, app="*", kind="normal", days=None, price_cents=100))
            s.flush()
            self.assertEqual(settlement.price_for(s, 1, "com.a", "normal", 30), 100)
            self.assertIsNone(settlement.price_for(s, 1, "com.a", "trial", 1))
            s.add(ResellerPrice(reseller_id=1, app="*", kind="normal", days=30, price_cents=200))
            s.flush()
            self.assertEqual(settlement.price_for(s, 1, "com.a", "normal", 30), 200)
            self.assertEqual(settlement.price_for(s, 1, "com.a", "normal", 7), 100)
            s.add(ResellerPrice(reseller_id=1, app="com.a", kind="normal", days=None, price_cents=300))
            s.flush()
            self.assertEqual(settlement.price_for(s, 1, "com.a", "normal", 30), 300)   # exact app beats exact days
            self.assertEqual(settlement.price_for(s, 1, "com.b", "normal", 30), 200)
            s.add(ResellerPrice(reseller_id=1, app="com.a", kind="normal", days=30, price_cents=400))
            s.flush()
            self.assertEqual(settlement.price_for(s, 1, "com.a", "normal", 30.0), 400)
            s.add(ResellerLedger(reseller_id=1, kind="charge", amount_cents=1000))
            s.add(ResellerLedger(reseller_id=1, kind="payment", amount_cents=600))
            s.add(ResellerLedger(reseller_id=1, kind="adjust", amount_cents=-50))
            s.flush()
            self.assertEqual(settlement.balance(s, 1), {"charged": 1000, "paid": 600, "adjusted": -50, "balance": 350})


@unittest.skipIf(SKIP, SKIP)
class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg = Config.load(os.path.join(cls.tmp, "data"), web_dir=os.path.join(cls.tmp, "noweb"))
        os.environ["XSCRIPT_ADMIN_PASSWORD"] = "admin-pass-123"
        assert cli(["--data", str(cls.cfg.data_dir), "init"]) == 0
        cls.srv = Server(cls.cfg).__enter__()
        cls.admin = cls.login("admin", "admin-pass-123")

    @classmethod
    def tearDownClass(cls):
        cls.admin.close()
        cls.srv.__exit__(None, None, None)

    @classmethod
    def login(cls, user, pw):
        c = httpx.Client(base_url=cls.srv.base, headers=CSRF, timeout=30)
        r = c.post("/api/auth/login", json={"username": user, "password": pw})
        assert r.status_code == 200, r.text
        return c

    def reseller(self, name, quota=100):
        r = self.admin.post("/api/users", json={"username": name, "password": "password-" + name, "role": "reseller"})
        self.assertEqual(r.status_code, 200, r.text)
        uid = r.json()["id"]
        body = {"apps": ["*"], "kinds": ["normal", "trial"], "max_days": 365, "max_devices": 1, "max_uses": 1000}
        self.assertEqual(self.admin.put("/api/resellers/%d" % uid, json=body).status_code, 200)
        self.assertEqual(self.admin.post("/api/resellers/%d/quota" % uid, json={"delta": quota}).status_code, 200)
        c = self.login(name, "password-" + name)
        self.addCleanup(c.close)
        return uid, c

    def db(self, sql, *args):
        import sqlite3
        con = sqlite3.connect(str(self.cfg.db_path))
        try:
            rows = con.execute(sql, args).fetchall()
            con.commit()
            return rows
        finally:
            con.close()

    def batch(self, c, count=2, **kw):
        return c.post("/api/reseller/cards/batches", json={"count": count, "days": 30, **kw})

    def test_batch_is_charged_in_the_same_transaction(self):
        uid, c = self.reseller("g2_charge")
        self.db("INSERT INTO reseller_prices (reseller_id, app, kind, days, price_cents, updated_at) "
                "VALUES (?, '*', 'normal', 30, 250, 0)", uid)
        r = self.batch(c, 3)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["unit_cents"], r.json()["charge_cents"]), (250, 750))
        rows = self.db("SELECT kind, amount_cents, count, unit_cents, batch FROM reseller_ledger WHERE reseller_id = ?", uid)
        self.assertEqual(rows, [("charge", 750, 3, 250, r.json()["batch"])])
        # Unpriced (other validity) under the default "free" policy: allowed and recorded at 0.
        r = self.batch(c, 1, days=7)
        self.assertEqual((r.status_code, r.json()["charge_cents"]), (200, 0))

    def test_deny_policy_refuses_unpriced_batches_without_spending_quota(self):
        uid, c = self.reseller("g2_deny", quota=5)
        self.db("UPDATE resellers SET unpriced = 'deny' WHERE user_id = ?", uid)
        r = self.batch(c, 2)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("批发价", r.text)
        self.assertEqual(self.db("SELECT used FROM resellers WHERE user_id = ?", uid), [(0,)])
        self.assertEqual(self.db("SELECT COUNT(*) FROM reseller_ledger WHERE reseller_id = ?", uid), [(0,)])
        self.assertEqual(self.db("SELECT COUNT(*) FROM cards WHERE owner_id = ?", uid), [(0,)])

    def test_quota_failure_writes_no_charge(self):
        uid, c = self.reseller("g2_quota", quota=1)
        self.db("INSERT INTO reseller_prices (reseller_id, app, kind, days, price_cents, updated_at) "
                "VALUES (?, '*', 'normal', NULL, 100, 0)", uid)
        self.assertNotEqual(self.batch(c, 2).status_code, 200)
        self.assertEqual(self.db("SELECT COUNT(*) FROM reseller_ledger WHERE reseller_id = ?", uid), [(0,)])


if __name__ == "__main__":
    unittest.main()
