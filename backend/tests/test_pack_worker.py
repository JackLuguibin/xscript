"""打包机 (XSCRIPT_PACK_MODE=remote): worker management, the claim / heartbeat / result protocol, leases,
and end to end with real `python -m xscript_server pack-worker` processes building through a fake pack script."""

from __future__ import annotations

import asyncio
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import pgtest  # noqa: E402

pgtest.install()

from test_server import CSRF, SKIP, Server  # noqa: E402

if not SKIP:
    import httpx

    from xscript_server.__main__ import main as cli
    from xscript_server.config import Config
    from xscript_server.models import PackJob

FAKE_PACK = (
    "import sys, os, time\n"
    "a = sys.argv\n"
    "out = a[a.index('--out') + 1]\n"
    "app = a[a.index('--app-id') + 1]\n"
    "print('fake build', app, flush=True)\n"
    "print('icon' if '--icon' in a else 'noicon', flush=True)\n"
    "print('cloudenv', os.environ.get('XSCRIPT_CLOUD_URL', ''), flush=True)\n"
    "print('signed' if '--keystore' in a else 'unsigned', flush=True)\n"
    "print('中文输出', flush=True)\n"
    "if app.endswith('.slow'):\n"
    "    for i in range(600):\n"
    "        print('step', i, flush=True); time.sleep(0.1)\n"
    "if app.endswith('.fail'): sys.exit(3)\n"
    "os.makedirs(out, exist_ok=True)\n"
    "open(os.path.join(out, app + '-1.0.0.apk'), 'wb').write(b'PK remote apk ' + app.encode())\n"
)
ICON = b"\x89PNG\r\n\x1a\nfake"


def project_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(zipfile.ZipInfo("demo/__init__.py", (2026, 1, 1, 0, 0, 0)), "print('hi')\n")  # same bytes each call
    return buf.getvalue()


@unittest.skipIf(SKIP, SKIP)
class RemoteBase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cfg = Config.load(str(self.tmp / "data"), web_dir=str(self.tmp / "noweb"))
        self.cfg.pack_mode = "remote"
        self.cfg.pack_script = None  # the server itself cannot build: only workers do
        self.script = self.tmp / "fake_pack.py"
        self.script.write_text(FAKE_PACK)
        with mock.patch.dict(os.environ, {"XSCRIPT_ADMIN_PASSWORD": "admin-pass-123"}):
            assert cli(["--data", str(self.cfg.data_dir), "init"]) == 0
        self.srv = Server(self.cfg)
        self.packer = self.srv.app.state.ctx.packer
        self.packer.reap_interval = 0.2
        self.srv.__enter__()

    def tearDown(self):
        self.srv.__exit__(None, None, None)

    async def asyncSetUp(self):
        self.admin = httpx.AsyncClient(base_url=self.srv.base, headers=CSRF, timeout=30)
        r = await self.admin.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-123"})
        self.assertEqual(r.status_code, 200, r.text)

    async def asyncTearDown(self):
        await self.admin.aclose()

    async def add_worker(self, name: str) -> tuple[int, str]:
        r = await self.admin.post("/api/pack/workers", json={"name": name})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"], r.json()["token"]

    def as_worker(self, token: str) -> "httpx.AsyncClient":
        return httpx.AsyncClient(base_url=self.srv.base + "/api/pack-worker", timeout=30,
                                 headers={"Authorization": "Bearer " + token} if token else {})

    async def pack(self, app_id: str, icon: bool = False, **opts) -> dict:
        files = {"project": ("demo.zip", project_zip(), "application/zip")}
        if icon:
            files["icon"] = ("icon.png", ICON, "image/png")
        r = await self.admin.post("/api/pack/jobs", data={"options": json.dumps({"app_id": app_id, **opts})},
                                  files=files)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def job(self, job_id: int) -> dict:
        return (await self.admin.get("/api/pack/jobs/%d" % job_id)).json()

    async def wait_job(self, job_id: int, states=("succeeded", "failed", "cancelled"), timeout=30.0) -> dict:
        end = time.monotonic() + timeout
        while True:
            j = await self.job(job_id)
            if j["status"] in states or time.monotonic() > end:
                self.assertIn(j["status"], states, j)
                return j
            await asyncio.sleep(0.1)

    async def log(self, job_id: int) -> str:
        return (await self.admin.get("/api/pack/jobs/%d/log" % job_id)).json()["text"]


class ModeTest(unittest.TestCase):
    def test_local_is_the_default(self):
        with mock.patch.dict(os.environ, {"XSCRIPT_PACK_MODE": ""}):
            self.assertEqual(Config.load(tempfile.mkdtemp()).pack_mode, "local")
        with mock.patch.dict(os.environ, {"XSCRIPT_PACK_MODE": " Remote "}):
            self.assertEqual(Config.load(tempfile.mkdtemp()).pack_mode, "remote")
        with mock.patch.dict(os.environ, {"XSCRIPT_PACK_MODE": "elsewhere"}):
            self.assertEqual(Config.load(tempfile.mkdtemp()).pack_mode, "local")


@unittest.skipIf(SKIP, SKIP)
class MigrationTest(unittest.TestCase):
    def test_v8_adds_worker_columns_to_old_pack_jobs(self):
        import sqlite3

        from sqlalchemy import create_engine, inspect

        from xscript_server import migrate
        from xscript_server.db import Database

        path = os.path.join(tempfile.mkdtemp(), "old.db")
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE pack_jobs (id INTEGER PRIMARY KEY, status VARCHAR(16), app_id VARCHAR(128))")
        con.execute("INSERT INTO pack_jobs (id, status, app_id) VALUES (7, 'succeeded', 'com.example.old')")
        con.execute("PRAGMA user_version = 7")
        con.commit()
        con.close()
        eng = create_engine("sqlite:///" + path)
        self.assertEqual(migrate.migrate(eng), (7, migrate.LATEST))
        cols = {c["name"] for c in inspect(eng).get_columns("pack_jobs")}
        self.assertTrue({"worker_id", "worker_name", "heartbeat_at", "attempts", "cancel_requested"} <= cols)
        with eng.connect() as c:
            row = c.exec_driver_sql("SELECT attempts, cancel_requested, worker_name FROM pack_jobs").one()
        self.assertEqual(tuple(row), (0, 0, ""))
        eng.dispose()
        db = Database(path)
        db.create_all()  # pack_workers comes from create_all
        self.assertTrue(inspect(db.engine).has_table("pack_workers"))
        db.dispose()


class ProtocolTest(RemoteBase):
    async def test_workers_are_admin_only_and_tokens_shown_once(self):
        info = (await self.admin.get("/api/pack/info")).json()
        self.assertEqual((info["available"], info["mode"]), (False, "remote"))
        self.assertIn("打包机", info["reason"])
        wid, token = await self.add_worker("构建机 A")
        self.assertTrue(token.startswith("xsw_"))
        listed = (await self.admin.get("/api/pack/workers")).json()
        self.assertEqual(listed["mode"], "remote")
        self.assertEqual([w["name"] for w in listed["items"]], ["构建机 A"])
        self.assertNotIn(token, json.dumps(listed))
        self.assertFalse(listed["items"][0]["online"])
        self.assertTrue((await self.admin.get("/api/pack/info")).json()["available"])

        r = await self.admin.post("/api/users", json={"username": "op", "password": "password-op1", "role": "operator"})
        self.assertEqual(r.status_code, 200, r.text)
        async with httpx.AsyncClient(base_url=self.srv.base, headers=CSRF) as op:
            await op.post("/api/auth/login", json={"username": "op", "password": "password-op1"})
            self.assertEqual((await op.get("/api/pack/workers")).status_code, 403)
            self.assertEqual((await op.post("/api/pack/workers", json={"name": "x"})).status_code, 403)

        self.assertEqual((await self.admin.delete("/api/pack/workers/%d" % wid)).status_code, 400)  # disable first
        self.assertEqual((await self.admin.post("/api/pack/workers/%d/disable" % wid)).status_code, 200)
        self.assertFalse((await self.admin.get("/api/pack/info")).json()["available"])
        self.assertEqual((await self.admin.delete("/api/pack/workers/%d" % wid)).status_code, 200)
        audit = (await self.admin.get("/api/audit", params={"action": "pack_worker.create"})).json()
        self.assertTrue(any(a["target"] == "构建机 A" for a in audit["items"]))

    async def test_only_worker_tokens_open_the_protocol(self):
        wid, token = await self.add_worker("A")
        key = (await self.admin.post("/api/device-keys", json={"name": "d"})).json()["token"]
        for bad in ("", key, "xsw_" + "x" * 40):
            async with self.as_worker(bad) as w:
                self.assertEqual((await w.post("/claim", json={})).status_code, 401, bad[:4])
        self.assertEqual((await self.admin.post("/api/pack-worker/claim", json={})).status_code, 401)  # a session
        async with httpx.AsyncClient(base_url=self.srv.base, headers={"Authorization": "Bearer " + token}) as w:
            self.assertEqual((await w.get("/api/pack/jobs")).status_code, 401)  # worker token opens nothing else
        await self.admin.post("/api/pack/workers/%d/disable" % wid)
        async with self.as_worker(token) as w:
            self.assertEqual((await w.post("/claim", json={})).status_code, 403)
        await self.admin.post("/api/pack/workers/%d/enable" % wid)
        async with self.as_worker(token) as w:
            r = await w.post("/claim", json={"capabilities": {"release": False, "version": "t", "host": "box"}})
            self.assertEqual(r.json(), {"job": None, "poll_s": 5, "mode": "remote"})
        item = (await self.admin.get("/api/pack/workers")).json()["items"][0]
        self.assertTrue(item["online"])
        self.assertEqual((item["host"], item["version"], item["last_ip"]), ("box", "t", "127.0.0.1"))

    async def test_claim_heartbeat_and_result(self):
        _, ta = await self.add_worker("A")
        _, tb = await self.add_worker("B")
        await self.admin.put("/api/settings", json={"public_url": "https://cloud.example.com"})
        job = await self.pack("com.example.demo", icon=True, cloud=True)
        self.assertEqual(job["queue_position"], 1)
        second = await self.pack("com.example.two")
        self.assertEqual(second["queue_position"], 2)
        async with self.as_worker(ta) as a, self.as_worker(tb) as b:
            got = (await a.post("/claim", json={})).json()["job"]
            self.assertEqual((got["id"], got["has_icon"], got["app_id"]), (job["id"], True, "com.example.demo"))
            self.assertTrue(got["options"]["cloud_url"].startswith("wss://cloud.example.com/ws?token=xsd_"))
            self.assertEqual((await b.post("/claim", json={})).json()["job"]["id"], second["id"])  # never the same job
            self.assertIsNone((await b.post("/claim", json={})).json()["job"])
            j = await self.job(job["id"])
            self.assertEqual((j["status"], j["worker_name"], j["attempts"], j["queue_position"]), ("running", "A", 1, None))

            self.assertEqual((await a.get("/jobs/%d/project" % job["id"])).content, project_zip())
            self.assertEqual((await a.get("/jobs/%d/icon" % job["id"])).content, ICON)
            self.assertEqual((await b.get("/jobs/%d/project" % job["id"])).status_code, 409)
            r = await a.post("/jobs/%d/heartbeat" % job["id"], json={"log": "第一行\n"})
            self.assertEqual(r.json(), {"cancel": False, "lease_s": 90})
            self.assertEqual((await b.post("/jobs/%d/heartbeat" % job["id"], json={"log": "x"})).status_code, 409)
            self.assertIn("第一行", await self.log(job["id"]))
            self.assertIn("打包机「A」开始构建", await self.log(job["id"]))

            bad = await a.post("/jobs/%d/result" % job["id"], data={"status": "succeeded"},
                               files={"apk": ("../evil.apk", b"PK", "application/octet-stream")})
            self.assertEqual(bad.status_code, 400)
            r = await a.post("/jobs/%d/result" % job["id"], data={"status": "succeeded"},
                             files={"apk": ("demo-1.0.apk", b"PK remote", "application/octet-stream")})
            self.assertEqual(r.status_code, 200, r.text)
            done = await self.job(job["id"])
            self.assertEqual((done["status"], done["has_apk"], done["worker_name"]), ("succeeded", True, "A"))
            self.assertEqual((await self.admin.get("/api/pack/jobs/%d/apk" % job["id"])).content, b"PK remote")
            again = await a.post("/jobs/%d/result" % job["id"], data={"status": "failed"})
            self.assertEqual(again.status_code, 409)

            r = await b.post("/jobs/%d/result" % second["id"], data={"status": "failed", "error": "gradle 挂了"})
            self.assertEqual(r.status_code, 200)
            self.assertEqual((await self.job(second["id"]))["error"], "gradle 挂了")
            leftover = list(self.packer.job_dir(job["id"]).glob("upload-*"))
            self.assertEqual(leftover, [])

    async def test_cancel_reaches_the_worker(self):
        _, ta = await self.add_worker("A")
        job = await self.pack("com.example.slow")
        async with self.as_worker(ta) as a:
            self.assertEqual((await a.post("/claim", json={})).json()["job"]["id"], job["id"])
            self.assertEqual((await self.admin.post("/api/pack/jobs/%d/cancel" % job["id"])).status_code, 200)
            self.assertTrue((await self.job(job["id"]))["cancel_requested"])
            self.assertTrue((await a.post("/jobs/%d/heartbeat" % job["id"], json={})).json()["cancel"])
            await a.post("/jobs/%d/result" % job["id"], data={"status": "cancelled"})
        j = await self.job(job["id"])
        self.assertEqual((j["status"], j["error"]), ("cancelled", "已取消"))
        queued = await self.pack("com.example.later")
        self.assertEqual((await self.admin.post("/api/pack/jobs/%d/cancel" % queued["id"])).status_code, 200)
        self.assertEqual((await self.job(queued["id"]))["status"], "cancelled")  # never handed out

    async def test_lost_worker_job_is_queued_again_once_then_failed(self):
        _, ta = await self.add_worker("A")
        _, tb = await self.add_worker("B")
        job = await self.pack("com.example.demo")
        async with self.as_worker(ta) as a, self.as_worker(tb) as b:
            await a.post("/claim", json={})
            self.assertEqual(self.packer.reap(), 0)  # within its lease
            self.assertEqual(self.packer.reap(time.time() + 91), 1)
            j = await self.job(job["id"])
            self.assertEqual((j["status"], j["attempts"], j["queue_position"]), ("queued", 1, 1))
            self.assertIn("失联", await self.log(job["id"]))
            self.assertEqual((await a.post("/jobs/%d/heartbeat" % job["id"], json={})).status_code, 409)
            self.assertEqual((await b.post("/claim", json={})).json()["job"]["id"], job["id"])
            self.packer.reap(time.time() + 91)
            j = await self.job(job["id"])
            self.assertEqual(j["status"], "failed")
            self.assertIn("打包机「B」失联", j["error"])
            self.assertEqual((await b.post("/jobs/%d/result" % job["id"], data={"status": "succeeded"})).status_code, 409)

            lost_cancel = await self.pack("com.example.gone")
            await a.post("/claim", json={})
            await self.admin.post("/api/pack/jobs/%d/cancel" % lost_cancel["id"])
            self.packer.reap(time.time() + 91)
            self.assertEqual((await self.job(lost_cancel["id"]))["status"], "cancelled")

    async def test_release_jobs_only_go_to_workers_with_a_keystore(self):
        _, plain = await self.add_worker("无证书")
        _, signer = await self.add_worker("有证书")
        async with self.as_worker(plain) as p, self.as_worker(signer) as s:
            await p.post("/claim", json={"capabilities": {"release": False}})
            r = await self.admin.post("/api/pack/jobs", data={"options": json.dumps({"app_id": "com.example.rel",
                                                                                     "release": True})},
                                      files={"project": ("demo.zip", project_zip(), "application/zip")})
            self.assertEqual(r.status_code, 400)
            self.assertIn("打包机没有配置签名证书", r.json()["error"])
            await s.post("/claim", json={"capabilities": {"release": True}})
            self.assertTrue((await self.admin.get("/api/pack/info")).json()["release_signing"])
            rel = await self.pack("com.example.rel", release=True)
            self.assertIsNone((await p.post("/claim", json={"capabilities": {"release": False}})).json()["job"])
            got = (await s.post("/claim", json={"capabilities": {"release": True}})).json()["job"]
            self.assertEqual(got["id"], rel["id"])

    async def test_running_jobs_survive_a_server_restart(self):
        _, ta = await self.add_worker("A")
        job = await self.pack("com.example.demo")
        async with self.as_worker(ta) as a:
            await a.post("/claim", json={})
        self.packer.recover()  # what a restart does; local mode would fail the job here
        self.assertEqual((await self.job(job["id"]))["status"], "running")
        with self.srv.app.state.ctx.db.session() as s:
            self.assertEqual(s.get(PackJob, job["id"]).worker_name, "A")


class WorkerProcessE2E(RemoteBase):
    """Real worker processes (`python -m xscript_server pack-worker`) against the running server."""

    def start_worker(self, token: str, *extra: str) -> subprocess.Popen:
        env = {**os.environ, "XSCRIPT_WORKER_TOKEN": token, "XSCRIPT_PACK_SCRIPT": str(self.script),
               "PYTHONPATH": str(HERE.parent), "NO_PROXY": "*"}
        for k in ("XSCRIPT_KEYSTORE", "XSCRIPT_STORE_PASS", "XSCRIPT_DATABASE_URL"):
            env.pop(k, None)
        log = open(self.tmp / ("worker-%d.log" % time.monotonic_ns()), "wb")
        self.addCleanup(log.close)
        work = self.tmp / ("w%d" % time.monotonic_ns())
        # The build runs in its own session: this kills it even when its worker died first.
        self.addCleanup(subprocess.run, ["pkill", "-f", str(work)], check=False)
        p = subprocess.Popen([sys.executable, "-m", "xscript_server", "pack-worker", "--server", self.srv.base,
                              "--work-dir", str(work), "--beat-s", "0.2", *extra],
                             env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.addCleanup(lambda: p.poll() is None and (p.kill(), p.wait()))
        self.worker_log = Path(log.name)
        return p

    async def test_a_worker_process_builds_fails_and_cancels(self):
        await self.admin.put("/api/settings", json={"public_url": "https://cloud.example.com"})
        _, token = await self.add_worker("本地打包机")
        ok = await self.pack("com.example.demo", icon=True, cloud=True)
        fail = await self.pack("com.example.fail")
        worker = self.start_worker(token)

        done = await self.wait_job(ok["id"])
        self.assertEqual((done["status"], done["worker_name"]), ("succeeded", "本地打包机"), await self.log(ok["id"]))
        apk = await self.admin.get("/api/pack/jobs/%d/apk" % ok["id"])
        self.assertEqual(apk.content, b"PK remote apk com.example.demo")
        log = await self.log(ok["id"])
        for want in ("fake build com.example.demo", "\nicon\n", "中文输出", "unsigned",
                     "XSCRIPT_CLOUD_URL=wss://cloud.example.com/ws?token=***", "cloudenv wss://cloud.example.com/ws?token=xsd_"):
            self.assertIn(want, log)
        self.assertNotIn("--cloud-url", log)

        failed = await self.wait_job(fail["id"])
        self.assertEqual(failed["status"], "failed")
        self.assertIn("退出码 3", failed["error"])

        slow = await self.pack("com.example.slow")
        await self.wait_job(slow["id"], ("running",))
        for _ in range(100):  # the build is under way and its output streams in
            if "step 3" in await self.log(slow["id"]):
                break
            await asyncio.sleep(0.1)
        self.assertIn("step 3", await self.log(slow["id"]))
        await self.admin.post("/api/pack/jobs/%d/cancel" % slow["id"])
        self.assertEqual((await self.wait_job(slow["id"]))["status"], "cancelled")
        self.assertNotIn("step 590", await self.log(slow["id"]))

        workers = (await self.admin.get("/api/pack/workers")).json()["items"]
        self.assertTrue(workers[0]["online"])
        self.assertIsNone(workers[0]["job_id"])
        worker.send_signal(signal.SIGTERM)
        self.assertEqual(await asyncio.to_thread(worker.wait, 15), 0, self.worker_log.read_text())

    async def test_a_killed_worker_hands_its_job_to_another(self):
        self.packer.lease_s = 2
        _, ta = await self.add_worker("A")
        _, tb = await self.add_worker("B")
        job = await self.pack("com.example.slow")
        a = self.start_worker(ta)
        await self.wait_job(job["id"], ("running",))
        self.assertEqual((await self.job(job["id"]))["worker_name"], "A")
        os.killpg(a.pid, signal.SIGKILL)  # the worker dies mid-build without a word to the server
        await asyncio.to_thread(a.wait, 10)
        await self.wait_job(job["id"], ("queued",), timeout=15)
        b = self.start_worker(tb)
        await self.wait_job(job["id"], ("running",))
        j = await self.job(job["id"])
        self.assertEqual((j["worker_name"], j["attempts"]), ("B", 2))
        await self.admin.post("/api/pack/jobs/%d/cancel" % job["id"])
        self.assertEqual((await self.wait_job(job["id"]))["status"], "cancelled")
        self.assertIn("失联", await self.log(job["id"]))
        b.send_signal(signal.SIGTERM)
        await asyncio.to_thread(b.wait, 15)

    async def test_once_and_bad_token(self):
        _, token = await self.add_worker("A")
        job = await self.pack("com.example.demo")
        p = self.start_worker(token, "--once")
        self.assertEqual(await asyncio.to_thread(p.wait, 30), 0, self.worker_log.read_text())
        self.assertEqual((await self.job(job["id"]))["status"], "succeeded")
        bad = self.start_worker("xsw_wrong", "--once")
        self.assertEqual(await asyncio.to_thread(bad.wait, 30), 2)
        self.assertIn("令牌被拒绝", self.worker_log.read_text())


if __name__ == "__main__":
    unittest.main()
