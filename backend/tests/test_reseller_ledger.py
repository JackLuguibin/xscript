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
        """Raw SQL through the server's own engine, so it works on SQLite and PostgreSQL alike."""
        from sqlalchemy import text
        parts = sql.split("?")
        sql = "".join(p + (":p%d" % i if i < len(args) else "") for i, p in enumerate(parts))
        with self.srv.app.state.ctx.db.session() as s:
            res = s.execute(text(sql), {"p%d" % i: a for i, a in enumerate(args)})
            rows = [tuple(r) for r in res.all()] if res.returns_rows else []
            s.commit()
            return rows

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

    # ------------------------------------------------------------ G.3 settlement API

    def test_admin_prices_replace_validate_and_apply(self):
        uid, c = self.reseller("g3_prices")
        url = "/api/resellers/%d/prices" % uid
        self.assertEqual(self.admin.get(url).json(), {"unpriced": "free", "items": []})
        items = [{"app": "*", "kind": "normal", "price_cents": 100}, {"app": "com.demo.a", "kind": "normal", "days": 30,
                                                                     "price_cents": 900}]
        r = self.admin.put(url, json={"unpriced": "deny", "items": items})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["unpriced"], len(r.json()["items"])), ("deny", 2))
        dup = self.admin.put(url, json={"items": items + [{"app": "*", "kind": "normal", "price_cents": 5}]})
        self.assertEqual(dup.status_code, 400)
        self.assertIn("重复", dup.text)
        for bad in ({"app": "bad app", "price_cents": 1}, {"price_cents": -1}, {"days": 0, "price_cents": 1},
                    {"kind": "vip", "price_cents": 1}):
            self.assertEqual(self.admin.put(url, json={"items": [bad]}).status_code, 422, bad)
        self.assertEqual(len(self.admin.get(url).json()["items"]), 2)          # failed writes changed nothing
        self.assertEqual(self.batch(c, 2, app="com.demo.a").json()["charge_cents"], 1800)
        self.assertEqual(self.batch(c, 1, app="com.demo.b").json()["charge_cents"], 100)
        self.assertEqual(self.batch(c, 1, kind="trial", days=1).status_code, 403)  # unpriced + deny
        # Replacing the table does not reprice past charges.
        self.assertEqual(self.admin.put(url, json={"items": []}).status_code, 200)
        self.assertEqual(self.admin.get("/api/resellers/%d/ledger" % uid).json()["charged"], 1900)
        self.assertEqual(self.admin.get(url).json()["unpriced"], "free")

    def test_payment_adjust_balance_and_validation(self):
        uid, c = self.reseller("g3_pay")
        self.admin.put("/api/resellers/%d/prices" % uid, json={"items": [{"price_cents": 500}]})
        self.batch(c, 4)                                                       # owes 20.00
        url = "/api/resellers/%d/ledger" % uid
        r = self.admin.post(url, json={"kind": "payment", "amount_cents": 1500, "note": "微信 10/20"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["balance"], 500)
        r = self.admin.post(url, json={"kind": "adjust", "amount_cents": -200, "note": "优惠"})
        self.assertEqual((r.json()["charged"], r.json()["paid"], r.json()["adjusted"], r.json()["balance"]),
                         (2000, 1500, -200, 300))
        for bad in ({"kind": "payment", "amount_cents": 0}, {"kind": "payment", "amount_cents": -5},
                    {"kind": "adjust", "amount_cents": 0}):
            self.assertEqual(self.admin.post(url, json=bad).status_code, 400, bad)
        for bad in ({"kind": "charge", "amount_cents": 5}, {"kind": "payment", "amount_cents": 10**13}):
            self.assertEqual(self.admin.post(url, json=bad).status_code, 422, bad)
        page = self.admin.get(url, params={"kind": "payment"}).json()
        self.assertEqual((page["total"], page["items"][0]["note"], page["items"][0]["actor"]), (1, "微信 10/20", "admin"))
        self.assertEqual(self.admin.get(url).json()["total"], 3)
        row = [x for x in self.admin.get("/api/resellers/balances").json()["items"] if x["id"] == uid][0]
        self.assertEqual((row["username"], row["balance"]), ("g3_pay", 300))
        # The reseller sees the same numbers, its prices, and the admin's actions in its own log.
        mine = c.get("/api/reseller/balance").json()
        self.assertEqual((mine["balance"], mine["prices"]["items"][0]["price_cents"]), (300, 500))
        self.assertEqual(c.get("/api/reseller/ledger").json()["total"], 3)
        actions = {x["action"] for x in c.get("/api/reseller/audit").json()["items"]}
        self.assertTrue({"reseller.prices", "reseller.payment", "reseller.adjust"} <= actions, actions)
        self.assertEqual(self.admin.post("/api/resellers/999999/ledger",
                                         json={"kind": "payment", "amount_cents": 1}).status_code, 404)

    def test_permissions(self):
        uid, c = self.reseller("g3_perm")
        other, oc = self.reseller("g3_perm_other")
        self.admin.post("/api/resellers/%d/ledger" % other, json={"kind": "adjust", "amount_cents": 777})
        for path in ("/api/resellers/balances", "/api/resellers/%d/prices" % uid, "/api/resellers/%d/ledger" % uid,
                     "/api/resellers/%d/statement" % other):
            self.assertEqual(c.get(path).status_code, 403, path)
        self.assertEqual(c.put("/api/resellers/%d/prices" % uid, json={"items": [{"price_cents": 0}]}).status_code, 403)
        self.assertEqual(c.post("/api/resellers/%d/ledger" % uid,
                                json={"kind": "payment", "amount_cents": 1}).status_code, 403)
        # Own ledger only: the other reseller's adjustment is invisible.
        self.assertEqual((c.get("/api/reseller/ledger").json()["total"], c.get("/api/reseller/balance").json()["balance"]),
                         (0, 0))
        self.assertNotIn("777", c.get("/api/reseller/statement").text)
        self.assertEqual(oc.get("/api/reseller/balance").json()["balance"], 777)
        # Staff below admin cannot read money either.
        r = self.admin.post("/api/users", json={"username": "g3_op", "password": "password-g3_op", "role": "operator"})
        self.assertEqual(r.status_code, 200, r.text)
        op = self.login("g3_op", "password-g3_op")
        self.addCleanup(op.close)
        self.assertEqual(op.get("/api/resellers/balances").status_code, 403)
        self.assertEqual(op.get("/api/reseller/balance").status_code, 403)
        anon = httpx.Client(base_url=self.srv.base, headers=CSRF, timeout=30)
        self.addCleanup(anon.close)
        self.assertEqual(anon.get("/api/reseller/ledger").status_code, 401)

    def test_concurrent_batches_charge_exactly_once_each(self):
        import threading
        uid, c = self.reseller("g3_race", quota=20)
        self.admin.put("/api/resellers/%d/prices" % uid, json={"items": [{"price_cents": 10}]})
        codes = []

        def go():  # one signed-in client shared by all threads (httpx.Client is thread-safe)
            codes.append(self.batch(c, 3).status_code)
        ts = [threading.Thread(target=go) for _ in range(10)]
        [t.start() for t in ts]
        [t.join(30) for t in ts]
        ok = codes.count(200)
        self.assertEqual(ok, 6)                                                # 20 // 3
        bal = self.admin.get("/api/resellers/%d/ledger" % uid).json()
        self.assertEqual((bal["total"], bal["charged"]), (ok, ok * 30))
        self.assertEqual(self.db("SELECT used FROM resellers WHERE user_id = ?", uid), [(ok * 3,)])

    # ------------------------------------------------------------ G.4 statement CSV

    def test_statement_csv_range_and_balances(self):
        import csv
        import io
        uid, c = self.reseller("g4_csv")
        self.admin.put("/api/resellers/%d/prices" % uid, json={"items": [{"price_cents": 250}]})
        batch = self.batch(c, 2).json()["batch"]                               # +5.00
        self.admin.post("/api/resellers/%d/ledger" % uid, json={"kind": "payment", "amount_cents": 300, "note": "首付"})
        self.db("UPDATE reseller_ledger SET time = 1000 WHERE reseller_id = ? AND kind = 'charge'", uid)
        r = self.admin.get("/api/resellers/%d/statement" % uid)
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r.headers["content-type"])
        self.assertIn("statement-g4_csv-", r.headers["content-disposition"])
        self.assertTrue(r.text.startswith("\ufeff"))
        rows = list(csv.reader(io.StringIO(r.text.lstrip("\ufeff"))))
        self.assertEqual(rows[1], ["期初应付(元)", "0.00"])
        body = rows[3:-1]
        self.assertEqual([(x[1], x[2], x[3], x[5], x[-1]) for x in body],
                         [("生成卡密", "5.00", batch, "2.50", "5.00"), ("收款", "-3.00", "", "", "2.00")])
        self.assertEqual(rows[-1], ["期末应付(元)", "2.00"])
        # A range after the charge: the charge moves into the opening balance.
        rows = list(csv.reader(io.StringIO(self.admin.get("/api/resellers/%d/statement" % uid,
                                                          params={"since": 2000}).text.lstrip("\ufeff"))))
        self.assertEqual((rows[1][1], len(rows[3:-1]), rows[-1][1]), ("5.00", 1, "2.00"))
        rows = list(csv.reader(io.StringIO(self.admin.get("/api/resellers/%d/statement" % uid,
                                                          params={"until": 1500}).text.lstrip("\ufeff"))))
        self.assertEqual((len(rows[3:-1]), rows[-1][1]), (1, "5.00"))
        mine = c.get("/api/reseller/statement")
        self.assertEqual(mine.status_code, 200)
        self.assertIn("首付", mine.text)
        acts = [x["action"] for x in self.admin.get("/api/audit", params={"action": "reseller.statement"}).json()["items"]]
        self.assertGreaterEqual(len(acts), 2)


if __name__ == "__main__":
    unittest.main()
