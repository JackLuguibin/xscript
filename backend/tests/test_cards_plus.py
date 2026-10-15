"""卡密 enhancements: renewal stacking, trial cards, multi-device cards, abuse alerts."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from xscript_server import abuse, licensing  # noqa: E402
from xscript_server import cards as cardsvc  # noqa: E402
from xscript_server.config import Config  # noqa: E402
from xscript_server.db import Database  # noqa: E402
from xscript_server.models import Card, CardDevice, TrialUse  # noqa: E402

DAY = 86400
T0 = 1_800_000_000


class ServiceTest(unittest.TestCase):
    def setUp(self):
        cfg = Config.load(tempfile.mkdtemp())
        cfg.ensure_dirs()
        self.db = Database(cfg.db_path)
        self.db.create_all()
        self.key = licensing.generate_private()
        self.pub = licensing.public_b64(self.key)

    def make(self, count=1, days=30, app="com.a", **kw):
        with self.db.session() as s:
            _, codes = cardsvc.create_batch(s, count, days, app, **kw)
            s.commit()
        return codes

    def act(self, card, device, now=T0, app="com.a", model="M"):
        with self.db.session() as s:
            return cardsvc.activate_ex(s, self.key, card, device, app, model, now)

    def row(self, card) -> Card:
        with self.db.session() as s:
            c = s.get(Card, card)
            s.expunge(c)
            return c

    # ------------------------------------------------------------ 续期叠加

    def test_second_card_stacks_onto_the_running_one(self):
        a, b = self.make(2, days=30)
        self.assertEqual(self.act(a, "d1").code, "ok")
        self.assertEqual(self.row(a).expires_at, T0 + 30 * DAY)
        r = self.act(b, "d1", now=T0 + 10 * DAY)  # 20 days left on the first card
        self.assertEqual(r.code, "ok")
        self.assertEqual(self.row(b).expires_at, T0 + 60 * DAY)
        payload = licensing.verify(self.pub, r.token)
        self.assertEqual(payload["exp"], T0 + 60 * DAY)

    def test_stacking_starts_now_when_nothing_runs(self):
        a, b = self.make(2, days=30)
        self.act(a, "d1")
        self.act(b, "d1", now=T0 + 40 * DAY)  # first card expired 10 days ago
        self.assertEqual(self.row(b).expires_at, T0 + 70 * DAY)

    def test_stacking_is_per_device_per_app_and_can_be_off(self):
        a, b, c, d = self.make(1, days=30), self.make(1, days=30, app="com.b"), self.make(1, days=30), \
            self.make(1, days=30, stack=False)
        self.act(a[0], "d1")
        self.act(b[0], "d1", app="com.b", now=T0 + DAY)  # other app: no stacking
        self.assertEqual(self.row(b[0]).expires_at, T0 + DAY + 30 * DAY)
        self.act(c[0], "d2", now=T0 + DAY)  # other device
        self.assertEqual(self.row(c[0]).expires_at, T0 + DAY + 30 * DAY)
        self.act(d[0], "d1", now=T0 + DAY)  # stack off for this batch
        self.assertEqual(self.row(d[0]).expires_at, T0 + DAY + 30 * DAY)

    def test_permanent_and_revoked_cards_are_not_a_base(self):
        perm, a, rev, b = self.make(1, days=0)[0], self.make(1, days=10)[0], self.make(1, days=30)[0], \
            self.make(1, days=10)[0]
        self.act(perm, "d1")
        self.act(a, "d1", now=T0 + DAY)
        self.assertEqual(self.row(a).expires_at, T0 + DAY + 10 * DAY)
        self.act(rev, "d2")
        with self.db.session() as s:
            s.get(Card, rev).revoked = True
            s.commit()
        self.act(b, "d2", now=T0 + DAY)
        self.assertEqual(self.row(b).expires_at, T0 + DAY + 10 * DAY)

    def test_rebinding_after_unbind_does_not_restack(self):
        a, b = self.make(2, days=30)
        self.act(a, "d1")
        self.act(b, "d1", now=T0 + DAY)
        before = self.row(b).expires_at
        with self.db.session() as s:
            cardsvc.unbind(s, s.get(Card, b))
            s.commit()
        self.act(b, "d1", now=T0 + 5 * DAY)
        self.assertEqual(self.row(b).expires_at, before)

    # ------------------------------------------------------------ 体验卡

    def test_trial_validation(self):
        with self.db.session() as s:
            with self.assertRaises(ValueError):
                cardsvc.create_batch(s, 1, 0, "com.a", kind="trial")
            with self.assertRaises(ValueError):
                cardsvc.create_batch(s, 1, 31, "com.a", kind="trial")
            with self.assertRaises(ValueError):
                cardsvc.create_batch(s, 1, 1, "com.a", kind="bogus")
            _, codes = cardsvc.create_batch(s, 1, 1 / 24, "com.a", kind="trial", max_devices=5, stack=True)
            c = s.get(Card, codes[0])
            self.assertEqual((c.kind, c.max_devices, c.stack), ("trial", 1, False))

    def test_one_trial_per_device_and_app(self):
        t1, t2, t3 = self.make(3, days=1, kind="trial")
        r = self.act(t1, "d1")
        self.assertEqual(r.code, "ok")
        self.assertEqual(self.row(t1).expires_at, T0 + DAY)
        again = self.act(t1, "d1", now=T0 + 100)  # the same card on the same device keeps working
        self.assertEqual(again.code, "ok")
        denied = self.act(t2, "d1", now=T0 + 2 * DAY)
        self.assertEqual((denied.code, denied.error), ("trial_used", "此设备已使用过体验卡"))
        self.assertIsNone(self.row(t2).device)  # the second card stays unused
        self.assertEqual(self.act(t2, "d2").code, "ok")  # another device is fine
        self.assertEqual(self.act(t3, "d1", app="com.other").code, "wrong_app")
        other_app = self.make(1, days=1, kind="trial", app="*")[0]
        self.assertEqual(self.act(other_app, "d1", app="com.other", now=T0 + 2 * DAY).code, "ok")

    def test_trial_use_survives_unbind_and_delete(self):
        t1, t2 = self.make(2, days=1, kind="trial")
        self.act(t1, "d1")
        with self.db.session() as s:
            cardsvc.unbind(s, s.get(Card, t1))
            s.commit()
        self.assertEqual(self.act(t2, "d1").code, "trial_used")
        # The original card may be taken by another device afterwards, but not by a device that had a trial.
        self.assertEqual(self.act(t1, "d3").code, "ok")
        with self.db.session() as s:
            s.delete(s.get(Card, t1))
            s.commit()
            self.assertIsNotNone(s.query(TrialUse).filter_by(device="d1").first())

    def test_trial_does_not_stack_and_paid_card_stacks_onto_it(self):
        paid, trial = self.make(1, days=30)[0], self.make(1, days=2, kind="trial")[0]
        self.act(paid, "d1")
        self.act(trial, "d1", now=T0 + DAY)
        self.assertEqual(self.row(trial).expires_at, T0 + DAY + 2 * DAY)  # not after the paid card
        paid2 = self.make(1, days=30)[0]
        self.act(paid2, "d2")
        trial2 = self.make(1, days=1, kind="trial")[0]
        self.act(trial2, "d2", now=T0 + 1)
        paid3 = self.make(1, days=10)[0]
        self.act(paid3, "d2", now=T0 + 2)
        self.assertEqual(self.row(paid3).expires_at, T0 + 30 * DAY + 10 * DAY)

    # ------------------------------------------------------------ 多设备卡

    def test_multi_device_limit(self):
        c = self.make(1, days=10, max_devices=3)[0]
        for i, d in enumerate(("d1", "d2", "d3")):
            r = self.act(c, d, now=T0 + i)
            self.assertEqual((r.code, r.new_device), ("ok", True), d)
        row = self.row(c)
        self.assertEqual(row.expires_at, T0 + 10 * DAY)  # one shared expiry, from the first activation
        self.assertEqual(sorted(cardsvc.bound_devices(row)), ["d1", "d2", "d3"])
        r = self.act(c, "d4")
        self.assertEqual((r.code, r.error), ("limit", "卡密绑定的设备数已达上限（3 台）"))
        again = self.act(c, "d2")
        self.assertEqual((again.code, again.new_device), ("ok", False))
        self.assertEqual(licensing.verify(self.pub, again.token)["device"], "d2")

    def test_single_device_card_message_is_unchanged(self):
        c = self.make(1)[0]
        self.act(c, "d1")
        self.assertEqual(self.act(c, "d2").error, "卡密已绑定其他设备")

    def test_unbind_one_device_and_promote(self):
        c = self.make(1, max_devices=3)[0]
        for d in ("d1", "d2", "d3"):
            self.act(c, d)
        with self.db.session() as s:
            row = s.get(Card, c)
            self.assertEqual(cardsvc.unbind(s, row, "d2"), 1)
            self.assertEqual(cardsvc.unbind(s, row, "nope"), 0)
            s.commit()
            self.assertEqual(sorted(cardsvc.bound_devices(row)), ["d1", "d3"])
            self.assertEqual(cardsvc.unbind(s, row, "d1"), 1)  # the first one: d3 takes over
            s.commit()
            self.assertEqual((row.device, list(cardsvc.bound_devices(row))), ("d3", ["d3"]))
            self.assertEqual(s.query(CardDevice).count(), 0)
            self.assertEqual(cardsvc.status_of(row, T0), "active")
            self.assertEqual(cardsvc.unbind(s, row), 1)
            s.commit()
            self.assertEqual(cardsvc.status_of(row, T0), "unbound")
        self.assertEqual(self.act(c, "d9").code, "ok")

    def test_verify_checks_every_bound_device(self):
        c = self.make(1, max_devices=2)[0]
        tokens = {d: self.act(c, d).token for d in ("d1", "d2")}
        with self.db.session() as s:
            for d, t in tokens.items():
                self.assertEqual(cardsvc.check_token(s, licensing.verify(self.pub, t)), "ok", d)
            cardsvc.unbind(s, s.get(Card, c), "d2")
            s.commit()
            self.assertEqual(cardsvc.check_token(s, licensing.verify(self.pub, tokens["d2"])), "revoked")
            self.assertEqual(cardsvc.check_token(s, licensing.verify(self.pub, tokens["d1"])), "ok")

    def test_multi_device_card_never_stacks(self):
        a = self.make(1, days=30)[0]
        m = self.make(1, days=10, max_devices=2)[0]
        self.act(a, "d1")
        self.act(m, "d1", now=T0 + DAY)
        self.assertEqual(self.row(m).expires_at, T0 + DAY + 10 * DAY)


class MigrateCardsTest(unittest.TestCase):
    def test_old_cards_table_gets_the_new_columns(self):
        import sqlite3

        cfg = Config.load(tempfile.mkdtemp())
        cfg.ensure_dirs()
        con = sqlite3.connect(cfg.db_path)
        con.executescript(
            "CREATE TABLE cards (card VARCHAR(40) PRIMARY KEY, batch VARCHAR(32), days FLOAT, app VARCHAR(128),"
            " note VARCHAR(255), created_at INTEGER, device VARCHAR(128), model VARCHAR(128), activated_at INTEGER,"
            " expires_at INTEGER, revoked BOOLEAN, last_verified_at INTEGER);"
            "INSERT INTO cards VALUES ('XS-OLD', 'b', 30, '*', '', 1, 'dev', 'M', 5, 99, 0, NULL);"
            "PRAGMA user_version = 3;")
        con.commit()
        con.close()
        db = Database(cfg.db_path)
        db.create_all()
        with db.session() as s:
            c = s.get(Card, "XS-OLD")
            self.assertEqual((c.kind, c.max_devices, c.stack, c.device), ("normal", 1, True, "dev"))
            self.assertEqual(cardsvc.status_of(c, 50), "active")
            self.assertEqual(list(cardsvc.bound_devices(c)), ["dev"])


class AbuseMonitorTest(unittest.TestCase):
    TH = {"abuse_card_devices": 3, "abuse_device_cards": 3, "abuse_ip_devices": 3, "abuse_ip_failures": 3}

    def test_card_shared(self):
        m = abuse.AbuseMonitor()
        out = []
        for i, d in enumerate(("d1", "d2", "d3", "d4")):
            out += m.observe("bound_other", "XS-1", d, "1.1.1.1", self.TH, now=T0 + i)
        self.assertEqual([(f.signal, f.subject, f.count) for f in out], [("card_shared", "XS-1", 3)])
        self.assertIn("XS-1", out[0].text)

    def test_same_device_retrying_is_not_sharing(self):
        m = abuse.AbuseMonitor()
        out = [f for i in range(10) for f in m.observe("limit", "XS-1", "d1", "ip", self.TH, now=T0 + i)]
        self.assertEqual(out, [])

    def test_device_many_cards_and_ip_many_devices(self):
        m = abuse.AbuseMonitor()
        signals = []
        for i in range(3):
            signals += [f.signal for f in m.observe("ok", "XS-%d" % i, "dev", "ip%d" % i, self.TH, now=T0 + i)]
        self.assertEqual(signals, ["device_many_cards"])
        signals = []
        for i in range(3):
            signals += [f.signal for f in m.observe("ok", "XS-%d" % i, "dev%d" % i, "same", self.TH, now=T0 + i)]
        self.assertEqual(signals, ["ip_many_devices"])

    def test_guessing_counts_every_attempt(self):
        m = abuse.AbuseMonitor()
        out = [f for i in range(3) for f in m.observe("not_found", "XS-X", "d", "9.9.9.9", self.TH, now=T0 + i)]
        self.assertEqual([f.signal for f in out], ["ip_guessing"])

    def test_cooldown_window_and_off_switch(self):
        m = abuse.AbuseMonitor()
        for i in range(3):
            m.observe("bound_other", "XS-1", "d%d" % i, "ip", self.TH, now=T0 + i)
        self.assertEqual(m.observe("bound_other", "XS-1", "d9", "ip", self.TH, now=T0 + 100), [])  # cooling down
        again = m.observe("bound_other", "XS-1", "d10", "ip", self.TH, now=T0 + abuse.COOLDOWN_S + 200)
        self.assertEqual(len(again), 1)
        # Attempts older than 24 h drop out of the window.
        m2 = abuse.AbuseMonitor()
        m2.observe("bound_other", "XS-2", "a", "ip", self.TH, now=T0)
        m2.observe("bound_other", "XS-2", "b", "ip", self.TH, now=T0 + 1)
        self.assertEqual(m2.observe("bound_other", "XS-2", "c", "ip", self.TH, now=T0 + abuse.WINDOW_S + 5), [])
        off = dict(self.TH, abuse_card_devices=0)
        m3 = abuse.AbuseMonitor()
        self.assertEqual([f for i in range(10) for f in m3.observe("limit", "XS-3", "d%d" % i, "ip", off, now=T0 + i)], [])


try:
    import httpx

    from test_server import CSRF, Server
    from xscript_server.__main__ import main as cli
    SKIP = ""
except ImportError as e:  # pragma: no cover
    SKIP = "server deps missing: %s" % e


@unittest.skipIf(SKIP, SKIP)
class HttpTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg = Config.load(os.path.join(cls.tmp, "data"), web_dir=os.path.join(cls.tmp, "noweb"))
        os.environ["XSCRIPT_ADMIN_PASSWORD"] = "admin-pass-123"
        assert cli(["--data", str(cls.cfg.data_dir), "init"]) == 0
        cls.srv = Server(cls.cfg).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.srv.__exit__(None, None, None)

    async def asyncSetUp(self):
        self.admin = await self.login("admin", "admin-pass-123")
        self.pub = (await self.admin.get("/api/cards/public-key")).json()["public_key"]

    async def asyncTearDown(self):
        await self.admin.aclose()

    async def login(self, user, pw):
        c = httpx.AsyncClient(base_url=self.srv.base, headers=CSRF, timeout=30)
        r = await c.post("/api/auth/login", json={"username": user, "password": pw})
        self.assertEqual(r.status_code, 200, r.text)
        return c

    async def make_user(self, name, role):
        r = await self.admin.post("/api/users", json={"username": name, "password": "password-" + name, "role": role})
        self.assertIn(r.status_code, (200, 409), r.text)
        return await self.login(name, "password-" + name)

    async def batch(self, client=None, **body):
        r = await (client or self.admin).post("/api/cards/batches", json={"count": 1, "days": 30, "app": "com.a", **body})
        return r

    def activate(self, app, card, device, a="com.a"):
        return app.post("/license/activate", json={"card": card, "device_id": device, "app": a, "model": "M"})

    async def test_stacking_over_http(self):
        r = await self.batch(count=2)
        c1, c2 = r.json()["cards"]
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            t1 = licensing.verify(self.pub, (await self.activate(app, c1, "stackdev")).json()["token"])
            t2 = licensing.verify(self.pub, (await self.activate(app, c2, "stackdev")).json()["token"])
        self.assertAlmostEqual(t2["exp"] - t1["exp"], 30 * DAY, delta=3)
        items = {c["card"]: c for c in (await self.admin.get("/api/cards", params={"q": "stackdev"})).json()["items"]}
        self.assertEqual(items[c2]["stack"], True)
        # Turning stacking off for a batch.
        c3 = (await self.batch(stack=False)).json()["cards"][0]
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            t3 = licensing.verify(self.pub, (await self.activate(app, c3, "stackdev")).json()["token"])
        self.assertAlmostEqual(t3["exp"] - t3["iat"], 30 * DAY, delta=3)

    async def test_trial_cards_over_http(self):
        self.assertEqual((await self.batch(kind="trial", days=45)).status_code, 400)
        self.assertEqual((await self.batch(kind="trial", days=0)).status_code, 400)
        self.assertEqual((await self.batch(kind="nope")).status_code, 422)
        r = await self.batch(count=2, kind="trial", hours=2, max_devices=4)  # trials are forced to one device
        self.assertEqual(r.status_code, 200, r.text)
        c1, c2 = r.json()["cards"]
        items = {c["card"]: c for c in (await self.admin.get("/api/cards", params={"kind": "trial"})).json()["items"]}
        self.assertEqual((items[c1]["kind"], items[c1]["max_devices"]), ("trial", 1))
        self.assertAlmostEqual(items[c1]["days"], 2 / 24)
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            tok = licensing.verify(self.pub, (await self.activate(app, c1, "trialdev")).json()["token"])
            self.assertAlmostEqual(tok["exp"] - tok["iat"], 7200, delta=3)
            r = await self.activate(app, c2, "trialdev")
            self.assertEqual((r.status_code, r.json()["error"]), (403, "此设备已使用过体验卡"))
        csv_text = (await self.admin.get("/api/cards/export", params={"kind": "trial"})).text
        self.assertIn("体验卡", csv_text)
        batches = (await self.admin.get("/api/cards/batches")).json()["items"]
        self.assertTrue(any(b["kind"] == "trial" for b in batches))

    async def test_multi_device_over_http_and_unbind_one(self):
        c = (await self.batch(max_devices=2)).json()["cards"][0]
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            self.assertEqual((await self.activate(app, c, "mdA")).status_code, 200)
            self.assertEqual((await self.activate(app, c, "mdB")).status_code, 200)
            r = await self.activate(app, c, "mdC")
            self.assertEqual((r.status_code, r.json()["error"]), (403, "卡密绑定的设备数已达上限（2 台）"))
            tok = (await self.activate(app, c, "mdB")).json()["token"]
        item = (await self.admin.get("/api/cards", params={"q": c})).json()["items"][0]
        self.assertEqual([d["device"] for d in item["devices"]], ["mdA", "mdB"])
        self.assertEqual(item["status"], "active")
        r = await self.admin.post("/api/cards/actions", json={"cards": [c], "action": "unbind", "device": "mdB"})
        self.assertEqual(r.json(), {"updated": 1})
        r = await self.admin.post("/api/cards/actions", json={"cards": [c], "action": "unbind", "device": "mdB"})
        self.assertEqual(r.json(), {"updated": 0})
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            self.assertEqual((await app.post("/license/verify", json={"token": tok})).json()["status"], "revoked")
            self.assertEqual((await self.activate(app, c, "mdC")).status_code, 200)
        item = (await self.admin.get("/api/cards", params={"q": c})).json()["items"][0]
        self.assertEqual([d["device"] for d in item["devices"]], ["mdA", "mdC"])
        audit = (await self.admin.get("/api/audit", params={"action": "card.unbind"})).json()["items"]
        self.assertEqual(audit[0]["detail"]["device"], "mdB")

    async def test_permissions(self):
        viewer = await self.make_user("cviewer", "viewer")
        op = await self.make_user("cop", "operator")
        try:
            body = {"count": 1, "days": 1, "kind": "trial", "max_devices": 1}
            self.assertEqual((await viewer.post("/api/cards/batches", json=body)).status_code, 403)
            self.assertEqual((await viewer.post("/api/cards/batches", json={"count": 1, "max_devices": 3})).status_code, 403)
            self.assertEqual((await op.post("/api/cards/batches", json=body)).status_code, 200)
            c = (await op.post("/api/cards/batches", json={"count": 1, "max_devices": 3})).json()["cards"][0]
            act = {"cards": [c], "action": "unbind", "device": "x"}
            self.assertEqual((await viewer.post("/api/cards/actions", json=act)).status_code, 403)
            self.assertEqual((await op.post("/api/cards/actions", json=act)).status_code, 200)
            # Only admins delete; viewers can read the findings, nobody anonymous can.
            self.assertEqual((await op.post("/api/cards/actions", json={"cards": [c], "action": "delete"})).status_code, 403)
            self.assertEqual((await viewer.get("/api/cards/abuse")).status_code, 200)
            async with httpx.AsyncClient(base_url=self.srv.base) as anon:
                self.assertEqual((await anon.get("/api/cards/abuse")).status_code, 401)
            # Thresholds are settings: admin only.
            self.assertEqual((await op.put("/api/settings", json={"abuse_card_devices": 9})).status_code, 403)
            self.assertEqual((await self.admin.put("/api/settings", json={"abuse_card_devices": 3})).status_code, 200)
            self.assertEqual((await self.admin.put("/api/settings", json={"abuse_card_devices": -1})).status_code, 422)
        finally:
            await viewer.aclose()
            await op.aclose()

    async def test_abuse_alert_is_audited_listed_and_pushed(self):
        c = self.srv.app.state.ctx
        sent = []
        real = c.alerts.emit
        c.alerts.emit = lambda event, subject, text: sent.append((event, subject, text))
        try:
            card = (await self.batch()).json()["cards"][0]
            await self.admin.put("/api/settings", json={"abuse_card_devices": 2})
            async with httpx.AsyncClient(base_url=self.srv.base) as app:
                self.assertEqual((await self.activate(app, card, "abOwner")).status_code, 200)
                for d in ("abX", "abY"):
                    self.assertEqual((await self.activate(app, card, d)).status_code, 403)
            for _ in range(50):
                if sent:
                    break
                await asyncio.sleep(0.02)
            self.assertEqual(len(sent), 1, sent)
            self.assertEqual(sent[0][0], "card_abuse")
            self.assertIn(card, sent[0][1])
            self.assertIn("卡密疑似被多人共享", sent[0][2])
            items = (await self.admin.get("/api/cards/abuse")).json()["items"]
            hit = next(i for i in items if i["subject"] == card)
            self.assertEqual((hit["signal"], hit["count"], hit["label"]), ("card_shared", 2, "卡密疑似被多人共享"))
            self.assertTrue(any(a["action"] == "card.abuse" for a in (await self.admin.get(
                "/api/audit", params={"action": "card.abuse"})).json()["items"]))
            # The same card keeps being tried: reported once per cooldown, not per request.
            async with httpx.AsyncClient(base_url=self.srv.base) as app:
                await self.activate(app, card, "abZ")
            self.assertEqual(len(sent), 1)
        finally:
            c.alerts.emit = real
            await self.admin.put("/api/settings", json={"abuse_card_devices": 3})

    async def test_card_abuse_is_a_webhook_event(self):
        r = await self.admin.get("/api/settings")
        self.assertIn("card_abuse", r.json()["alert_events"])
        r = await self.admin.put("/api/settings", json={"alert_webhooks": [
            {"name": "x", "kind": "generic", "url": "https://example.com/h", "events": ["card_abuse"]}]})
        self.assertEqual(r.status_code, 200, r.text)
        await self.admin.put("/api/settings", json={"alert_webhooks": []})


if __name__ == "__main__":
    unittest.main()
