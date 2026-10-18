"""Account security edge cases: sessions, password change, API tokens, 2FA misuse, device keys,
and role checks on scheduled deploy tasks. Same live-uvicorn setup as test_server."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from test_server import CSRF, SKIP, FakeDevice, Server  # noqa: E402

if not SKIP:
    import httpx
    import websockets

    from xscript_server import totp
    from xscript_server.__main__ import main as cli
    from xscript_server.config import Config


@unittest.skipIf(SKIP, SKIP)
class AuthSecurityTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg = Config.load(os.path.join(cls.tmp, "data"), web_dir=os.path.join(cls.tmp, "noweb"))
        cls.cfg.scheduler_interval = 3600  # no background runs: tasks are only run on request
        os.environ["XSCRIPT_ADMIN_PASSWORD"] = "admin-pass-123"
        assert cli(["--data", str(cls.cfg.data_dir), "init"]) == 0
        cls.srv = Server(cls.cfg).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.srv.__exit__(None, None, None)

    async def asyncSetUp(self):
        self.clients = []
        self.admin = await self.login("admin", "admin-pass-123")

    async def asyncTearDown(self):
        for c in self.clients:
            await c.aclose()

    async def login(self, user, pw, expect=200):
        c = httpx.AsyncClient(base_url=self.srv.base, headers=CSRF, timeout=30)
        self.clients.append(c)
        r = await c.post("/api/auth/login", json={"username": user, "password": pw})
        self.assertEqual(r.status_code, expect, r.text)
        return c

    async def user(self, name, role, pw=None):
        pw = pw or "password-" + name
        r = await self.admin.post("/api/users", json={"username": name, "password": pw, "role": role})
        self.assertEqual(r.status_code, 200, r.text)
        return await self.login(name, pw), r.json()["id"]

    async def test_logout_revokes_the_session_server_side(self):
        c, _ = await self.user("lo1", "viewer")
        stolen = dict(c.cookies)
        self.assertEqual((await c.post("/api/auth/logout")).status_code, 200)
        async with httpx.AsyncClient(base_url=self.srv.base, cookies=stolen) as replay:
            self.assertEqual((await replay.get("/api/auth/me")).status_code, 401, "old cookie must be dead")

    async def test_password_change_rules_and_other_sessions(self):
        a, _ = await self.user("pw1", "viewer")
        b = await self.login("pw1", "password-pw1")
        r = await a.post("/api/auth/password", json={"old_password": "wrong", "new_password": "a-new-password"})
        self.assertEqual(r.status_code, 400)
        r = await a.post("/api/auth/password", json={"old_password": "password-pw1", "new_password": "short"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("至少", r.json()["error"])
        r = await a.post("/api/auth/password", json={"old_password": "password-pw1", "new_password": "a-new-password"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await a.get("/api/auth/me")).status_code, 200, "current session stays")
        self.assertEqual((await b.get("/api/auth/me")).status_code, 401, "other sessions are signed out")
        await self.login("pw1", "password-pw1", expect=401)
        await self.login("pw1", "a-new-password")

    async def test_password_and_totp_checks_are_rate_limited_per_account(self):
        """A signed-in session is not an unlimited guessing oracle for the password or a TOTP code."""
        a, uid = await self.user("lim1", "viewer")
        second = await self.login("lim1", "password-lim1")
        bystander, _ = await self.user("lim2", "viewer")
        wrong = {"old_password": "guess", "new_password": "a-new-password"}
        right = {"old_password": "password-lim1", "new_password": "a-new-password"}
        try:
            codes = [(await a.post("/api/auth/password", json=wrong)).status_code for _ in range(5)]
            self.assertEqual(codes, [400] * 5)
            r = await a.post("/api/auth/password", json=right)
            self.assertEqual(r.status_code, 429, "locked even with the right password")
            self.assertIn("秒后再试", r.json()["error"])
            # Per account: another session of the same user is locked too (here for a TOTP code)...
            self.assertEqual((await second.post("/api/auth/totp/setup")).status_code, 200)
            self.assertEqual((await second.post("/api/auth/totp/enable", json={"code": "000000"})).status_code, 429)
            # ...other users are not.
            r = await bystander.post("/api/auth/password", json={"old_password": "guess", "new_password": "x" * 12})
            self.assertEqual(r.status_code, 400)
        finally:
            self.srv.app.state.ctx.limiter.reset("account|%d" % uid)
        self.assertEqual((await a.post("/api/auth/password", json=right)).status_code, 200)

    async def test_sessions_are_private_per_user(self):
        a, _ = await self.user("ses1", "operator")
        b, _ = await self.user("ses2", "operator")
        await self.login("ses1", "password-ses1")
        mine = (await a.get("/api/auth/sessions")).json()["items"]
        self.assertEqual(len(mine), 2)
        self.assertEqual(sum(x["current"] for x in mine), 1)
        other = next(x for x in mine if not x["current"])
        # Another user cannot end (or even see) my session.
        self.assertEqual((await b.delete("/api/auth/sessions/%d" % other["id"])).status_code, 404)
        self.assertEqual(len((await b.get("/api/auth/sessions")).json()["items"]), 1)
        self.assertEqual((await a.post("/api/auth/sessions/logout-others")).json(), {"ended": 1})
        self.assertEqual(len((await a.get("/api/auth/sessions")).json()["items"]), 1)

    async def test_api_tokens(self):
        a, _ = await self.user("tok1", "operator")
        b, _ = await self.user("tok2", "operator")
        created = (await a.post("/api/auth/tokens", json={"name": "ci", "days": 0})).json()
        self.assertTrue(created["token"].startswith("xsk_"))
        self.assertIsNone(created["expires_at"], "days=0 never expires")
        listed = (await a.get("/api/auth/tokens")).json()["items"]
        self.assertEqual([x["name"] for x in listed], ["ci"])
        self.assertNotIn("token", listed[0], "plain token is only returned once")
        self.assertEqual((await a.post("/api/auth/tokens", json={"name": "x", "days": 4000})).status_code, 422)
        bearer = {"Authorization": "Bearer " + created["token"]}
        async with httpx.AsyncClient(base_url=self.srv.base, headers=bearer) as api:
            self.assertEqual((await api.get("/api/auth/me")).json()["username"], "tok1")
            # A token cannot mint more tokens or enrol 2FA.
            self.assertEqual((await api.post("/api/auth/tokens", json={"name": "y"})).status_code, 403)
            self.assertEqual((await api.post("/api/auth/totp/setup")).status_code, 403)
            self.assertEqual((await b.delete("/api/auth/tokens/%d" % created["id"])).status_code, 404)
            self.assertEqual((await a.delete("/api/auth/tokens/%d" % created["id"])).status_code, 200)
            self.assertEqual((await api.get("/api/auth/me")).status_code, 401)

    async def test_totp_misuse(self):
        c, _ = await self.user("tf1", "viewer")
        self.assertEqual((await c.post("/api/auth/totp/enable", json={"code": "123456"})).status_code, 400)
        self.assertEqual((await c.post("/api/auth/totp/disable", json={"password": "password-tf1", "code": "123456"})).status_code, 400)
        secret = (await c.post("/api/auth/totp/setup")).json()["secret"]
        step = int(time.time() // 30)
        other = await self.login("tf1", "password-tf1")
        r = await c.post("/api/auth/totp/enable", json={"code": totp.code_at(secret, step)})
        self.assertTrue(r.json()["totp_enabled"])
        self.assertEqual((await other.get("/api/auth/me")).status_code, 401, "sessions without 2FA are dropped")
        self.assertEqual((await c.post("/api/auth/totp/setup")).status_code, 400, "no re-enrol while enabled")
        # Disabling needs the password and a fresh (not replayed) code.
        r = await c.post("/api/auth/totp/disable", json={"password": "nope", "code": totp.code_at(secret, step + 1)})
        self.assertEqual(r.status_code, 400)
        r = await c.post("/api/auth/totp/disable", json={"password": "password-tf1", "code": totp.code_at(secret, step)})
        self.assertEqual(r.status_code, 400, "replayed code")
        r = await c.post("/api/auth/totp/disable", json={"password": "password-tf1", "code": totp.code_at(secret, step + 1)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["totp_enabled"])

    async def test_device_key_revoke_kicks_and_blocks(self):
        key = (await self.admin.post("/api/device-keys", json={"name": "k"})).json()
        url = "ws://127.0.0.1:%d/ws?token=%s" % (self.srv.port, key["token"])
        self.assertEqual((await self.admin.post("/api/device-keys", json={"name": "dup", "value": key["token"]})).status_code, 409)
        self.assertEqual((await self.admin.delete("/api/device-keys/%d" % key["id"])).status_code, 400, "revoke first")
        op, _ = await self.user("dk1", "operator")
        self.assertEqual((await op.get("/api/device-keys")).status_code, 403)
        self.assertEqual((await op.post("/api/device-keys", json={"name": "x"})).status_code, 403)
        async with FakeDevice(url, "kick1"):
            for _ in range(100):
                if "kick1" in self.srv.app.state.ctx.hub.conns:
                    break
                await asyncio.sleep(0.02)
            r = (await self.admin.post("/api/device-keys/%d/revoke" % key["id"])).json()
            self.assertEqual(r["disconnected"], 1)
            for _ in range(100):
                if "kick1" not in self.srv.app.state.ctx.hub.conns:
                    break
                await asyncio.sleep(0.02)
            self.assertNotIn("kick1", self.srv.app.state.ctx.hub.conns)
        with self.assertRaises(Exception):
            async with websockets.connect(url) as ws:
                await ws.send('{"type":"hello","device_id":"kick2"}')
                await asyncio.wait_for(ws.recv(), 2)
        self.assertNotIn("kick2", self.srv.app.state.ctx.hub.conns)
        self.assertEqual((await self.admin.post("/api/device-keys/99999/revoke")).status_code, 404)
        self.assertEqual((await self.admin.delete("/api/device-keys/%d" % key["id"])).status_code, 200)

    async def test_operator_cannot_run_or_change_admin_deploy_tasks(self):
        sc = (await self.admin.post("/api/scripts", json={"name": "部署", "project_name": "deploy_t"})).json()
        body = {"target": "all", "every": 600, "command": {"path": "script_deploy", "script_id": sc["id"]}}
        t = (await self.admin.post("/api/tasks", json=body)).json()
        plain = (await self.admin.post("/api/tasks", json={"target": "all", "every": 600, "command": {"path": "app_stop"}})).json()
        op, _ = await self.user("tk1", "operator")
        viewer, _ = await self.user("tk2", "viewer")
        try:
            self.assertEqual((await op.post("/api/tasks/%d/run" % t["id"])).status_code, 403)
            self.assertEqual((await op.patch("/api/tasks/%d" % t["id"], json={"enabled": False})).status_code, 403)
            self.assertEqual((await op.delete("/api/tasks/%d" % t["id"])).status_code, 403)
            # Ordinary tasks stay operator-managed; viewers can only read.
            self.assertEqual((await op.post("/api/tasks/%d/run" % plain["id"])).status_code, 200)
            self.assertEqual((await op.patch("/api/tasks/%d" % plain["id"], json={"name": "renamed"})).json()["name"], "renamed")
            self.assertEqual((await viewer.post("/api/tasks/%d/run" % plain["id"])).status_code, 403)
            self.assertEqual((await viewer.get("/api/tasks")).status_code, 200)
            self.assertEqual((await op.post("/api/tasks/99999/run")).status_code, 404)
            self.assertEqual((await op.post("/api/tasks", json={"target": "all", "every": 1, "daily": "08:00",
                                                                "command": {"path": "x"}})).status_code, 422)
        finally:
            await self.admin.delete("/api/tasks/%d" % t["id"])
            await self.admin.delete("/api/tasks/%d" % plain["id"])


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(SKIP, SKIP)
class RelayAllowlistTest(unittest.TestCase):
    """Operators may only reach read-only / run-stop device endpoints through the HTTP relay."""

    def test_operator_relay_allowlist(self):
        from xscript_server.deps import Principal
        from xscript_server.routes.devices import _relay_allowed

        op = Principal(1, "op", "operator", "web", 1)
        admin = Principal(2, "ad", "admin", "web", 2)
        allowed = [("GET", "/status"), ("GET", "/logs"), ("POST", "/action"), ("POST", "/projects/demo/run"),
                   ("POST", "/projects/demo/stop"), ("GET", "/projects/demo/files"), ("GET", "/projects/demo/config")]
        denied = [("POST", "/eval"), ("PUT", "/projects/demo/files"), ("GET", "/projects/demo/zip"),
                  ("PUT", "/projects/demo/zip"), ("DELETE", "/projects/demo"), ("DELETE", "/projects/demo/file"),
                  ("POST", "/projects/demo/debug"), ("GET", "/projects/demo/file"), ("POST", "/status"),
                  ("PUT", "/settings"), ("POST", "/debug/request"), ("GET", "/tools/datasets/x/export"),
                  ("GET", "/projectsX/run"), ("POST", "/projects/run"), ("POST", "/projects//run"),
                  ("POST", "/projects/a/b/run"), ("GET", "/projects/a/x/files")]
        for m, path in allowed:
            self.assertTrue(_relay_allowed(op, m, path), (m, path))
        for m, path in denied:
            self.assertFalse(_relay_allowed(op, m, path), (m, path))
            self.assertTrue(_relay_allowed(admin, m, path))


class LoginLimiterTest(unittest.TestCase):
    def test_flood_of_other_keys_keeps_an_active_lockout(self):
        from xscript_server.security import LoginLimiter

        lim = LoginLimiter(limit=3, lock_s=300)
        lim.MAX_KEYS = 50
        for _ in range(3):
            lim.fail("1.2.3.4|admin")
        self.assertGreater(lim.blocked("1.2.3.4|admin"), 0)
        for i in range(500):  # junk usernames used to wipe the whole table
            lim.fail("5.6.7.8|junk%d" % i)
        self.assertGreater(lim.blocked("1.2.3.4|admin"), 0)
        self.assertLessEqual(len(lim._fails), lim.MAX_KEYS + 1)


class LikeEscapeTest(unittest.TestCase):
    def test_wildcards_are_literal(self):
        from xscript_server.deps import like_contains, like_escape

        self.assertEqual(like_escape("a%b_c\\"), "a\\%b\\_c\\\\")
        self.assertEqual(like_contains("  x  "), "%x%")


class LogRedactTest(unittest.TestCase):
    """Device keys in ?token= never reach the server log (uvicorn logs the path with its query string)."""

    def test_filter_masks_message_and_args(self):
        import logging

        from xscript_server.logredact import RedactSecrets, redact, uvicorn_log_config

        self.assertEqual(redact("/ws?token=xsd_secret&x=1"), "/ws?token=***&x=1")
        self.assertEqual(redact("/ws?group=g&Token=abc"), "/ws?group=g&Token=***")
        self.assertEqual(redact("/ws?tokens=keep"), "/ws?tokens=keep")
        # The websocket "accepted" line and the access log both pass the path as a %-arg.
        rec = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, '%s - "WebSocket %s" [accepted]',
                                ("1.2.3.4:5", "/ws?token=xsd_secret"), None)
        self.assertTrue(RedactSecrets().filter(rec))
        self.assertNotIn("xsd_secret", rec.getMessage())
        cfg = uvicorn_log_config()
        self.assertTrue(all("redact_secrets" in h["filters"] for h in cfg["handlers"].values()))


class RateLimiterThreadTest(unittest.TestCase):
    def test_concurrent_allow_never_exceeds_the_limit(self):
        import threading

        from xscript_server.alerts import RateLimiter

        lim = RateLimiter(limit=1000, window_s=60)
        granted = []
        start = threading.Barrier(8)

        def worker():
            start.wait()
            granted.append(sum(lim.allow("1.2.3.4") for _ in range(500)))

        threads = [threading.Thread(target=worker) for _ in range(8)]
        old = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)  # switch threads as often as possible to expose unlocked check-then-append
        try:
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        finally:
            sys.setswitchinterval(old)
        self.assertEqual(sum(granted), 1000)  # 4000 attempts, exactly `limit` allowed
