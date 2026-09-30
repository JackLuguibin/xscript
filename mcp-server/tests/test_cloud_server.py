"""Reference 云控 server + 卡密 tool: a fake device over a real WebSocket, card activation rules."""

import asyncio
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts"))

try:
    import aiohttp  # noqa: F401
    from aiohttp.test_utils import TestClient, TestServer
    import xscript_cloud as cloud
except ImportError:  # pragma: no cover
    cloud = None

try:
    import cryptography  # noqa: F401
    import xscript_license as lic
except ImportError:  # pragma: no cover
    lic = None


@unittest.skipIf(lic is None, "cryptography not installed")
class LicenseToolTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.priv, self.pub = lic.keygen(os.path.join(self.dir, "keys"))
        self.key = lic.load_private(self.priv)

    def test_issue_and_verify(self):
        token, payload = lic.issue(self.key, "dev1", days=2, app="com.a")
        self.assertEqual(lic.verify(self.pub, token), payload)
        self.assertEqual(payload["exp"] - payload["iat"], 2 * 86400)
        body, sig = token.split(".")
        other, _ = lic.issue(self.key, "*")
        self.assertIsNone(lic.verify(self.pub, other.split(".")[0] + "." + sig))

    def test_keygen_refuses_overwrite(self):
        with self.assertRaises(SystemExit):
            lic.keygen(os.path.join(self.dir, "keys"))

    def test_card_binding_and_revoke(self):
        db = lic.CardDB(os.path.join(self.dir, "c.db"))
        card = db.create(1, days=1, app="com.a")[0]
        token, err = db.activate(self.key, card, "dev1", "com.a", now=1000)
        self.assertIsNone(err)
        payload = lic.verify(self.pub, token)
        self.assertEqual((payload["device"], payload["exp"]), ("dev1", 1000 + 86400))
        # Same device again: same expiry. Other device / app: refused.
        again, _ = db.activate(self.key, card, "dev1", "com.a", now=2000)
        self.assertEqual(lic.verify(self.pub, again)["exp"], 1000 + 86400)
        self.assertEqual(db.activate(self.key, card, "dev2", "com.a")[1], "卡密已绑定其他设备")
        self.assertEqual(db.activate(self.key, card, "dev1", "com.b")[1], "卡密不属于此应用")
        self.assertEqual(db.activate(self.key, card, "dev1", "com.a", now=1000 + 86401)[1], "卡密已过期")
        self.assertEqual(db.activate(self.key, "XS-NONE", "dev1", "com.a")[1], "卡密不存在")
        db.revoke(card)
        self.assertEqual(db.check_token(payload), "revoked")
        self.assertEqual(db.activate(self.key, card, "dev1", "com.a")[1], "卡密已停用")
        db.revoke(card, False)
        db.unbind(card)
        self.assertIsNone(db.activate(self.key, card, "dev2", "com.a", now=3000)[1])


class FakeDevice(object):
    """Speaks the device side of the protocol like CloudClient.kt."""

    def __init__(self, ws, device_id="dev1", app="com.xscript.app", group="g1"):
        self.ws, self.id, self.app, self.group = ws, device_id, app, group
        self.messages = []

    async def hello(self):
        await self.ws.send_str(json.dumps({"type": "hello", "device_id": self.id, "group": self.group,
                                           "app": self.app, "device": {"model": "M", "running": False}}))

    async def serve(self):
        async for msg in self.ws:
            data = json.loads(msg.data)
            if data.get("type") == "message":
                self.messages.append(data["data"])
            elif data.get("type") == "request":
                import base64

                body = base64.b64encode(json.dumps({"path": data["path"]}).encode()).decode()
                await self.ws.send_str(json.dumps({"type": "response", "id": data["id"], "status": 200,
                                                   "mime": "application/json", "body": body}))
            elif "path" in data:
                reply = {"path": data["path"], "code": 1, "msg": "success", "device_id": self.id, "seq": data["seq"]}
                if "id" in data:
                    reply["id"] = data["id"]
                if data["path"] == "app_run":
                    reply["echo"] = data.get("param")
                await self.ws.send_str(json.dumps(reply))


@unittest.skipIf(cloud is None, "aiohttp not installed")
class CloudServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir = tempfile.mkdtemp()
        self.hub = cloud.Hub("tok", os.path.join(self.dir, "state.json"))
        self.client = TestClient(TestServer(cloud.make_app(self.hub)))
        await self.client.start_server()
        self.h = {"Authorization": "Bearer tok"}

    async def asyncTearDown(self):
        await self.client.close()

    async def connect(self, **kw):
        ws = await self.client.ws_connect("/ws?token=tok")
        dev = FakeDevice(ws, **kw)
        await dev.hello()
        task = asyncio.create_task(dev.serve())
        for _ in range(50):
            if any(d.device_id == dev.id and d.app == dev.app for d in self.hub.devices.values()):
                break
            await asyncio.sleep(0.02)
        return dev, task

    async def test_auth(self):
        r = await self.client.get("/api/devices")
        self.assertEqual(r.status, 401)
        r = await self.client.get("/ws")
        self.assertEqual(r.status, 401)

    async def test_command_routing(self):
        d1, t1 = await self.connect(device_id="dev1", group="g1")
        d2, t2 = await self.connect(device_id="dev2", group="g2")
        d3, t3 = await self.connect(device_id="dev1", app="com.packed", group="g1")
        r = await self.client.get("/api/devices", headers=self.h)
        ids = sorted(d["id"] for d in (await r.json())["devices"])
        self.assertEqual(ids, ["dev1", "dev1@com.packed", "dev2"])

        r = await self.client.post("/api/command", headers=self.h, json={
            "target": "group:g1", "command": {"path": "app_run", "id": "demo", "param": {"k": 1}}})
        res = (await r.json())["results"]
        self.assertEqual(sorted(res), ["dev1", "dev1@com.packed"])
        self.assertEqual(res["dev1"]["id"], "demo")
        self.assertEqual(res["dev1"]["echo"], {"k": 1})

        r = await self.client.post("/api/command", headers=self.h, json={
            "target": "app:com.packed", "command": {"path": "device_info"}})
        self.assertEqual(list((await r.json())["results"]), ["dev1@com.packed"])

        await self.client.post("/api/command", headers=self.h, json={"target": "all",
                                                                     "command": {"path": "message", "data": "hi"}})
        await asyncio.sleep(0.1)
        self.assertEqual((d1.messages, d2.messages), (["hi"], ["hi"]))

        r = await self.client.post("/api/devices/dev2/http", headers=self.h, json={"method": "GET", "path": "/status"})
        self.assertEqual(await r.json(), {"path": "/status"})
        for t in (t1, t2, t3):
            t.cancel()

    async def test_data_and_group_override(self):
        d, t = await self.connect()
        await d.ws.send_str(json.dumps({"type": "data", "data": {"gold": 5}}))
        await d.ws.send_str(json.dumps({"type": "data", "data": {"water": 7}}))
        await self.client.post("/api/devices/dev1/group", headers=self.h, json={"group": "vip"})
        await asyncio.sleep(0.05)
        r = await self.client.get("/api/devices", headers=self.h)
        dev = (await r.json())["devices"][0]
        self.assertEqual(dev["data"], {"gold": 5, "water": 7})
        self.assertEqual(dev["group"], "vip")
        with open(os.path.join(self.dir, "state.json")) as f:
            self.assertEqual(json.load(f)["groups"], {"dev1": "vip"})
        t.cancel()

    async def test_tasks(self):
        r = await self.client.post("/api/tasks", headers=self.h, json={"target": "all", "daily": "25:00",
                                                                        "command": {"path": "app_stop"}})
        self.assertEqual(r.status, 400)
        r = await self.client.post("/api/tasks", headers=self.h, json={"target": "all", "every": 1,
                                                                        "command": {"path": "app_stop"}})
        task = await r.json()
        self.assertFalse(self.hub.due(task, task["last"] + 30))
        self.assertTrue(self.hub.due(task, task["last"] + 61))
        r = await self.client.delete("/api/tasks/" + task["id"], headers=self.h)
        self.assertTrue((await r.json())["ok"])


if __name__ == "__main__":
    unittest.main()
