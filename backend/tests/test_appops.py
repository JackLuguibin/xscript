"""Login IP allowlist, app announcements and forced APK updates."""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from xscript_server import maintenance, netcheck  # noqa: E402
from xscript_server.audit import set_setting  # noqa: E402
from xscript_server.config import Config  # noqa: E402
from xscript_server.models import AppUpdate, PackJob  # noqa: E402


class NetcheckTest(unittest.TestCase):
    def test_matching(self):
        self.assertTrue(netcheck.allowed("1.2.3.4", []))  # empty list = feature off
        self.assertTrue(netcheck.allowed("1.2.3.4", None))
        lst = ["203.0.113.7", "10.0.0.0/8", "2001:db8::/32"]
        for ip in ("203.0.113.7", "10.255.1.2", "2001:db8::5", "::ffff:10.1.1.1"):
            self.assertTrue(netcheck.allowed(ip, lst), ip)
        for ip in ("203.0.113.8", "11.0.0.1", "2001:db9::1", "", "not-an-ip", "::1"):
            self.assertFalse(netcheck.allowed(ip, lst), ip)

    def test_normalize_and_validation(self):
        self.assertEqual(netcheck.normalize(["1.2.3.4", " 1.2.3.4 ", "10.1.2.3/8", "::1"]), ["1.2.3.4", "10.0.0.0/8", "::1"])
        for bad in ("", "1.2.3", "10.0.0.0/33", "a b", "999.1.1.1", "1.2.3.4/x"):
            with self.assertRaises(ValueError, msg=bad):
                netcheck.normalize([bad])


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
        cls.ctx = cls.srv.app.state.ctx

    @classmethod
    def tearDownClass(cls):
        cls.srv.__exit__(None, None, None)

    async def asyncSetUp(self):
        self.admin = await self.login("admin", "admin-pass-123")

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

    def set_allowlist_directly(self, entries):
        with self.ctx.db.session() as s:
            set_setting(s, "login_ip_allowlist", entries)
            s.commit()

    # ------------------------------------------------------------ 登录 IP 白名单

    async def test_allowlist_validation_and_self_lockout_guard(self):
        r = await self.admin.put("/api/settings", json={"login_ip_allowlist": ["10.0.0.0/8"]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("锁在外面", r.json()["error"])
        self.assertEqual((await self.admin.put("/api/settings", json={"login_ip_allowlist": ["nope"]})).status_code, 400)
        r = await self.admin.put("/api/settings", json={"login_ip_allowlist": ["127.0.0.1", "10.0.0.0/8"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["login_ip_allowlist"], ["127.0.0.1", "10.0.0.0/8"])
        self.assertEqual((r.json()["your_ip"], r.json()["login_ip_allowlist_on"]), ("127.0.0.1", True))
        self.assertEqual((await self.admin.get("/api/auth/me")).status_code, 200)  # still in
        op = await self.make_user("allowop", "operator")
        try:
            self.assertEqual((await op.put("/api/settings", json={"login_ip_allowlist": []})).status_code, 403)
            viewer_view = (await op.get("/api/settings")).json()
            self.assertEqual((viewer_view["login_ip_allowlist"], viewer_view["login_ip_allowlist_on"]), ([], True))
        finally:
            await op.aclose()
        r = await self.admin.put("/api/settings", json={"login_ip_allowlist": []})
        self.assertEqual(r.json()["login_ip_allowlist_on"], False)

    async def test_blocked_ip_cannot_login_or_use_a_session_and_cli_resets(self):
        try:
            self.set_allowlist_directly(["10.0.0.0/8"])  # this test client is 127.0.0.1
            async with httpx.AsyncClient(base_url=self.srv.base, headers=CSRF) as anon:
                r = await anon.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-123"})
                self.assertEqual((r.status_code, r.json()["error"]), (403, "当前 IP 不在登录白名单内"))
                # No password oracle: a wrong password gets the same answer.
                r = await anon.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
                self.assertEqual(r.status_code, 403)
            # An already-open session stops working too.
            self.assertEqual((await self.admin.get("/api/auth/me")).status_code, 403)
            # The public endpoints that apps use are not affected.
            async with httpx.AsyncClient(base_url=self.srv.base) as app:
                self.assertEqual((await app.get("/api/health")).status_code, 200)
                self.assertEqual((await app.post("/license/activate", json={"card": "XS-X", "device_id": "d"})).status_code, 403)
                self.assertEqual((await app.get("/pub/app-notices", params={"app": "com.a"})).status_code, 200)
            self.assertEqual(cli(["--data", str(self.cfg.data_dir), "reset-allowlist"]), 0)
            self.assertEqual((await self.admin.get("/api/auth/me")).status_code, 200)
        finally:
            self.set_allowlist_directly([])
        audit = (await self.admin.get("/api/audit", params={"action": "auth.ip_denied"})).json()["items"]
        self.assertTrue(audit and audit[0]["target"] == "127.0.0.1")

    # ------------------------------------------------------------ 公告

    async def test_notice_permissions_and_public_feed(self):
        viewer = await self.make_user("noticeviewer", "viewer")
        op = await self.make_user("noticeop", "operator")
        try:
            body = {"app": "com.notice.app", "title": "维护通知", "body": "今晚 23:00 维护", "level": "warning"}
            self.assertEqual((await viewer.post("/api/app-notices", json=body)).status_code, 403)
            r = await op.post("/api/app-notices", json=body)
            self.assertEqual(r.status_code, 200, r.text)
            n = r.json()
            self.assertTrue(n["active"])
            self.assertEqual((await viewer.get("/api/app-notices")).status_code, 200)
            self.assertEqual((await op.post("/api/app-notices", json={**body, "app": "bad app"})).status_code, 422)
            self.assertEqual((await op.post("/api/app-notices", json={**body, "level": "x"})).status_code, 422)
            self.assertEqual((await op.post("/api/app-notices", json={**body, "starts_at": 100, "ends_at": 50})).status_code, 422)

            async with httpx.AsyncClient(base_url=self.srv.base) as app:
                feed = lambda a: app.get("/pub/app-notices", params={"app": a, "version_code": 1})  # noqa: E731
                self.assertEqual([i["title"] for i in (await feed("com.notice.app")).json()["items"]], ["维护通知"])
                self.assertEqual((await feed("com.other.app")).json()["items"], [])
                self.assertEqual((await app.get("/pub/app-notices", params={"app": "*"})).status_code, 422)
                self.assertEqual((await app.get("/pub/app-notices")).status_code, 422)
                # A * notice reaches every app; disabled and out-of-window ones do not.
                star = (await op.post("/api/app-notices", json={"app": "*", "title": "全局", "level": "info"})).json()
                titles = [i["title"] for i in (await feed("com.notice.app")).json()["items"]]
                self.assertEqual(titles, ["全局", "维护通知"])  # newest first
                now = int(time.time())
                await op.patch("/api/app-notices/%d" % star["id"], json={"starts_at": now + 3600})
                self.assertEqual([i["title"] for i in (await feed("com.notice.app")).json()["items"]], ["维护通知"])
                listed = {i["id"]: i for i in (await op.get("/api/app-notices")).json()["items"]}
                self.assertFalse(listed[star["id"]]["active"])
                await op.patch("/api/app-notices/%d" % star["id"], json={"starts_at": None, "ends_at": now - 5})
                self.assertEqual([i["title"] for i in (await feed("com.notice.app")).json()["items"]], ["维护通知"])
                await op.patch("/api/app-notices/%d" % n["id"], json={"enabled": False})
                self.assertEqual((await feed("com.notice.app")).json()["items"], [])
                # Only the five newest are served.
                for i in range(7):
                    await op.post("/api/app-notices", json={"app": "com.many.app", "title": "n%d" % i})
                got = (await feed("com.many.app")).json()["items"]
                self.assertEqual([x["title"] for x in got], ["n6", "n5", "n4", "n3", "n2"])
            self.assertEqual((await op.delete("/api/app-notices/%d" % n["id"])).status_code, 200)
            self.assertEqual((await op.delete("/api/app-notices/%d" % n["id"])).status_code, 404)
            audit = (await self.admin.get("/api/audit", params={"action": "notice."})).json()["items"]
            self.assertTrue({"notice.create", "notice.update", "notice.delete"} <= {a["action"] for a in audit})
        finally:
            await viewer.aclose()
            await op.aclose()

    # ------------------------------------------------------------ 强制更新

    def make_job(self, app_id, version_code, version, content=b"PK fake apk", status="succeeded", write=True):
        with self.ctx.db.session() as s:
            j = PackJob(status=status, app_id=app_id, app_name="x", version=version, version_code=version_code,
                        apk_file="a.apk", apk_size=len(content))
            s.add(j)
            s.commit()
            jid = j.id
        if write:
            d = self.ctx.packer.job_dir(jid) / "out"
            d.mkdir(parents=True, exist_ok=True)
            (d / "a.apk").write_bytes(content)
        return jid

    async def test_forced_update_policy(self):
        app_id, content = "com.upd.app", b"PK new apk bytes"
        op = await self.make_user("updop", "operator")
        try:
            job = self.make_job(app_id, 5, "1.5.0", content)
            other = self.make_job("com.someone.else", 9, "9.0")
            failed = self.make_job(app_id, 6, "1.6.0", status="failed")
            put = lambda c, body, a=app_id: c.put("/api/app-updates/" + a, json=body)  # noqa: E731
            self.assertEqual((await put(op, {"job_id": job})).status_code, 403)  # admin only
            async with httpx.AsyncClient(base_url=self.srv.base) as anon:
                self.assertEqual((await put(anon, {"job_id": job})).status_code, 401)
                q = lambda v: anon.get("/pub/app-update", params={"app": app_id, "version_code": v})  # noqa: E731
                self.assertEqual((await q(1)).json(), {"update": False, "force": False})  # no policy yet
            self.assertEqual((await put(self.admin, {"job_id": other})).status_code, 400)  # another app's build
            self.assertEqual((await put(self.admin, {"job_id": failed})).status_code, 400)
            self.assertEqual((await put(self.admin, {})).status_code, 400)
            self.assertEqual((await put(self.admin, {"job_id": job, "min_code": 6})).status_code, 400)  # above latest
            self.assertEqual((await put(self.admin, {"url": "ftp://x/y"})).status_code, 422)
            self.assertEqual((await put(self.admin, {"url": "https://dl.example.com/a.apk"})).status_code, 400)  # no version
            self.assertEqual((await put(self.admin, {"job_id": job}, "bad app")).status_code, 400)  # not a package name
            r = await put(self.admin, {"job_id": job, "min_code": 3, "notes": "修复崩溃"})
            self.assertEqual(r.status_code, 200, r.text)
            pol = r.json()
            self.assertEqual((pol["latest_code"], pol["latest_name"], pol["min_code"], pol["size"]), (5, "1.5.0", 3, len(content)))
            self.assertEqual(pol["sha256"], hashlib.sha256(content).hexdigest())
            self.assertTrue(pol["apk_available"])

            async with httpx.AsyncClient(base_url=self.srv.base) as anon:
                q = lambda v: anon.get("/pub/app-update", params={"app": app_id, "version_code": v})  # noqa: E731
                old = (await q(2)).json()  # below the minimum: must update
                self.assertEqual((old["update"], old["force"], old["latest_version_code"], old["min_version_code"]), (True, True, 5, 3))
                self.assertEqual((old["latest_version_name"], old["notes"]), ("1.5.0", "修复崩溃"))
                self.assertEqual(old["sha256"], hashlib.sha256(content).hexdigest())
                mid = (await q(4)).json()  # newer exists but this version may keep running
                self.assertEqual((mid["update"], mid["force"]), (True, False))
                cur = (await q(5)).json()
                self.assertEqual((cur["update"], cur["force"]), (False, False))
                self.assertEqual((await q(99)).json()["update"], False)
                self.assertEqual((await anon.get("/pub/app-update", params={"app": app_id})).status_code, 422)
                self.assertEqual((await anon.get("/pub/app-update", params={"app": "*", "version_code": 1})).status_code, 422)
                apk = await anon.get(old["url"])
                self.assertEqual((apk.status_code, apk.content), (200, content))
                self.assertEqual((await anon.get("/pub/app-update/apk", params={"app": "com.nobody.app"})).status_code, 404)

            # The job behind a live policy cannot be deleted or cleaned up by retention.
            self.assertEqual((await self.admin.delete("/api/pack/jobs/%d" % job)).status_code, 400)
            res = maintenance.run_retention(self.cfg, self.ctx.db, {"keep_pack_jobs": 1})
            self.assertTrue(self.ctx.packer.job_dir(job).exists(), res)

            # An external download link needs a version, and may carry a checksum.
            r = await put(self.admin, {"url": "https://dl.example.com/a.apk", "latest_code": 7, "latest_name": "1.7.0",
                                       "sha256": "AB" * 32, "min_code": 7})
            self.assertEqual(r.status_code, 200, r.text)
            async with httpx.AsyncClient(base_url=self.srv.base) as anon:
                got = (await anon.get("/pub/app-update", params={"app": app_id, "version_code": 5})).json()
                self.assertEqual((got["force"], got["url"], got["sha256"]), (True, "https://dl.example.com/a.apk", "ab" * 32))
            self.assertEqual((await put(self.admin, {"url": "https://x/y.apk", "latest_code": 7, "sha256": "zz"})).status_code, 400)
            self.assertEqual((await self.admin.get("/api/app-updates")).json()["items"][0]["app"], app_id)

            # A cleaned-up APK must not lock users out.
            gone = self.make_job("com.gone.app", 2, "2.0", write=False)
            self.assertEqual((await put(self.admin, {"job_id": gone, "min_code": 2}, "com.gone.app")).status_code, 400)
            with self.ctx.db.session() as s:
                s.add(AppUpdate(app="com.gone.app", latest_code=2, min_code=2, job_id=gone))
                s.commit()
            async with httpx.AsyncClient(base_url=self.srv.base) as anon:
                self.assertEqual((await anon.get("/pub/app-update", params={"app": "com.gone.app", "version_code": 1})).json(),
                                 {"update": False, "force": False})
            self.assertEqual((await self.admin.delete("/api/app-updates/" + app_id)).status_code, 200)
            self.assertEqual((await self.admin.delete("/api/app-updates/" + app_id)).status_code, 404)
            audit = (await self.admin.get("/api/audit", params={"action": "app.update"})).json()["items"]
            self.assertTrue({"app.update_set", "app.update_clear"} <= {a["action"] for a in audit})
        finally:
            await op.aclose()

    async def test_public_url_makes_the_apk_link_absolute(self):
        job = self.make_job("com.abs.app", 3, "3.0")
        await self.admin.put("/api/settings", json={"public_url": "https://cloud.example.com/"})
        try:
            await self.admin.put("/api/app-updates/com.abs.app", json={"job_id": job})
            async with httpx.AsyncClient(base_url=self.srv.base) as anon:
                got = (await anon.get("/pub/app-update", params={"app": "com.abs.app", "version_code": 1})).json()
            self.assertEqual(got["url"], "https://cloud.example.com/pub/app-update/apk?app=com.abs.app")
        finally:
            await self.admin.put("/api/settings", json={"public_url": ""})


if __name__ == "__main__":
    unittest.main()
