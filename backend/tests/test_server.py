"""xscript_server: auth / roles, 云控 over a real WebSocket, 卡密 lifecycle, pack job queue, legacy import.

Runs uvicorn on a free port so the device socket is exercised end to end (websockets client
speaking the same frames as CloudClient.kt).
"""

from __future__ import annotations

import asyncio
import base64
import http.server
import io
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

try:
    import httpx
    import sqlalchemy
    import uvicorn
    import websockets

    from xscript_server import licensing
    from xscript_server.__main__ import main as cli
    from xscript_server.app import create_app
    from xscript_server.config import Config
    from xscript_server.hub import is_due, next_run
except ImportError as e:  # pragma: no cover
    SKIP = "server deps missing: %s" % e
else:
    SKIP = ""

CSRF = {"X-XScript-Csrf": "1"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, cfg):
        self.port = free_port()
        self.app = create_app(cfg)
        self.server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=self.port, log_level="warning",
                                                    ws="websockets-sansio"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        for _ in range(200):
            if self.server.started:
                return self
            time.sleep(0.02)
        raise RuntimeError("server did not start")

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(10)

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.port


class FakeDevice:
    """Device side of the 云控 protocol, like CloudClient.kt."""

    def __init__(self, url, device_id="dev1", app="com.xscript.app", group="g1"):
        self.url, self.id, self.app, self.group = url, device_id, app, group
        self.messages = []
        self.log_cursor = asyncio.Queue()
        self.ws = None
        self.task = None

    async def __aenter__(self):
        self.ws = await websockets.connect(self.url)
        await self.ws.send(json.dumps({"type": "hello", "device_id": self.id, "group": self.group, "app": self.app,
                                       "device": {"model": "M1", "brand": "B", "running": False}}))
        self.task = asyncio.create_task(self.serve())
        return self

    async def __aexit__(self, *exc):
        self.task.cancel()
        await self.ws.close()

    async def serve(self):
        async for raw in self.ws:
            data = json.loads(raw)
            if data.get("type") == "message":
                self.messages.append(data["data"])
            elif data.get("type") == "log_cursor":
                self.log_cursor.put_nowait(data["seq"])
            elif data.get("type") == "request":
                body = base64.b64encode(json.dumps({"path": data["path"], "method": data["method"]}).encode()).decode()
                await self.ws.send(json.dumps({"type": "response", "id": data["id"], "status": 200,
                                               "mime": "application/json", "body": body}))
            elif "path" in data:
                reply = {"path": data["path"], "code": 1, "msg": "success", "device_id": self.id, "seq": data["seq"]}
                if data["path"] == "app_run":
                    reply["echo"] = data.get("param")
                await self.ws.send(json.dumps(reply))


@unittest.skipIf(SKIP, SKIP)
class ServerTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg = Config.load(os.path.join(cls.tmp, "data"), web_dir=os.path.join(cls.tmp, "noweb"))
        cls.cfg.scheduler_interval = 0.2
        # A fake pack script: writes an APK into --out, or fails when the app id says so.
        script = Path(cls.tmp) / "fake_pack.py"
        script.write_text(
            "import sys, os, time\n"
            "a = sys.argv\n"
            "out = a[a.index('--out') + 1]\n"
            "app = a[a.index('--app-id') + 1]\n"
            "print('args', ' '.join(a[1:]))\n"
            "print('pubkey' if '--license-pubkey' in a else 'nolicense')\n"
            "print('cloudenv', os.environ.get('XSCRIPT_CLOUD_URL', ''))\n"
            "if app.endswith('.slow'): time.sleep(30)\n"
            "if app.endswith('.fail'): sys.exit(3)\n"
            "os.makedirs(out, exist_ok=True)\n"
            "open(os.path.join(out, app + '.apk'), 'wb').write(b'PK apk')\n")
        cls.cfg.pack_script = script
        os.environ["XSCRIPT_ADMIN_PASSWORD"] = "admin-pass-123"
        assert cli(["--data", str(cls.cfg.data_dir), "init"]) == 0
        cls.srv = Server(cls.cfg).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.srv.__exit__(None, None, None)

    async def asyncSetUp(self):
        self.admin = await self.login("admin", "admin-pass-123")

    async def asyncTearDown(self):
        await self.admin.aclose()

    async def login(self, user, pw) -> "httpx.AsyncClient":
        c = httpx.AsyncClient(base_url=self.srv.base, headers=CSRF, timeout=30)
        r = await c.post("/api/auth/login", json={"username": user, "password": pw})
        self.assertEqual(r.status_code, 200, r.text)
        return c

    async def make_user(self, name, role):
        r = await self.admin.post("/api/users", json={"username": name, "password": "password-" + name, "role": role})
        if r.status_code == 409:
            return await self.login(name, "password-" + name)
        self.assertEqual(r.status_code, 200, r.text)
        return await self.login(name, "password-" + name)

    async def device_url(self):
        r = await self.admin.post("/api/device-keys", json={"name": "t"})
        return "ws://127.0.0.1:%d/ws?token=%s" % (self.srv.port, r.json()["token"]), r.json()["id"]

    async def wait_online(self, n):
        for _ in range(100):
            if len(self.srv.app.state.ctx.hub.conns) >= n:
                return
            await asyncio.sleep(0.02)
        self.fail("devices did not connect")

    # ------------------------------------------------------------ auth

    async def test_auth_and_csrf(self):
        async with httpx.AsyncClient(base_url=self.srv.base) as anon:
            self.assertEqual((await anon.get("/api/devices")).status_code, 401)
            r = await anon.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
            self.assertEqual(r.status_code, 401)
            self.assertEqual(r.json()["error"], "用户名或密码错误")
        # Cookie session without the CSRF header cannot write.
        async with httpx.AsyncClient(base_url=self.srv.base, cookies=self.admin.cookies) as nocsrf:
            self.assertEqual((await nocsrf.get("/api/auth/me")).status_code, 200)
            self.assertEqual((await nocsrf.post("/api/cards/batches", json={"count": 1})).status_code, 403)
        # API token: Bearer, no CSRF header needed, not accepted as a cookie.
        tok = (await self.admin.post("/api/auth/tokens", json={"name": "ci", "days": 1})).json()["token"]
        async with httpx.AsyncClient(base_url=self.srv.base, headers={"Authorization": "Bearer " + tok}) as api:
            self.assertEqual((await api.get("/api/auth/me")).json()["username"], "admin")
            self.assertEqual((await api.post("/api/cards/batches", json={"count": 1})).status_code, 200)
        async with httpx.AsyncClient(base_url=self.srv.base, cookies={"xs_session": tok}) as wrong:
            self.assertEqual((await wrong.get("/api/auth/me")).status_code, 401)
        # The web console gets security headers.
        r = await self.admin.get("/api/health")
        self.assertIn("frame-ancestors 'none'", r.headers["content-security-policy"])

    async def test_login_throttle(self):
        async with httpx.AsyncClient(base_url=self.srv.base) as c:
            for _ in range(5):
                await c.post("/api/auth/login", json={"username": "nobody", "password": "x"})
            r = await c.post("/api/auth/login", json={"username": "nobody", "password": "x"})
            self.assertEqual(r.status_code, 429)

    async def test_roles(self):
        viewer = await self.make_user("viewer1", "viewer")
        op = await self.make_user("op1", "operator")
        try:
            self.assertEqual((await viewer.get("/api/cards")).status_code, 200)
            self.assertEqual((await viewer.post("/api/cards/batches", json={"count": 1})).status_code, 403)
            self.assertEqual((await op.post("/api/cards/batches", json={"count": 1})).status_code, 200)
            self.assertEqual((await op.get("/api/users")).status_code, 403)
            self.assertEqual((await op.get("/api/audit")).status_code, 403)
            self.assertEqual((await op.post("/api/cards/offline", json={"device": "d"})).status_code, 403)
            # Last admin cannot be demoted.
            me = (await self.admin.get("/api/auth/me")).json()
            r = await self.admin.patch("/api/users/%d" % me["id"], json={"role": "viewer"})
            self.assertEqual(r.status_code, 400)
            # Disabling a user kills their session.
            uid = (await viewer.get("/api/auth/me")).json()["id"]
            await self.admin.patch("/api/users/%d" % uid, json={"disabled": True})
            self.assertEqual((await viewer.get("/api/auth/me")).status_code, 401)
            await self.admin.patch("/api/users/%d" % uid, json={"disabled": False})
        finally:
            await viewer.aclose()
            await op.aclose()

    # ------------------------------------------------------------ 云控

    async def test_device_socket_commands_and_relay(self):
        url, key_id = await self.device_url()
        bad = url.split("?")[0] + "?token=nope"
        with self.assertRaises(Exception):
            async with websockets.connect(bad) as ws:
                await ws.recv()
        async with FakeDevice(url, "dev1", group="g1") as d1, FakeDevice(url, "dev2", group="g2") as d2, \
                FakeDevice(url, "dev1", app="com.packed", group="g1"):
            await self.wait_online(3)
            r = await self.admin.get("/api/devices", params={"online": True})
            ids = sorted(x["id"] for x in r.json()["items"])
            self.assertEqual(ids, ["dev1", "dev1@com.packed", "dev2"])

            r = await self.admin.post("/api/command", json={
                "target": "group:g1", "command": {"path": "app_run", "id": "demo", "param": {"k": 1}}})
            res = r.json()["results"]
            self.assertEqual(sorted(res), ["dev1", "dev1@com.packed"])
            self.assertEqual(res["dev1"]["echo"], {"k": 1})

            r = await self.admin.post("/api/command", json={"target": "app:com.packed",
                                                            "command": {"path": "device_info"}})
            self.assertEqual(list(r.json()["results"]), ["dev1@com.packed"])

            await self.admin.post("/api/command", json={"target": "all", "command": {"path": "message", "data": "hi"}})
            await asyncio.sleep(0.1)
            self.assertEqual((d1.messages, d2.messages), (["hi"], ["hi"]))

            # Script data merges; group override retargets.
            await d1.ws.send(json.dumps({"type": "data", "data": {"gold": 5}}))
            await d1.ws.send(json.dumps({"type": "data", "data": {"water": 7}}))
            await self.admin.patch("/api/devices/dev2", json={"group_override": "g1", "note": "机房 A"})
            await asyncio.sleep(0.1)
            dev = (await self.admin.get("/api/devices/dev1")).json()
            self.assertEqual(dev["data"], {"gold": 5, "water": 7})
            r = await self.admin.post("/api/command", json={"target": "group:g1", "command": {"path": "app_stop"}})
            self.assertIn("dev2", r.json()["results"])
            groups = {g["name"]: g for g in (await self.admin.get("/api/groups")).json()["items"]}
            self.assertEqual(groups["g1"]["online"], 3)

            # HTTP relay; operators only get the safe subset.
            r = await self.admin.post("/api/devices/dev2/http", json={"method": "POST", "path": "/eval",
                                                                       "body": "{}"})
            self.assertEqual(r.json(), {"path": "/eval", "method": "POST"})
            op = await self.make_user("op2", "operator")
            try:
                self.assertEqual((await op.post("/api/devices/dev2/http",
                                                json={"method": "POST", "path": "/eval"})).status_code, 403)
                self.assertEqual((await op.post("/api/devices/dev2/http",
                                                json={"method": "POST", "path": "/projects/a/run"})).status_code, 200)
            finally:
                await op.aclose()
            r = await self.admin.post("/api/devices/dev2/http", json={"method": "POST", "path": "/eval",
                                                                       "body_b64": "not base64!"})
            self.assertEqual(r.status_code, 400)

            # Search input is matched literally: LIKE wildcards and a trailing escape char are not special.
            self.assertGreaterEqual((await self.admin.get("/api/devices", params={"q": "dev"})).json()["total"], 3)
            for q in ("%", "d_v", "dev\\"):
                r = await self.admin.get("/api/devices", params={"q": q})
                self.assertEqual((r.status_code, r.json()["total"]), (200, 0), q)
            r = await self.admin.get("/api/devices/dev1/logs", params={"q": "50%\\"})
            self.assertEqual((r.status_code, r.json()["items"]), (200, []))

            # Revoking the key drops its devices.
            r = await self.admin.post("/api/device-keys/%d/revoke" % key_id)
            self.assertEqual(r.json()["disconnected"], 3)
        for _ in range(100):
            if not self.srv.app.state.ctx.hub.conns:
                break
            await asyncio.sleep(0.02)
        r = await self.admin.get("/api/devices", params={"q": "dev1"})
        self.assertTrue(all(not x["online"] for x in r.json()["items"]))
        audit = (await self.admin.get("/api/audit", params={"action": "device."})).json()["items"]
        self.assertTrue(any(a["action"] == "device.command" for a in audit))

    async def test_tasks(self):
        r = await self.admin.post("/api/tasks", json={"target": "all", "daily": "25:00", "command": {"path": "app_stop"}})
        self.assertEqual(r.status_code, 422)
        r = await self.admin.post("/api/tasks", json={"target": "all", "every": 5,
                                                      "command": {"path": "script_deploy", "script_id": "abc"}})
        self.assertEqual(r.status_code, 400)
        r = await self.admin.post("/api/tasks", json={"target": "all", "every": 0.005, "command": {"path": "app_stop"},
                                                      "name": "fast"})
        task = r.json()
        self.assertEqual(r.status_code, 200, r.text)
        for _ in range(100):
            await asyncio.sleep(0.05)
            t = next(x for x in (await self.admin.get("/api/tasks")).json()["items"] if x["id"] == task["id"])
            if t["last_result"]:
                break
        self.assertEqual(t["last_result"]["devices"], 0)
        self.assertEqual((await self.admin.post("/api/tasks/%d/run" % task["id"])).json()["devices"], 0)
        await self.admin.delete("/api/tasks/%d" % task["id"])
        self.assertFalse(is_due(None, 1, 1000, 1030))
        self.assertTrue(is_due(None, 1, 1000, 1061))
        self.assertEqual(next_run(None, 1, 1000, 1010), 1060)

    # ------------------------------------------------------------ 卡密

    async def test_card_lifecycle_and_license_endpoints(self):
        r = await self.admin.post("/api/cards/batches", json={"count": 3, "days": 1, "app": "com.a", "note": "测试"})
        batch, codes = r.json()["batch"], r.json()["cards"]
        pub = (await self.admin.get("/api/cards/public-key")).json()["public_key"]
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            act = lambda card, dev, a="com.a": app.post("/license/activate",  # noqa: E731
                                                        json={"card": card, "device_id": dev, "app": a, "model": "M"})
            r = await act(codes[0].lower(), "devA")
            self.assertEqual(r.status_code, 200, r.text)
            token = r.json()["token"]
            payload = licensing.verify(pub, token)
            self.assertEqual((payload["device"], payload["app"]), ("devA", "com.a"))
            self.assertAlmostEqual(payload["exp"] - payload["iat"], 86400, delta=2)
            self.assertEqual((await act(codes[0], "devB")).json()["error"], "卡密已绑定其他设备")
            self.assertEqual((await act(codes[1], "devA", "com.b")).json()["error"], "卡密不属于此应用")
            self.assertEqual((await act("XS-NONE", "devA")).status_code, 403)
            self.assertEqual((await app.post("/license/verify", json={"token": token})).json()["status"], "ok")

            await self.admin.post("/api/cards/actions", json={"cards": [codes[0]], "action": "revoke"})
            r = await app.post("/license/verify", json={"token": token})
            self.assertEqual(r.json(), {"status": "revoked", "revoked": True})
            self.assertEqual((await act(codes[0], "devA")).json()["error"], "卡密已停用")

            # 解绑 keeps the expiry and lets another device take the card.
            await self.admin.post("/api/cards/actions", json={"cards": [codes[0]], "action": "restore"})
            await self.admin.post("/api/cards/actions", json={"cards": [codes[0]], "action": "unbind"})
            r = await act(codes[0], "devB")
            self.assertEqual(licensing.verify(pub, r.json()["token"])["exp"], payload["exp"])

        await self.admin.post("/api/cards/extend", json={"cards": [codes[0], codes[2]], "days": 2})
        items = {c["card"]: c for c in (await self.admin.get("/api/cards", params={"batch": batch})).json()["items"]}
        self.assertEqual(items[codes[2]]["days"], 3)
        self.assertEqual(items[codes[0]]["expires_at"], payload["exp"] + 2 * 86400)
        self.assertEqual(items[codes[0]]["status"], "active")
        self.assertEqual(items[codes[1]]["status"], "unused")

        r = await self.admin.get("/api/cards", params={"status": "unused", "batch": batch})
        self.assertEqual(sorted(c["card"] for c in r.json()["items"]), sorted([codes[1], codes[2]]))
        csv_text = (await self.admin.get("/api/cards/export", params={"batch": batch})).text
        self.assertIn(codes[1], csv_text)
        self.assertTrue(csv_text.startswith("\ufeff卡密"))

        r = await self.admin.post("/api/cards/offline", json={"device": "devZ", "days": 7, "app": "com.a"})
        off = licensing.verify(pub, r.json()["token"])
        self.assertEqual(off["device"], "devZ")
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            self.assertEqual((await app.post("/license/verify", json={"token": r.json()["token"]})).json()["status"], "ok")
        stats = (await self.admin.get("/api/cards/stats")).json()
        self.assertGreaterEqual(stats["active"], 2)

    # ------------------------------------------------------------ 打包

    def project_zip(self) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("demo/__init__.py", "print('hi')\n")
        return buf.getvalue()

    async def pack(self, app_id, **opts):
        options = json.dumps({"app_id": app_id, "app_name": "演示", **opts})
        return await self.admin.post("/api/pack/jobs", data={"options": options},
                                     files={"project": ("demo.zip", self.project_zip(), "application/zip")})

    async def wait_job(self, job_id, states=("succeeded", "failed", "cancelled")):
        for _ in range(200):
            j = (await self.admin.get("/api/pack/jobs/%d" % job_id)).json()
            if j["status"] in states:
                return j
            await asyncio.sleep(0.05)
        self.fail("job %d stuck in %s" % (job_id, j["status"]))

    async def test_pack_jobs(self):
        await self.admin.put("/api/settings", json={"public_url": ""})  # other tests may have set it
        r = await self.pack("com.example.demo", license=True)
        self.assertEqual(r.status_code, 400)  # needs public_url
        await self.admin.put("/api/settings", json={"public_url": "https://cloud.example.com/"})
        self.assertEqual((await self.pack("bad id")).status_code, 400)

        r = await self.pack("com.example.demo", license=True, cloud=True, cloud_group="farm")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("cloud_url", r.json()["options"])
        job = await self.wait_job(r.json()["id"])
        self.assertEqual(job["status"], "succeeded", job)
        log = (await self.admin.get("/api/pack/jobs/%d/log" % job["id"])).json()["text"]
        self.assertIn("pubkey", log)
        self.assertIn("--license-server https://cloud.example.com", log)
        self.assertIn("--ops-server https://cloud.example.com", log)  # packed apps read /pub/app-notices from here
        self.assertIn("XSCRIPT_CLOUD_URL=wss://cloud.example.com/ws?token=***", log)
        self.assertIn("cloudenv wss://cloud.example.com/ws?token=xsd_", log)  # reached the script via env
        self.assertNotIn("--cloud-url", log)
        apk = await self.admin.get("/api/pack/jobs/%d/apk" % job["id"])
        self.assertEqual(apk.content, b"PK apk")
        keys = (await self.admin.get("/api/device-keys")).json()["items"]
        self.assertTrue(any(k["name"] == "打包 com.example.demo" for k in keys))

        failed = await self.wait_job((await self.pack("com.example.fail")).json()["id"])
        self.assertEqual(failed["status"], "failed")

        slow = (await self.pack("com.example.slow")).json()
        await self.wait_job(slow["id"], ("running",))
        self.assertEqual((await self.admin.post("/api/pack/jobs/%d/cancel" % slow["id"])).status_code, 200)
        self.assertEqual((await self.wait_job(slow["id"]))["status"], "cancelled")
        self.assertEqual((await self.admin.delete("/api/pack/jobs/%d" % slow["id"])).status_code, 200)

        # Zip slip is rejected before the build runs.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("__init__.py", "")
            zf.writestr("../evil.py", "")
        r = await self.admin.post("/api/pack/jobs", data={"options": json.dumps({"app_id": "com.example.evil"})},
                                  files={"project": ("e.zip", buf.getvalue(), "application/zip")})
        j = await self.wait_job(r.json()["id"])
        self.assertEqual(j["status"], "failed")
        self.assertIn("不安全的路径", j["error"])
        self.assertFalse((self.cfg.pack_dir / "evil.py").exists())

    # ------------------------------------------------------------ 小程序 / 热更新 / 分发

    def script_zip(self, text="print('v1')\n", top="whatever") -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(top + "/__init__.py", text)
            zf.writestr(top + "/res/a.txt", "x")
        return buf.getvalue()

    async def upload_version(self, client, sid, text, **form):
        return await client.post("/api/scripts/%d/versions" % sid, data={k: str(v) for k, v in form.items()},
                                 files={"file": ("p.zip", self.script_zip(text), "application/zip")})

    async def test_scripts_versions_update_and_deploy(self):
        op = await self.make_user("op3", "operator")
        try:
            r = await op.post("/api/scripts", json={"name": "刷金币", "project_name": "bad name"})
            self.assertEqual(r.status_code, 422)
            sc = (await op.post("/api/scripts", json={"name": "刷金币", "project_name": "gold"})).json()
            sid, channel = sc["id"], sc["channel"]
            v1 = (await self.upload_version(op, sid, "print('v1')\n")).json()
            self.assertEqual((v1["version"], v1["version_code"], v1["files"]), ("1.0.0", 1, 2))
            # Operators upload; publishing ships code to apps, so it needs admin.
            self.assertEqual((await self.upload_version(op, sid, "x", publish="true")).status_code, 403)
            self.assertEqual((await op.post("/api/scripts/%d/publish" % sid, json={"version_id": v1["id"]})).status_code,
                             403)
            bad = await op.post("/api/scripts/%d/versions" % sid,
                                files={"file": ("p.zip", b"not a zip", "application/zip")})
            self.assertEqual(bad.status_code, 400)
        finally:
            await op.aclose()

        v2 = (await self.upload_version(self.admin, sid, "print('v2')\n", notes="修复", publish="true")).json()
        self.assertEqual((v2["version"], v2["version_code"], v2["current"]), ("1.0.1", 2, True))
        self.assertEqual((await self.upload_version(self.admin, sid, "x", version="1.0.1")).status_code, 409)

        pub = (await self.admin.get("/api/cards/public-key")).json()["public_key"]
        async with httpx.AsyncClient(base_url=self.srv.base) as app:
            self.assertEqual((await app.get("/pub/update", params={"channel": "nope"})).status_code, 404)
            r = (await app.get("/pub/update", params={"channel": channel, "code": 1})).json()
            self.assertTrue(r["update"])
            m = licensing.verify(pub, r["manifest"])
            self.assertEqual((m["project"], m["version_code"], m["channel"]), ("gold", 2, channel))
            z = await app.get(r["url"])
            import hashlib

            self.assertEqual(hashlib.sha256(z.content).hexdigest(), m["sha256"])
            names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
            self.assertEqual(sorted(names), ["__init__.py", "res/a.txt"])  # top folder stripped
            self.assertEqual((await app.get("/pub/update", params={"channel": channel, "code": 2})).json(),
                             {"update": False})
            # Unpublished versions are never served.
            self.assertEqual((await app.get("/pub/bundle/%s/1.zip" % channel)).status_code, 404)
            # Rollback: publishing v1 makes devices on v2 go back.
            await self.admin.post("/api/scripts/%d/publish" % sid, json={"version_id": v1["id"]})
            r = (await app.get("/pub/update", params={"channel": channel, "code": 2})).json()
            self.assertEqual(licensing.verify(pub, r["manifest"])["version_code"], 1)
        self.assertEqual((await self.admin.delete("/api/scripts/%d/versions/%d" % (sid, v1["id"]))).status_code, 400)

        # Deploy over 云控: the device receives PUT /projects/gold/zip, then app_run.
        url, _ = await self.device_url()

        class Recorder(FakeDevice):
            requests: list = []

            async def serve(self):
                async for raw in self.ws:
                    data = json.loads(raw)
                    if data.get("type") == "request":
                        Recorder.requests.append((data["method"], data["path"], data["query"],
                                                  base64.b64decode(data["body"])))
                        await self.ws.send(json.dumps({"type": "response", "id": data["id"], "status": 200,
                                                       "mime": "application/json",
                                                       "body": base64.b64encode(b'{"ok":true}').decode()}))
                    elif "path" in data:
                        await self.ws.send(json.dumps({"path": data["path"], "code": 1, "msg": "success",
                                                       "seq": data["seq"], "id": data.get("id")}))

        async with Recorder(url, "depl1", group="deploy"):
            await self.wait_online(1)
            r = await self.admin.post("/api/scripts/%d/deploy" % sid,
                                      json={"target": "group:deploy", "version_id": v2["id"], "params": {"a": 1}})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["results"]["depl1"]["code"], 1)
            method, path, query, body = Recorder.requests[-1]
            self.assertEqual((method, path, query), ("PUT", "/projects/gold/zip", {"replace": "true"}))
            self.assertIn(b"print('v2')", zipfile.ZipFile(io.BytesIO(body)).read("__init__.py"))
        audit = (await self.admin.get("/api/audit", params={"action": "script."})).json()["items"]
        self.assertTrue(any(a["action"] == "script.deploy" for a in audit))

    async def test_share_links(self):
        await self.admin.put("/api/settings", json={"public_url": "https://cloud.example.com"})
        job = await self.wait_job((await self.pack("com.example.share")).json()["id"])
        self.assertEqual(job["status"], "succeeded")
        link = (await self.admin.post("/api/pack/jobs/%d/shares" % job["id"], json={"days": 1})).json()
        async with httpx.AsyncClient(base_url=self.srv.base) as anon:
            info = (await anon.get("/pub/d/" + link["token"])).json()
            self.assertEqual((info["app_id"], info["app_name"]), ("com.example.share", "演示"))
            self.assertEqual((await anon.get(info["apk"])).content, b"PK apk")
            self.assertEqual((await anon.get("/pub/d/nope")).status_code, 404)
            await self.admin.delete("/api/pack/shares/%d" % link["id"])
            self.assertEqual((await anon.get("/pub/d/" + link["token"])).status_code, 404)

    async def test_pack_from_script_with_hot_update(self):
        await self.admin.put("/api/settings", json={"public_url": "https://cloud.example.com"})
        sc = (await self.admin.post("/api/scripts", json={"name": "热更", "project_name": "hot"})).json()
        v = (await self.upload_version(self.admin, sc["id"], "print(1)\n", publish="true")).json()
        r = await self.admin.post("/api/pack/jobs", data={"options": json.dumps(
            {"app_id": "com.example.hot", "script_id": sc["id"], "hot_update": True})})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("update_pubkey", r.json()["options"])
        job = await self.wait_job(r.json()["id"])
        self.assertEqual(job["status"], "succeeded", job)
        log = (await self.admin.get("/api/pack/jobs/%d/log" % job["id"])).json()["text"]
        self.assertIn("--project-name hot", log)
        self.assertIn("--update-channel %s" % sc["channel"], log)
        self.assertIn("--script-code %d" % v["version_code"], log)
        r = await self.admin.post("/api/pack/jobs", data={"options": json.dumps(
            {"app_id": "com.example.hot2", "hot_update": True})},
            files={"project": ("demo.zip", self.project_zip(), "application/zip")})
        self.assertEqual(r.status_code, 400)

    # ------------------------------------------------------------ 运维: 崩溃上报 / 告警 / 备份 / 限流

    async def test_device_log_history(self):
        dev_url, _ = await self.device_url()
        now_ms = int(time.time() * 1000)

        async def wait_lines(n, **q):
            for _ in range(100):
                items = (await self.admin.get("/api/devices/logdev/logs", params=q)).json()["items"]
                if len(items) >= n:
                    return items
                await asyncio.sleep(0.05)
            self.fail("logs not stored: %r" % items)

        async with FakeDevice(dev_url, "logdev") as d:
            # Nothing stored yet: upload from the start.
            self.assertEqual(await asyncio.wait_for(d.log_cursor.get(), 5), 0)
            await d.ws.send(json.dumps({"type": "logs", "entries": [
                {"seq": i, "ts": now_ms + i, "stream": "stderr" if i == 3 else "stdout", "line": "line %d\n" % i}
                for i in range(1, 6)] + ["junk", {"seq": "x"}]}))
            items = await wait_lines(5)
        self.assertEqual([x["seq"] for x in items], [1, 2, 3, 4, 5])

        # Reconnect: the server asks only for lines after the last one it has.
        async with FakeDevice(dev_url, "logdev") as d:
            self.assertEqual(await asyncio.wait_for(d.log_cursor.get(), 5), 5)
            await d.ws.send(json.dumps({"type": "logs", "entries": [
                {"seq": 6, "ts": now_ms + 6, "stream": "weird", "line": "Traceback boom"}]}))
            await wait_lines(6)

        # Offline device: history, filters, paging, polling and export still work.
        r = (await self.admin.get("/api/devices/logdev/logs", params={"stream": "stderr"})).json()
        self.assertEqual([x["line"] for x in r["items"]], ["line 3\n"])
        r = (await self.admin.get("/api/devices/logdev/logs", params={"q": "boom"})).json()
        self.assertEqual(r["items"][0]["stream"], "stdout")  # unknown stream normalised
        page = (await self.admin.get("/api/devices/logdev/logs", params={"limit": 4})).json()
        self.assertTrue(page["more"])
        self.assertEqual([x["seq"] for x in page["items"]], [3, 4, 5, 6])
        older = (await self.admin.get("/api/devices/logdev/logs",
                                      params={"limit": 4, "before": page["items"][0]["id"]})).json()
        self.assertEqual([x["seq"] for x in older["items"]], [1, 2])
        self.assertFalse(older["more"])
        newer = (await self.admin.get("/api/devices/logdev/logs", params={"after": page["items"][-1]["id"]})).json()
        self.assertEqual(newer["items"], [])
        exp = await self.admin.get("/api/devices/logdev/logs/export", params={"stream": "stderr"})
        self.assertEqual(exp.status_code, 200)
        self.assertIn("[stderr] line 3", exp.text)

        # device_log_days = 0: no cursor, so devices keep their lines to themselves.
        self.assertEqual((await self.admin.put("/api/settings", json={"device_log_days": 0})).status_code, 200)
        try:
            async with FakeDevice(dev_url, "logdev") as d:
                await self.wait_online(1)
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(d.log_cursor.get(), 0.5)
                # Turning it back on starts the upload on connected devices.
                self.assertEqual((await self.admin.put("/api/settings", json={"device_log_days": 7})).status_code, 200)
                self.assertEqual(await asyncio.wait_for(d.log_cursor.get(), 5), 6)
        finally:
            await self.admin.put("/api/settings", json={"device_log_days": 7})

    async def test_run_end_crash_alert_and_webhook_secret(self):
        hits = []

        class Hook(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                hits.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"errcode":0}')

            def log_message(self, *a):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hook)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/robot?access_token=abc" % srv.server_port
        try:
            r = await self.admin.put("/api/settings", json={"alert_webhooks": [
                {"name": "群", "kind": "dingtalk", "url": url, "secret": "SEC",
                 "events": ["script_crash", "device_offline"]}]})
            self.assertEqual(r.status_code, 200, r.text)
            hook = r.json()["alert_webhooks"][0]
            self.assertNotIn("secret", hook)
            self.assertTrue(hook["has_secret"])
            # Saving the form again without the secret keeps it.
            await self.admin.put("/api/settings", json={"alert_webhooks": [
                {"name": "群", "kind": "dingtalk", "url": url, "events": ["script_crash", "device_offline"]}]})
            self.assertEqual((await self.admin.post("/api/alerts/test", json={"kind": "dingtalk", "url": url})).status_code,
                             200)
            self.assertIn("sign=", hits[-1][0])

            dev_url, _ = await self.device_url()
            async with FakeDevice(dev_url, "crash1") as d:
                await self.wait_online(1)
                await d.ws.send(json.dumps({"type": "run_end", "project": "farm", "exit": "1", "crashed": True,
                                            "tail": [{"stream": "stderr", "line": "ZeroDivisionError: division by zero"}]}))
                for _ in range(100):
                    if len(hits) >= 2:
                        break
                    await asyncio.sleep(0.05)
                dev = (await self.admin.get("/api/devices/crash1")).json()
            self.assertEqual(dev["last_run"]["exit"], "1")
            self.assertTrue(dev["last_run"]["crashed"])
            text = hits[-1][1]["text"]["content"]
            self.assertIn("ZeroDivisionError", text)
            self.assertIn("farm", text)
            recent = (await self.admin.get("/api/alerts/recent")).json()["items"]
            self.assertEqual(recent[0]["event"], "script_crash")

            # Offline after the configured minutes (driven directly, not by waiting).
            hub = self.srv.app.state.ctx.hub
            hub.gone["crash1"] = time.time() - 3600
            await asyncio.get_running_loop().run_in_executor(None, lambda: None)
            hub.check_offline()
            for _ in range(100):
                if any("离线" in h[1]["text"]["content"] for h in hits):
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(any("离线" in h[1]["text"]["content"] for h in hits))
            # Non-admins never see webhook URLs (they carry access tokens).
            viewer = await self.make_user("viewer2", "viewer")
            try:
                self.assertEqual((await viewer.get("/api/settings")).json()["alert_webhooks"][0]["url"], "")
            finally:
                await viewer.aclose()
        finally:
            await self.admin.put("/api/settings", json={"alert_webhooks": []})
            srv.shutdown()

    async def test_maintenance_backup_and_cleanup(self):
        info = (await self.admin.get("/api/maintenance")).json()
        self.assertIn("database", info["usage"])
        r = await self.admin.post("/api/maintenance/backup")
        self.assertEqual(r.status_code, 200, r.text)
        name = r.json()["name"]
        tar = await self.admin.get("/api/maintenance/backups/" + name)
        self.assertEqual(tar.status_code, 200)
        import tarfile

        names = tarfile.open(fileobj=io.BytesIO(tar.content), mode="r:gz").getnames()
        self.assertIn("xscript.db", names)
        self.assertIn("keys/private.pem", names)
        self.assertEqual((await self.admin.get("/api/maintenance/backups/..%2Fxscript.db")).status_code, 404)
        self.assertEqual((await self.admin.post("/api/maintenance/cleanup")).status_code, 200)

    async def test_public_rate_limit(self):
        ctx = self.srv.app.state.ctx
        old = ctx.pub_limiter
        from xscript_server.alerts import RateLimiter

        ctx.pub_limiter = RateLimiter(3, 60)
        try:
            async with httpx.AsyncClient(base_url=self.srv.base) as anon:
                codes = [(await anon.get("/pub/d/nope")).status_code for _ in range(5)]
            self.assertEqual(codes, [404, 404, 404, 429, 429])
        finally:
            ctx.pub_limiter = old

    async def test_sessions_and_overview(self):
        second = httpx.AsyncClient(base_url=self.srv.base, headers={**CSRF, "User-Agent": "Mozilla/5.0 (iPhone) Safari/1"})
        r = await second.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-123"})
        self.assertEqual(r.status_code, 200)
        items = (await self.admin.get("/api/auth/sessions")).json()["items"]
        self.assertEqual(sum(1 for i in items if i["current"]), 1)
        self.assertTrue(any(i["agent"] == "Safari · iOS" for i in items))
        r = await self.admin.post("/api/auth/sessions/logout-others")
        self.assertGreaterEqual(r.json()["ended"], 1)
        self.assertEqual((await second.get("/api/auth/me")).status_code, 401)
        self.assertEqual((await self.admin.get("/api/auth/me")).status_code, 200)
        await second.aclose()
        ov = (await self.admin.get("/api/overview")).json()
        for k in ("crashes", "scripts", "alerts_24h", "last_backup"):
            self.assertIn(k, ov)

    async def test_overview_and_groups_queries_stay_narrow(self):
        """Overview crashes come from a filtered SQL query; neither endpoint loads the device JSON blobs."""
        from sqlalchemy import event

        from xscript_server.models import Device

        ctx = self.srv.app.state.ctx
        now = int(time.time())
        blob = {"x": "y" * 1000}
        tail = [{"stream": "stdout", "line": "ok"}, {"stream": "stderr", "line": "Boom"}]
        rows = {"ov-new": {"crashed": True, "time": now - 60, "tail": tail},
                "ov-old": {"crashed": True, "time": now - 2 * 86400, "tail": tail},
                "ov-clean": {"crashed": False, "time": now - 30, "tail": []}}
        with ctx.db.session() as s:
            for i in range(9):  # more recent crashes than the overview shows
                rows["ov-%d" % i] = {"crashed": True, "time": now - 3600 - i, "tail": []}
            s.add_all(Device(id=k, device_id=k, reported_group="ov-grp", status=blob, data=blob, last_run=v)
                      for k, v in rows.items())
            s.add(Device(id="ov-moved", device_id="ov-moved", reported_group="ov-grp", group_override="ov-grp2"))
            s.commit()
        seen: list[str] = []

        def capture(conn, cursor, statement, *a):
            seen.append(statement)

        event.listen(ctx.db.engine, "before_cursor_execute", capture)
        try:
            ov = (await self.admin.get("/api/overview")).json()
            groups = {g["name"]: g for g in (await self.admin.get("/api/groups")).json()["items"]}
        finally:
            event.remove(ctx.db.engine, "before_cursor_execute", capture)
        mine = [c for c in ov["crashes"] if c["device"].startswith("ov-")]
        self.assertEqual(mine[0], {"device": "ov-new", "model": "", "project": None, "exit": None,
                                   "time": now - 60, "error": "Boom"})
        self.assertNotIn("ov-old", [c["device"] for c in ov["crashes"]])
        self.assertNotIn("ov-clean", [c["device"] for c in ov["crashes"]])
        self.assertEqual(len(ov["crashes"]), 8)
        self.assertEqual([c["time"] for c in ov["crashes"]], sorted((c["time"] for c in ov["crashes"]), reverse=True))
        self.assertEqual(groups["ov-grp"], {"name": "ov-grp", "total": 12, "online": 0})
        self.assertEqual(groups["ov-grp2"], {"name": "ov-grp2", "total": 1, "online": 0})
        device_selects = [q for q in seen if "FROM devices" in q]
        self.assertTrue(device_selects)
        for q in device_selects:
            self.assertNotIn("devices.status", q)
            self.assertNotIn("devices.data", q)
        self.assertEqual(sum(1 for q in seen if "FROM cards" in q), 1)

    async def test_scheduled_script_deploy(self):
        sc = (await self.admin.post("/api/scripts", json={"name": "定时", "project_name": "timed"})).json()
        await self.upload_version(self.admin, sc["id"], "print('t')\n", publish="true")
        op = await self.make_user("op4", "operator")
        try:
            body = {"target": "all", "every": 60, "command": {"path": "script_deploy", "script_id": sc["id"]}}
            self.assertEqual((await op.post("/api/tasks", json=body)).status_code, 403)
        finally:
            await op.aclose()
        bad = {"target": "all", "every": 60, "command": {"path": "script_deploy", "script_id": 99999}}
        self.assertEqual((await self.admin.post("/api/tasks", json=bad)).status_code, 400)
        t = (await self.admin.post("/api/tasks", json=body)).json()
        url, _ = await self.device_url()
        got = []

        class Dev(FakeDevice):
            async def serve(self):
                async for raw in self.ws:
                    data = json.loads(raw)
                    if data.get("type") == "request":
                        got.append(data["path"])
                        await self.ws.send(json.dumps({"type": "response", "id": data["id"], "status": 200,
                                                       "mime": "application/json", "body": base64.b64encode(b"{}").decode()}))
                    elif "path" in data:
                        got.append(data["path"])
                        await self.ws.send(json.dumps({"path": data["path"], "code": 1, "msg": "success",
                                                       "seq": data["seq"]}))

        async with Dev(url, "timed1"):
            await self.wait_online(1)
            res = (await self.admin.post("/api/tasks/%d/run" % t["id"])).json()
        self.assertEqual(res["ok"], 1, res)
        self.assertEqual(got, ["/projects/timed/zip", "app_run"])
        await self.admin.delete("/api/tasks/%d" % t["id"])

    async def test_two_factor_login(self):
        from xscript_server import totp

        r = await self.admin.post("/api/users", json={"username": "tfa", "password": "password-tfa", "role": "admin"})
        self.assertEqual(r.status_code, 200, r.text)
        tfa_id = r.json()["id"]
        c = await self.login("tfa", "password-tfa")
        try:
            # Requiring 2FA for admins is refused until the caller has it on.
            self.assertEqual((await c.put("/api/settings", json={"require_totp_admin": True})).status_code, 400)
            setup = (await c.post("/api/auth/totp/setup")).json()
            self.assertIn("otpauth://totp/", setup["uri"])
            self.assertEqual((await c.post("/api/auth/totp/enable", json={"code": "000000"})).status_code, 400)
            now_step = int(time.time() // 30)
            r = await c.post("/api/auth/totp/enable", json={"code": totp.code_at(setup["secret"], now_step)})
            self.assertTrue(r.json()["totp_enabled"])
        finally:
            await c.aclose()

        async with httpx.AsyncClient(base_url=self.srv.base, headers=CSRF) as anon:
            r = await anon.post("/api/auth/login", json={"username": "tfa", "password": "password-tfa"})
            self.assertEqual(r.json(), {"totp_required": True})
            self.assertNotIn("xs_session", r.cookies)
            # The code used for enabling cannot be replayed.
            code = totp.code_at(setup["secret"], now_step)
            r = await anon.post("/api/auth/login", json={"username": "tfa", "password": "password-tfa", "code": code})
            self.assertEqual(r.status_code, 401)
            nxt = totp.code_at(setup["secret"], now_step + 1)
            r = await anon.post("/api/auth/login", json={"username": "tfa", "password": "password-tfa", "code": nxt})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["totp_enabled"])
            # Now the requirement can be turned on; an admin without 2FA (the main test admin) is fenced.
            self.assertEqual((await anon.put("/api/settings", json={"require_totp_admin": True})).status_code, 200)
            me = (await self.admin.get("/api/auth/me")).json()
            self.assertTrue(me["needs_totp_setup"])
            self.assertEqual((await self.admin.get("/api/devices")).status_code, 403)
            await anon.put("/api/settings", json={"require_totp_admin": False})
            self.assertEqual((await self.admin.get("/api/devices")).status_code, 200)
        # Another admin can reset it (lost phone).
        r = await self.admin.patch("/api/users/%d" % tfa_id, json={"reset_totp": True})
        self.assertFalse(r.json()["totp_enabled"])
        await self.admin.delete("/api/users/%d" % tfa_id)

    async def test_spa_fallback_without_build(self):
        r = await self.admin.get("/devices")
        self.assertEqual(r.status_code, 503)
        self.assertEqual((await self.admin.get("/api/nope")).status_code, 404)


@unittest.skipIf(SKIP, SKIP)
@unittest.skipIf(SKIP, SKIP)
class SchedulerTest(unittest.IsolatedAsyncioTestCase):
    """Due tasks run side by side with a cap; a slow or failing task does not hold up the rest."""

    async def asyncSetUp(self):
        from xscript_server.db import Database
        from xscript_server.hub import Scheduler
        from xscript_server.models import Task

        cfg = Config.load(tempfile.mkdtemp())
        cfg.ensure_dirs()
        self.db = Database(cfg.db_path)
        self.db.create_all()
        self.release = asyncio.Event()
        self.calls: list[str] = []
        self.active = self.peak = 0
        test = self

        class Hub:
            def _alert(self, *a):
                pass

            async def command(self, target, command):
                test.calls.append(target)
                test.active += 1
                test.peak = max(test.peak, test.active)
                try:
                    if target.startswith("slow"):
                        await test.release.wait()
                    if target == "boom":
                        raise RuntimeError("device gone")
                    return {"d": {"code": 1, "msg": "ok"}}
                finally:
                    test.active -= 1

        with self.db.session() as s:
            # every = 0.001 min: due again on every tick unless the scheduler skips running tasks.
            s.add_all(Task(name=n, target=n, every=0.001, command={"path": "x"})
                      for n in ("slow1", "slow2", "slow3", "fast", "boom"))
            s.commit()
        self.Task = Task
        self.sched = Scheduler(Hub(), self.db, interval=0.05, parallel=3)
        self.loop_task = asyncio.create_task(self.sched.loop())

    async def asyncTearDown(self):
        self.loop_task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await self.loop_task
        await asyncio.sleep(0)
        self.assertTrue(all(t.done() for t in self.sched._running.values()))
        self.db.engine.dispose()

    def results(self):
        with self.db.session() as s:
            return {t.target: t.last_result for t in s.scalars(sqlalchemy.select(self.Task))}

    async def wait_for(self, cond, timeout=5.0):
        end = time.monotonic() + timeout
        while not cond():
            if time.monotonic() > end:
                self.fail("timed out")
            await asyncio.sleep(0.02)

    async def test_slow_tasks_do_not_block_and_are_not_claimed_twice(self):
        # Three slow tasks fill the three slots; the other two wait, they are not dropped.
        await self.wait_for(lambda: self.peak == 3)
        await asyncio.sleep(0.3)  # several ticks while all three are stuck
        self.assertEqual(sorted(self.calls), ["slow1", "slow2", "slow3"])
        self.release.set()
        await self.wait_for(lambda: {"fast", "boom"} <= set(self.calls))
        await self.wait_for(lambda: all(self.results().values()))
        res = self.results()
        self.assertEqual(res["fast"]["ok"], 1)
        self.assertEqual(res["boom"]["error"], "device gone")
        self.assertLessEqual(self.peak, 3)
        self.assertFalse(self.loop_task.done())  # a failing task did not kill the loop

    async def test_fast_task_is_not_delayed_by_a_slow_one(self):
        self.sched._slots = asyncio.Semaphore(4)  # before the first tick: room for one slow task + the rest
        await self.wait_for(lambda: (self.results()["fast"] or {}).get("ok") == 1)
        self.assertFalse(self.release.is_set())
        self.assertEqual(self.calls.count("slow1"), 1)  # still running: never re-claimed

    async def test_unexpected_error_is_logged_and_the_slot_freed(self):
        self.release.set()
        real = self.sched._finish
        with self.db.session() as s:
            fast = s.scalar(sqlalchemy.select(self.Task.id).where(self.Task.target == "fast"))

        def finish(task_id, *a):
            if task_id == fast:
                raise RuntimeError("db down")
            return real(task_id, *a)

        self.sched._finish = finish
        with self.assertLogs("xscript.hub", "ERROR") as logs:
            await self.wait_for(lambda: self.calls.count("fast") >= 2)  # claimed again after the failure
        self.assertIn("scheduled task %d failed" % fast, logs.output[0])
        self.assertFalse(self.loop_task.done())


class LegacyImportTest(unittest.TestCase):
    def test_import(self):
        tmp = Path(tempfile.mkdtemp())
        key = licensing.generate_private()
        licensing.write_private(key, tmp / "old.pem")
        (tmp / "state.json").write_text(json.dumps({
            "groups": {"dev1": "vip"},
            "tasks": [{"id": "t1", "target": "all", "command": {"path": "app_stop"}, "daily": "8:30", "last": 1}]}))
        con = sqlite3.connect(tmp / "licenses.db")
        con.executescript("CREATE TABLE cards (card TEXT PRIMARY KEY, days REAL, app TEXT, note TEXT, created INTEGER,"
                          " device TEXT, model TEXT, activated INTEGER, expires INTEGER, revoked INTEGER);"
                          "INSERT INTO cards VALUES ('XS-AAAA-BBBB-CCCC-DDDD', 30, 'com.a', '', 1, 'd1', 'M', 2, 99, 0);")
        con.commit()
        con.close()
        data = tmp / "data"
        rc = cli(["--data", str(data), "import-legacy", "--token", "old-shared-token-123", "--state",
                  str(tmp / "state.json"), "--licenses", str(tmp / "licenses.db"), "--key", str(tmp / "old.pem")])
        self.assertEqual(rc, 0)
        cfg = Config.load(data)
        self.assertEqual(licensing.public_b64(licensing.load_private(cfg.key_path)), licensing.public_b64(key))
        from xscript_server.db import Database
        from xscript_server.models import Card, Device, DeviceKey, Task
        from xscript_server.security import token_hash

        with Database(cfg.db_path).session() as s:
            self.assertEqual(s.get(Device, "dev1").group_override, "vip")
            self.assertEqual(s.query(Task).one().daily, "08:30")
            self.assertEqual(s.get(Card, "XS-AAAA-BBBB-CCCC-DDDD").expires_at, 99)
            self.assertIsNotNone(s.query(DeviceKey).filter_by(token_hash=token_hash("old-shared-token-123")).first())
        # A different key already in place is refused (packed apps embed the old public key).
        other = tmp / "other.pem"
        licensing.write_private(licensing.generate_private(), other)
        self.assertEqual(cli(["--data", str(data), "import-legacy", "--key", str(other)]), 1)


if __name__ == "__main__":
    unittest.main()
