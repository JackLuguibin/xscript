#!/usr/bin/env python3
"""Desktop cloud control (P4) against a real local backend and a real device on an emulator.

usage:
  .venv/bin/python scripts/desktop_cloud_e2e.py serve SECRETS.json [PORT]        # backend venv (fastapi, uvicorn)
  desktop/app/.venv/bin/python scripts/desktop_cloud_e2e.py check SECRETS.json SERIAL DEVICE_PORT [PACKAGE]
                                                       e.g. ... check /tmp/p4.json emulator-5554 9860 com.xscript.app.perf

`serve` starts xscript_server on 127.0.0.1:PORT (default 8791) with a throwaway data directory, an admin and a viewer
account, an API token for each, a device key and three simulated phones (demo.py). The tokens and the device key go
only into SECRETS.json (mode 0600); nothing secret is printed. Stop it with Ctrl+C; the data directory is removed.

`check` drives the desktop's own cloud.* RPCs (AppContext, in-memory credential store, never the OS keyring):
  1. links the device app to the backend (`cloud.connect` over the device API, group "p4-e2e"; pairing code via
     scripts/devauth.py, kept in memory),
  2. admin: connect → device table (filters) → bulk run → deploy a project to the group as a new version → logs →
     rollback to the first version → task create / toggle / delete → pack jobs → console links,
  3. viewer: read-only role, bulk command and deploy refused by the backend,
  4. cleanup: deletes the deployed project from the device and forgets the 云控 URL there (`cloud.close`).
Only PACKAGE is touched on the device; nothing is installed or uninstalled. The emulator reaches this Mac as 10.0.2.2.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GROUP = "p4-e2e"
PROJECT = "p4_e2e"


# ---------------------------------------------------------------- serve (backend venv)

def serve(secrets_path: str, port: int) -> None:
    sys.path.insert(0, str(ROOT / "backend"))
    sys.path.insert(0, str(ROOT / "backend" / "scripts"))
    import uvicorn
    from xscript_server.__main__ import main as cli
    from xscript_server.app import create_app
    from xscript_server.config import Config
    from xscript_server.models import AuthToken, DeviceKey, User
    from xscript_server.security import hash_password, new_secret, token_hash
    import demo  # backend/scripts/demo.py: simulated phones

    data = Path(tempfile.mkdtemp(prefix="xscript-p4-e2e-"))
    os.environ["XSCRIPT_ADMIN_PASSWORD"] = new_secret("pw-")
    cli(["--data", str(data), "init"])
    cfg = Config.load(data)
    app = create_app(cfg)
    ctx = app.state.ctx
    out = {"origin": "http://127.0.0.1:%d" % port, "port": port}
    with ctx.db.session() as s:
        admin = s.query(User).filter(User.role == "admin").one()
        viewer = User(username="p4-viewer", password_hash=hash_password(new_secret("pw-")), role="viewer")
        s.add(viewer)
        s.flush()
        for key, user in (("admin", admin), ("viewer", viewer)):
            tok = new_secret("xsk_")
            s.add(AuthToken(user_id=user.id, token_hash=token_hash(tok), kind="api", name="p4 e2e"))
            out[key] = tok
        dk = new_secret("xsd_")
        s.add(DeviceKey(name="p4 e2e", token_hash=token_hash(dk), hint=dk[:4] + "…" + dk[-4:], created_by="e2e"))
        out["device_key"] = dk
        s.commit()
    fd = os.open(secrets_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(out, f)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="websockets-sansio"))
    threading.Thread(target=server.run, daemon=True).start()
    t0 = time.time()
    while not server.started:
        if time.time() - t0 > 15:  # port taken: uvicorn logged it; do not leave the data directory behind
            shutil.rmtree(data, ignore_errors=True)
            sys.exit("backend did not start on port %d" % port)
        time.sleep(0.05)
    print("backend ready on 127.0.0.1:%d (secrets in %s)" % (port, secrets_path), flush=True)
    url = "ws://127.0.0.1:%d/ws?token=%s" % (port, out["device_key"])
    import signal

    def stop(*_a):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)

    async def phones() -> None:
        await asyncio.gather(*(demo.fake_device(url, i) for i in range(3)))

    try:
        asyncio.run(phones())
    except KeyboardInterrupt:
        pass
    finally:
        server.should_exit = True
        shutil.rmtree(data, ignore_errors=True)


# ---------------------------------------------------------------- check (desktop venv)

class Check:
    def __init__(self) -> None:
        self.failed = 0

    def __call__(self, name: str, ok: bool, detail: str = "") -> None:
        print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else " — " + detail), flush=True)
        self.failed += 0 if ok else 1


async def check(secrets_path: str, serial: str, dev_port: int, package: str) -> int:
    sys.path.insert(0, str(ROOT / "desktop" / "app"))
    sys.path.insert(0, str(ROOT / "scripts"))
    import httpx
    import devauth
    from xscript_desktop.context import AppContext

    sec = json.loads(Path(secrets_path).read_text())
    adb = devauth._adb() or "adb"
    local = subprocess.run([adb, "-s", serial, "forward", "tcp:0", "tcp:%d" % dev_port], capture_output=True, text=True, check=True).stdout.strip()
    base = "http://127.0.0.1:%s" % local
    ok = Check()
    ctx = AppContext(poll_interval=60)

    async def rpc(method: str, **params):
        raw = await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params}))
        for k in ("admin", "viewer", "device_key"):
            assert sec[k] not in raw, "secret leaked in %s reply" % method
        return json.loads(raw)

    async with httpx.AsyncClient(base_url=base, timeout=30, trust_env=False) as dev:
        h = devauth.headers(base, serial=serial)
        st = (await dev.get("/status", headers=h)).json()
        ok("device is %s" % package, st.get("package", st.get("app_id", package)) == package or package in json.dumps(st), json.dumps(st)[:200])

        async def ev(code: str):
            r = await dev.post("/eval", headers=h, json={"code": code, "timeout_ms": 15000})
            return r.json()

        ws = "ws://10.0.2.2:%d/ws?token=%s" % (sec["port"], sec["device_key"])
        await ev("from xscript.android import cloud\ncloud.connect(%r, group=%r)" % (ws, GROUP))
        try:
            # ---- admin
            r = await rpc("cloud.connect", origin=sec["origin"], token=sec["admin"])
            ok("admin connects", r.get("ok") and r["result"]["account"]["isAdmin"], json.dumps(r)[:200])
            dev_id = None
            for _ in range(40):
                r = await rpc("cloud.devices", group=GROUP, online=True)
                if r.get("ok") and r["result"]["items"]:
                    dev_id = r["result"]["items"][0]["id"]
                    break
                await asyncio.sleep(0.5)
            ok("device shows up online in group %s" % GROUP, dev_id is not None)
            if dev_id is None:
                return 1
            r = await rpc("cloud.devices")
            ok("device table lists the simulated phones too", r["result"]["total"] >= 4, str(r["result"]["total"]))
            r = await rpc("cloud.groups")
            ok("groups include %s" % GROUP, any(g["name"] == GROUP and g["online"] >= 1 for g in r["result"]["groups"]))

            files = [{"path": "__init__.py", "content": "from .flows import p4_e2e  # noqa\n"},
                     {"path": "flows/__init__.py", "content": ""},
                     {"path": "flows/p4_e2e.py", "content": "import time\nfor i in range(3):\n    print('p4 e2e step', i)\n    time.sleep(0.3)\nprint('p4 e2e done')\n"}]
            r = await rpc("cloud.flowDeploy", project=PROJECT, files=files, group=GROUP, version="1.0.0", notes="e2e v1")
            ok("deploy v1 to the group installs and runs", r.get("ok") and r["result"]["ok"] == r["result"]["total"] == 1, json.dumps(r)[:300])
            files[2]["content"] = files[2]["content"].replace("done", "done v2")
            r = await rpc("cloud.flowDeploy", project=PROJECT, files=files, group=GROUP, version="1.1.0", notes="e2e v2")
            ok("deploy v2", r.get("ok") and r["result"]["ok"] == 1, json.dumps(r)[:300])
            r = await rpc("cloud.flowVersions", project=PROJECT)
            vers = r["result"]["versions"]
            ok("two versions kept", [v["version"] for v in vers] == ["1.1.0", "1.0.0"], json.dumps(vers)[:200])
            r = await rpc("cloud.command", ids=[dev_id], action="run", project=PROJECT)
            ok("bulk run on the selected device", r.get("ok") and r["result"]["ok"] == 1, json.dumps(r)[:300])
            found = False
            for _ in range(30):
                await asyncio.sleep(1)
                r = await rpc("cloud.logs", id=dev_id, q="p4 e2e")
                lines = [x["line"] for x in r.get("result", {}).get("items", [])]
                if any("done v2" in line for line in lines):
                    found = True
                    break
            ok("run log reaches the backend and is searchable", found, json.dumps(r)[:300])
            sid = (await rpc("cloud.flowVersions", project=PROJECT))["result"]["scriptId"]
            r = await rpc("cloud.flowRollback", scriptId=sid, versionId=vers[1]["id"], group=GROUP)
            ok("rollback to 1.0.0", r.get("ok") and r["result"]["ok"] == 1 and r["result"]["version"] == "1.0.0", json.dumps(r)[:300])
            r = await rpc("cloud.command", ids=[dev_id], action="stop")
            ok("bulk stop", r.get("ok") and r["result"]["total"] == 1, json.dumps(r)[:200])
            r = await rpc("cloud.taskCreate", name="p4 e2e", target="group:" + GROUP, path="app_stop", every=60)
            tid = r.get("result", {}).get("id")
            ok("task create", bool(tid), json.dumps(r)[:200])
            r = await rpc("cloud.taskUpdate", id=tid, enabled=False)
            ok("task toggle", r.get("ok") and r["result"]["enabled"] is False)
            r = await rpc("cloud.taskRun", id=tid)
            ok("task run now", r.get("ok"), json.dumps(r)[:200])
            ok("task delete", (await rpc("cloud.taskDelete", id=tid)).get("ok"))
            r = await rpc("cloud.packJobs")
            ok("pack jobs list", r.get("ok"), json.dumps(r)[:200])
            r = await rpc("cloud.console")
            ok("console links", r.get("ok") and r["result"]["links"][0]["url"].startswith(sec["origin"]))
            data, mime = await ctx.cloud_thumb(dev_id, 320)
            ok("screen thumbnail through the relay", mime.startswith("image/") and len(data) > 1000, "%s %d" % (mime, len(data)))

            # ---- viewer
            r = await rpc("cloud.connect", origin=sec["origin"], token=sec["viewer"])
            acc = r.get("result", {}).get("account", {})
            ok("viewer connects read-only", acc.get("role") == "viewer" and acc.get("canOperate") is False, json.dumps(r)[:200])
            ok("viewer can list devices", (await rpc("cloud.devices", group=GROUP)).get("ok"))
            ok("viewer can search logs", (await rpc("cloud.logs", id=dev_id, q="p4")).get("ok"))
            r = await rpc("cloud.command", ids=[dev_id], action="stop")
            ok("viewer bulk command refused", r.get("error", {}).get("code") == "backend.forbidden", json.dumps(r)[:200])
            r = await rpc("cloud.flowDeploy", project=PROJECT, files=files, group=GROUP)
            ok("viewer deploy refused", r.get("error", {}).get("code") == "backend.forbidden", json.dumps(r)[:200])
            try:
                await ctx.cloud_thumb(dev_id)
                ok("viewer thumbnail refused", False)
            except Exception as e:  # BackendError
                ok("viewer thumbnail refused", getattr(e, "code", "") == "backend.forbidden", str(e))
            await rpc("cloud.disconnect")
        finally:
            await ev("from xscript.android import cloud\ncloud.close()")
            await dev.delete("/projects/" + PROJECT, headers=h)
            subprocess.run([adb, "-s", serial, "forward", "--remove", "tcp:%s" % local], capture_output=True)
            await ctx.shutdown()
    print("e2e: %s" % ("OK" if not ok.failed else "%d FAILED" % ok.failed), flush=True)
    return 1 if ok.failed else 0


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "serve":
        serve(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 8791)
    elif len(sys.argv) >= 5 and sys.argv[1] == "check":
        sys.exit(asyncio.run(check(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5] if len(sys.argv) > 5 else "com.xscript.app.perf")))
    else:
        print(__doc__)
        sys.exit(2)
