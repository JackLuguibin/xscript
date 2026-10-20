"""代理 accounts: own cards only, quota, limits, sales stats, permission scoping and audit."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_server import CSRF, SKIP, Server  # noqa: E402

if not SKIP:
    import httpx
    from sqlalchemy import select

    from xscript_server import migrate
    from xscript_server.__main__ import main as cli
    from xscript_server.config import Config
    from xscript_server.models import Card, Reseller


@unittest.skipIf(SKIP, SKIP)
class ResellerTest(unittest.TestCase):
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

    def reseller(self, name, quota=0, **limits):
        r = self.admin.post("/api/users", json={"username": name, "password": "password-" + name, "role": "reseller"})
        self.assertEqual(r.status_code, 200, r.text)
        uid = r.json()["id"]
        if limits:
            body = {"apps": ["*"], "kinds": ["normal"], "max_days": 365, "max_devices": 1, "max_uses": 1000, **limits}
            self.assertEqual(self.admin.put("/api/resellers/%d" % uid, json=body).status_code, 200)
        if quota:
            self.assertEqual(self.admin.post("/api/resellers/%d/quota" % uid, json={"delta": quota}).status_code, 200)
        c = self.login(name, "password-" + name)
        self.addCleanup(c.close)
        return uid, c

    def batch(self, c, count=2, **kw):
        return c.post("/api/reseller/cards/batches", json={"count": count, "days": 30, **kw})

    # ------------------------------------------------------------ scoping

    def test_reseller_is_refused_by_every_staff_endpoint(self):
        _, c = self.reseller("r_scope")
        for path in ("/api/cards", "/api/cards/stats", "/api/cards/batches", "/api/devices", "/api/audit",
                     "/api/stats/daily", "/api/users", "/api/resellers", "/api/scripts", "/api/tasks",
                     "/api/pack/jobs", "/api/settings", "/api/overview", "/api/device-keys"):
            r = c.get(path)
            self.assertIn(r.status_code, (403, 404), path)
            self.assertNotEqual(r.status_code, 200, path)
        self.assertEqual(c.post("/api/cards/batches", json={"count": 1}).status_code, 403)
        self.assertEqual(c.post("/api/cards/actions", json={"cards": ["X"], "action": "delete"}).status_code, 403)
        # Own account pages still work.
        me = c.get("/api/auth/me")
        self.assertEqual((me.status_code, me.json()["role"]), (200, "reseller"))
        self.assertEqual(c.get("/api/auth/sessions").status_code, 200)
        # Staff cannot use the reseller console.
        self.assertEqual(self.admin.get("/api/reseller/me").status_code, 403)

    def test_own_cards_only(self):
        _, a = self.reseller("r_own_a", quota=5, apps=["*"])
        _, b = self.reseller("r_own_b", quota=5, apps=["*"])
        mine = self.batch(a, 2).json()["cards"]
        theirs = self.batch(b, 1).json()["cards"]
        staff = self.admin.post("/api/cards/batches", json={"count": 1}).json()["cards"]
        listed = [x["card"] for x in a.get("/api/reseller/cards").json()["items"]]
        self.assertEqual(sorted(listed), sorted(mine))
        self.assertEqual(a.get("/api/reseller/cards", params={"q": theirs[0]}).json()["total"], 0)
        self.assertEqual(a.get("/api/reseller/cards/stats").json()["total"], 2)
        self.assertEqual(len(a.get("/api/reseller/cards/batches").json()["items"]), 1)
        # Actions on someone else's codes are skipped, not applied.
        r = a.post("/api/reseller/cards/actions", json={"cards": mine + theirs + staff, "action": "revoke"})
        self.assertEqual(r.json()["updated"], 2)
        with self.srv.app.state.ctx.db.session() as s:
            self.assertFalse(s.get(Card, theirs[0]).revoked)
            self.assertFalse(s.get(Card, staff[0]).revoked)
            self.assertTrue(all(s.get(Card, x).revoked for x in mine))
        self.assertEqual(a.post("/api/reseller/cards/actions", json={"cards": mine, "action": "delete"}).status_code, 422)
        csv = a.get("/api/reseller/cards/export").text
        self.assertTrue(all(x in csv for x in mine))
        self.assertNotIn(theirs[0], csv)
        self.assertNotIn(staff[0], csv)
        # Admin sees the owner and can filter by it.
        uid_a = a.get("/api/auth/me").json()["id"]
        items = self.admin.get("/api/cards", params={"owner": uid_a}).json()["items"]
        self.assertEqual(sorted(x["card"] for x in items), sorted(mine))
        self.assertTrue(all(x["owner_id"] == uid_a for x in items))
        staff_only = [x["card"] for x in self.admin.get("/api/cards", params={"owner": -1, "page_size": 500}).json()["items"]]
        self.assertIn(staff[0], staff_only)
        self.assertNotIn(mine[0], staff_only)

    # ------------------------------------------------------------ quota and limits

    def test_quota_is_enforced_and_never_refunded(self):
        uid, c = self.reseller("r_quota", quota=3)
        self.assertEqual(c.get("/api/reseller/me").json()["left"], 3)
        self.admin.put("/api/resellers/%d" % uid, json={"apps": ["*"], "kinds": ["normal"], "max_days": 30,
                                                        "max_devices": 1, "max_uses": 1, "note": "内部备注"})
        self.assertNotIn("note", c.get("/api/reseller/me").json())
        r = self.batch(c, 4)
        self.assertEqual(r.status_code, 403)
        self.assertIn("额度不足", r.json()["error"])
        self.assertEqual(self.batch(c, 3).json()["left"], 0)
        codes = c.get("/api/reseller/cards").json()["items"]
        c.post("/api/reseller/cards/actions", json={"cards": [x["card"] for x in codes], "action": "revoke"})
        self.assertEqual(self.batch(c, 1).status_code, 403)  # revoking does not refund
        # Admin cannot drop quota below what was used; can top up.
        self.assertEqual(self.admin.post("/api/resellers/%d/quota" % uid, json={"delta": -1}).status_code, 400)
        self.assertEqual(self.admin.post("/api/resellers/%d/quota" % uid, json={"delta": 0}).status_code, 400)
        self.assertEqual(self.admin.post("/api/resellers/%d/quota" % uid, json={"delta": 2, "note": "充值"}).json()["left"], 2)
        self.assertEqual(self.batch(c, 2).status_code, 200)

    def test_quota_is_atomic_under_concurrency(self):
        uid, c = self.reseller("r_race", quota=5)
        results = []

        def go():  # one signed-in client shared by all threads (httpx.Client is thread-safe)
            results.append(self.batch(c, 1).status_code)

        threads = [threading.Thread(target=go) for _ in range(12)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        self.assertEqual(sorted(results).count(200), 5)
        with self.srv.app.state.ctx.db.session() as s:
            self.assertEqual(s.get(Reseller, uid).used, 5)
            self.assertEqual(len(s.scalars(select(Card).where(Card.owner_id == uid)).all()), 5)

    def test_limits(self):
        _, c = self.reseller("r_limits", quota=100, apps=["com.game.a"], kinds=["normal", "count"], max_days=31,
                             max_devices=2, max_uses=50)
        self.assertEqual(self.batch(c, 1, app="com.game.b").status_code, 403)
        self.assertEqual(self.batch(c, 1, app="*").status_code, 403)
        self.assertEqual(self.batch(c, 1, app="com.game.a", kind="trial", days=1).status_code, 403)
        self.assertEqual(self.batch(c, 1, app="com.game.a", days=0).status_code, 403)  # permanent
        self.assertEqual(self.batch(c, 1, app="com.game.a", days=32).status_code, 403)
        self.assertEqual(self.batch(c, 1, app="com.game.a", max_devices=3).status_code, 403)
        self.assertEqual(self.batch(c, 1, app="com.game.a", kind="count", uses=51).status_code, 403)
        self.assertEqual(self.batch(c, 1, app="com.game.a", kind="count", uses=50).status_code, 200)
        self.assertEqual(self.batch(c, 1, app="com.game.a", days=31, max_devices=2).status_code, 200)
        self.assertEqual(c.get("/api/reseller/me").json()["used"], 2)  # refused requests spent nothing
        bad = self.admin.put("/api/resellers/%d" % c.get("/api/auth/me").json()["id"],
                             json={"apps": ["not a pkg"], "kinds": ["normal"], "max_days": 1, "max_devices": 1,
                                   "max_uses": 1})
        self.assertEqual(bad.status_code, 422)

    def test_new_reseller_has_no_quota_and_role_change_logs_out(self):
        uid, c = self.reseller("r_role")
        self.assertEqual(self.batch(c, 1).status_code, 403)
        self.admin.patch("/api/users/%d" % uid, json={"role": "viewer"})
        self.assertEqual(c.get("/api/auth/me").status_code, 401)

    # ------------------------------------------------------------ stats and audit

    def test_sales_stats_and_audit(self):
        uid, c = self.reseller("r_stats", quota=10)
        codes = self.batch(c, 3, app="*").json()["cards"]
        other_uid, other = self.reseller("r_stats_other", quota=10)
        self.batch(other, 4)
        with httpx.Client(base_url=self.srv.base) as app:
            r = app.post("/license/activate", json={"card": codes[0], "device_id": "dev-s1", "app": "com.x"})
            self.assertEqual(r.status_code, 200, r.text)
        d = c.get("/api/reseller/stats/daily", params={"days": 7}).json()
        self.assertEqual(set(d["series"]), {"created", "activations", "expirations"})
        self.assertEqual((d["totals"]["created"], d["totals"]["activations"]), (3, 1))
        self.assertEqual(d["days"][-1], time.strftime("%Y-%m-%d"))
        admin_view = self.admin.get("/api/resellers/%d/stats/daily" % uid, params={"days": 7}).json()
        self.assertEqual(admin_view["totals"], d["totals"])
        listing = {x["username"]: x for x in self.admin.get("/api/resellers").json()["items"]}
        self.assertEqual(listing["r_stats"]["activations_30d"], 1)
        self.assertEqual(listing["r_stats"]["cards"]["total"], 3)
        self.assertEqual((listing["r_stats"]["used"], listing["r_stats"]["left"]), (3, 7))
        self.assertEqual(listing["r_stats_other"]["cards"]["total"], 4)
        self.assertEqual(self.admin.get("/api/stats/daily", params={"days": 7, "owner": uid}).json()
                         ["totals"]["activations"], 1)
        rows = c.get("/api/reseller/audit").json()["items"]
        actions = [(x["actor"], x["action"]) for x in rows]
        self.assertIn(("r_stats", "card.create"), actions)
        self.assertIn(("admin", "reseller.quota"), actions)
        self.assertTrue(all(x["actor"] in ("r_stats", "admin") for x in rows))
        self.assertFalse(any(x["target"] == "r_stats_other" for x in rows))
        cards_only = c.get("/api/reseller/audit", params={"action": "card."}).json()["items"]
        self.assertTrue(cards_only and all(x["action"].startswith("card.") for x in cards_only))
        self.assertEqual(c.get("/api/reseller/audit", params={"since": int(time.time()) + 3600}).json()["total"], 0)
        staff_audit = self.admin.get("/api/audit", params={"actor": "r_stats"}).json()["items"]
        self.assertTrue(any(x["action"] == "card.create" and x["detail"].get("reseller") for x in staff_audit))


class MigrationTest(unittest.TestCase):
    @unittest.skipIf(SKIP, SKIP)
    def test_v7_adds_owner_to_old_cards_table(self):
        import sqlite3
        from sqlalchemy import create_engine, inspect
        path = os.path.join(tempfile.mkdtemp(), "old.db")
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE cards (card VARCHAR(40) PRIMARY KEY, batch VARCHAR(32))")
        con.execute("PRAGMA user_version = 6")
        con.commit()
        con.close()
        eng = create_engine("sqlite:///" + path)
        self.assertEqual(migrate.migrate(eng), (6, migrate.LATEST))
        cols = {c["name"] for c in inspect(eng).get_columns("cards")}
        self.assertIn("owner_id", cols)
        self.assertEqual(migrate.migrate(eng), (migrate.LATEST, migrate.LATEST))


if __name__ == "__main__":
    unittest.main()
