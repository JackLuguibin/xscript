#!/usr/bin/env python3
"""Local demo for the admin console: fake devices on 云控, sample cards and a task.

    python backend/scripts/demo.py            # http://127.0.0.1:8765  admin / admin-demo-123

Uses a throwaway data directory under /tmp. Development only.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import random
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import uvicorn  # noqa: E402
import websockets  # noqa: E402

from xscript_server.__main__ import main as cli  # noqa: E402
from xscript_server.app import create_app  # noqa: E402
from xscript_server.config import Config  # noqa: E402

# what a real phone reports: the on-device runtime's version (== App versionName, see release.sh check)
_RUNTIME_INIT = Path(__file__).resolve().parents[2] / "android" / "python-runtime" / "xscript" / "__init__.py"
APP_VERSION = next(line.split('"')[1] for line in _RUNTIME_INIT.read_text(encoding="utf-8").splitlines()
                   if line.startswith("__version__ = "))
from xscript_server.security import new_secret, token_hash  # noqa: E402

PORT = int(os.environ.get("PORT", "8765"))
# 1x1 grey JPEG so screenshots render.
JPEG = ("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////"
        "////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8"
        "AN//Z")

def screen_svg(n: int, taps: list[tuple[int, int]]) -> bytes:
    """A phone-shaped frame with the clock and recent taps, so 远程操控 has something to show.
    Real devices return JPEG; SVG keeps the demo free of image libraries."""
    w, h = 360, 800
    hue = ["#4f5bd5", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0e7490"][n % 6]
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (w, h, w, h),
             '<rect width="%d" height="%d" fill="#f5f6f8"/>' % (w, h),
             '<rect width="%d" height="150" fill="%s"/>' % (w, hue),
             '<text x="20" y="62" font-family="sans-serif" font-size="30" fill="#fff">%s</text>' % time.strftime("%H:%M:%S"),
             '<text x="20" y="110" font-family="sans-serif" font-size="16" fill="#fff" opacity=".85">XScript demo #%d</text>' % n]
    for i in range(6):
        y = 180 + i * 96
        parts.append('<rect x="20" y="%d" width="%d" height="80" rx="14" fill="#fff" stroke="#e2e5ea"/>' % (y, w - 40))
        parts.append('<text x="40" y="%d" font-family="sans-serif" font-size="16" fill="#111827">Item %d</text>'
                     % (y + 46, i + 1))
    for x, y in taps[-5:]:
        parts.append('<circle cx="%d" cy="%d" r="14" fill="none" stroke="%s" stroke-width="4"/>'
                     % (x * w // 1080, y * h // 2400, hue))
    parts.append("</svg>")
    return "".join(parts).encode()


MODELS = [("Xiaomi", "Redmi Note 12"), ("HUAWEI", "nova 11"), ("OPPO", "Reno10"), ("vivo", "S17"), ("Google", "Pixel 7")]


async def fake_device(url: str, n: int) -> None:
    brand, model = MODELS[n % len(MODELS)]
    dev_id = "%016x" % (0xA1B2C3D4E5F60000 + n)
    group = ["farm-1", "farm-2", ""][n % 3]
    running = {"project": "demo" if n % 2 == 0 else None}
    taps: list[tuple[int, int]] = []
    log: list[dict] = []

    def add_line(line: str, stream: str = "stdout", ts: int | None = None) -> None:
        log.append({"seq": len(log) + 1, "ts": ts or int(time.time() * 1000), "stream": stream, "line": line + "\n"})

    # An hour of earlier output, so 运行日志 → 历史 has something to page through.
    start = int(time.time() * 1000) - 3600_000
    for i in range(120):
        add_line("[demo] 第 %d 轮：金币 +%d" % (i, random.randint(1, 50)), ts=start + i * 30_000)
        if i % 37 == 36:
            add_line("WARNING: 网络较慢，重试中", "stderr", ts=start + i * 30_000 + 500)
    # The crashed farm_bot run listed in 最近运行: its log ends in a traceback into the project (出错位置).
    crash_from = len(log)
    pdir = "/storage/emulated/0/Android/data/com.xscript.app/files/projects/farm_bot"
    for stream, line in [("stdout", "[farm_bot] 第 12 轮：收菜"), ("stderr", "Traceback (most recent call last):"),
                         ("stderr", f'  File "{pdir}/__init__.py", line 8, in <module>'), ("stderr", "    main()"),
                         ("stderr", f'  File "{pdir}/harvest.py", line 42, in main'), ("stderr", "    tap_harvest()"),
                         ("stderr", "TimeoutError: 找不到「收获」按钮")]:
        add_line(line, stream, ts=start + 3_590_000)
    crash_to = len(log)

    async def produce():
        while True:
            await asyncio.sleep(2)
            if running["project"]:
                add_line("[%s] 第 %d 轮：金币 +%d" % (running["project"], len(log), random.randint(1, 50)))

    asyncio.create_task(produce())
    pushers: list[asyncio.Task] = []
    while True:
        cursor = {"seq": -1}  # like CloudClient.kt: wait for the server's log_cursor
        try:
            async with websockets.connect(url) as ws:
                async def push():
                    while True:
                        await asyncio.sleep(3)
                        if cursor["seq"] >= 0:
                            batch = [e for e in log if e["seq"] > cursor["seq"]][:500]
                            if batch:
                                await ws.send(json.dumps({"type": "logs", "entries": batch}))
                                cursor["seq"] = batch[-1]["seq"]

                pusher = asyncio.create_task(push())
                pushers.append(pusher)

                def status():
                    return {"model": model, "brand": brand, "running": bool(running["project"]),
                            "project": running["project"], "channel": "accessibility", "version": APP_VERSION,
                            "sdk": 34, "release": "14", "width": 1080, "height": 2400}

                await ws.send(json.dumps({"type": "hello", "device_id": dev_id, "group": group,
                                          "app": "com.xscript.app", "device": status()}))
                await ws.send(json.dumps({"type": "data", "data": {"gold": random.randint(100, 900), "level": n + 1}}))
                if n == 1:
                    # One device has a crashed run, so 运行日志 and 告警 have something to show.
                    await ws.send(json.dumps({"type": "run_end", "project": "farm_bot", "exit": "1", "crashed": True,
                                              "time": int(time.time()) - 600, "tail": [
                                                  {"stream": "stdout", "line": "第 12 轮：收菜"},
                                                  {"stream": "stderr", "line": "Traceback (most recent call last):"},
                                                  {"stream": "stderr", "line": '  File "farm_bot/__init__.py", line 42'},
                                                  {"stream": "stderr", "line": "TimeoutError: 找不到「收获」按钮"}]}))
                async for raw in ws:
                    d = json.loads(raw)
                    if d.get("type") == "log_cursor":
                        cursor["seq"] = int(d.get("seq") or 0)
                        continue
                    if d.get("type") == "request":
                        mime, payload = "application/json", json.dumps(status()).encode()
                        if d["path"] == "/screen":
                            mime, payload = "image/svg+xml", screen_svg(n, taps)
                        elif d["path"] == "/action":
                            act = json.loads(base64.b64decode(d.get("body") or "") or b"{}")
                            if act.get("type") == "click":
                                taps.append((act.get("x", 0), act.get("y", 0)))
                            payload = b'{"ok": true}'
                        elif d["path"] == "/logs":
                            since = int((d.get("query") or {}).get("since") or 0)
                            payload = json.dumps({"entries": [e for e in log if e["seq"] > since][-200:],
                                                  "next": len(log)}).encode()
                        elif d["path"] == "/projects":
                            payload = json.dumps({"projects": [{"name": "farm_bot"}, {"name": "daily_sign"}]}).encode()
                        elif d["path"].startswith("/projects/") and d["path"].endswith("/runs"):
                            # 最近运行 (App v0.5.0+): a crash, a stopped run and a clean one with 运行统计.
                            now = int(time.time() * 1000)
                            payload = json.dumps({"runs": [
                                {"project": d["path"].split("/")[2], "start": now - 600_000, "duration_ms": 184_000, "exit": "1",
                                 "user_stop": False, "outcome": "出错退出（退出码 1）", "failed": True,
                                 "log_from": crash_from, "log_to": crash_to,
                                 "stats": {"captures": 96, "capture_avg_ms": 38, "peak_mb": 212}},
                                {"project": d["path"].split("/")[2], "start": now - 3_600_000, "duration_ms": 42_500, "exit": "stopped",
                                 "user_stop": True, "outcome": "已停止", "failed": False, "log_from": 0, "log_to": 0},
                                {"project": d["path"].split("/")[2], "start": now - 7_200_000, "duration_ms": 305_000, "exit": "0",
                                 "user_stop": False, "outcome": "正常结束", "failed": False, "log_from": 0, "log_to": 0,
                                 "stats": {"captures": 154, "capture_avg_ms": 35, "peak_mb": 198}},
                            ]}).encode()
                        elif d["path"].endswith("/zip") and d["method"] == "PUT":
                            payload = json.dumps({"ok": True, "project": d["path"].split("/")[2]}).encode()
                        body = base64.b64encode(payload).decode()
                        await ws.send(json.dumps({"type": "response", "id": d["id"], "status": 200,
                                                  "mime": mime, "body": body}))
                        continue
                    if "path" not in d:
                        continue
                    reply = {"path": d["path"], "code": 1, "msg": "success", "seq": d.get("seq"), "device_id": dev_id}
                    if d["path"] == "app_run":
                        running["project"] = d.get("id")
                    elif d["path"] == "app_stop":
                        if not running["project"]:
                            reply.update(code=-1, msg="not running")
                        running["project"] = None
                    elif d["path"] == "screen_shot":
                        reply["result"] = {"image": JPEG, "scale": 1}
                    await ws.send(json.dumps(reply))
                    await ws.send(json.dumps({"type": "status", "group": group, "device": status()}))
        except Exception:
            await asyncio.sleep(2)
        finally:
            while pushers:
                pushers.pop().cancel()


def seed_scripts(cfg: Config, s) -> None:
    """Two 小程序 with a few versions, the second one published."""
    import hashlib
    import io
    import zipfile

    from xscript_server import scripts as store
    from xscript_server.models import Script, ScriptVersion

    if s.query(Script).count():
        return
    for name, project, desc in (("自动签到", "auto_sign", "每天打开 App 完成签到并领取奖励"),
                                ("农场挂机", "farm_bot", "多设备挂机收菜，结果通过 cloud.send 上报")):
        sc = Script(name=name, project_name=project, description=desc, channel=store.new_channel(), created_by="admin")
        s.add(sc)
        s.flush()
        for i, ver in enumerate(("1.0.0", "1.0.1", "1.1.0")):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                zf.writestr(project + "/__init__.py", "print('%s %s')\n" % (project, ver))
            data = buf.getvalue()
            v = ScriptVersion(script_id=sc.id, version=ver, version_code=i + 1, notes=["首个版本", "修复点击偏移", "新增多分辨率适配"][i],
                              sha256=hashlib.sha256(data).hexdigest(), size=len(data), files=1, created_by="admin")
            s.add(v)
            s.flush()
            d = store.version_dir(cfg, sc.id, v.id)
            d.mkdir(parents=True, exist_ok=True)
            (d / "source.zip").write_bytes(data)
            if i == 1:
                sc.current_version_id = v.id
    s.commit()


def seed_history(s) -> None:
    """60 days of activations, expirations and online devices so the 概览 趋势 chart has a shape."""
    from xscript_server import cards
    from xscript_server.models import Card, Device, DeviceDay

    rnd = random.Random(7)
    now = time.time()
    batches = [("com.me.game", "演示月卡"), ("com.me.farm", "农场周卡"), ("com.me.game", "活动卡")]
    n = 0
    for back in range(59, -1, -1):
        day = now - back * 86400
        lt = time.localtime(day)
        label = time.strftime("%Y-%m-%d", lt)
        weekend = lt.tm_wday >= 5
        online = int(18 + (59 - back) * 0.35 + (6 if weekend else 0) + rnd.randint(-3, 3))
        for i in range(online):
            s.add(DeviceDay(day=label, device="hist-%02d" % i))
        for _ in range(max(0, int(4 + (59 - back) * 0.08 + (3 if weekend else 0) + rnd.randint(-2, 3)))):
            app, note = rnd.choice(batches)
            act = int(day - rnd.randint(0, 36000))
            n += 1
            s.add(Card(card="HIST-%05d" % n, app=app, batch=note, note=note, days=30, activated_at=act,
                       expires_at=act + 30 * 86400, device="hist-%02d" % rnd.randint(0, 40)))
    for i in range(45):
        s.add(Device(id="hist-%02d" % i, device_id="hist-%02d" % i, app="com.me.game",
                     first_seen=int(now - rnd.randint(0, 59) * 86400), last_seen=int(now - rnd.randint(0, 3) * 86400)))
    del cards


def main() -> None:
    data = Path(tempfile.gettempdir()) / "xscript-demo"
    cfg = Config.load(data)
    os.environ.setdefault("XSCRIPT_ADMIN_PASSWORD", "admin-demo-123")
    if not cfg.db_path.exists():
        cli(["--data", str(data), "init"])
    app = create_app(cfg)
    ctx = app.state.ctx
    value = new_secret("xsd_")
    from xscript_server.models import DeviceKey

    with ctx.db.session() as s:
        s.add(DeviceKey(name="演示设备", token_hash=token_hash(value), hint=value[:4] + "…" + value[-4:], created_by="demo"))
        from xscript_server import cards

        if not s.query(cards.Card).count():
            cards.create_batch(s, 25, 30, "com.me.game", "演示月卡")
            cards.create_batch(s, 10, 0, "*", "永久卡")
            seed_history(s)
        s.commit()
        seed_scripts(cfg, s)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning", ws="websockets-sansio"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    print("console: http://127.0.0.1:%d  (admin / %s)" % (PORT, os.environ["XSCRIPT_ADMIN_PASSWORD"]), flush=True)
    url = "ws://127.0.0.1:%d/ws?token=%s" % (PORT, value)

    async def run():
        await asyncio.gather(*(fake_device(url, i) for i in range(6)))

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        server.should_exit = True


if __name__ == "__main__":
    main()
