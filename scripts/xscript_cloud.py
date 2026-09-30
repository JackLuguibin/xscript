#!/usr/bin/env python3
"""Reference 云控 server for XScript devices (single file, aiohttp).

    pip install aiohttp==3.14.3 cryptography
    python scripts/xscript_cloud.py --port 8765 --token SECRET
    # device: 云端控制 → ws://<server>:8765/ws?token=SECRET
    # browser: http://<server>:8765/?token=SECRET

Features
  * Device list with live status (running project, cloud data sent by scripts, last seen).
  * Groups: the device reports one (app setting / cloud.connect(group=)); the dashboard
    can override it. Commands target one device, a group, or all devices.
  * AScript command set: app_run {id, param, card}, app_stop, device_info, screen_shot,
    device_action (click / swipe / key), app_list, plus `message` to running scripts.
  * Full device API relay: POST /api/devices/<id>/http {"method", "path", "query", "body"}.
  * 定时任务: server-side cron-style tasks ("daily HH:MM" / "every N" minutes) that send a
    command to a target.
  * 卡密: with --licenses DB --key private.pem, serves /license/activate and /license/verify
    for packaged apps (see scripts/xscript_license.py).

Security: always run with --token (and TLS in front of it on the internet). The token is
checked on the device socket, the dashboard and the API; license endpoints are public
because apps call them before activation.

REST API (all JSON, ?token= or header "Authorization: Bearer <token>"):
  GET  /api/devices                               list
  POST /api/devices/<id>/group     {"group"}      set group override
  POST /api/command {"target": "<id>|group:<g>|app:<app id>|all", "command": {"path": "app_run", ...}}
       → {"results": {device_id: reply}}          waits up to "timeout" seconds (default 20)
  POST /api/devices/<id>/http      {"method","path","query","body"(str)|"body_b64"}
  GET  /api/tasks  POST /api/tasks {"target","command","daily":"08:30"|"every":15}  DELETE /api/tasks/<id>
"""

import argparse
import asyncio
import base64
import datetime as dt
import hmac
import itertools
import json
import os
import sys
import time

try:
    from aiohttp import WSMsgType, web
except ImportError:  # pragma: no cover
    sys.exit("xscript_cloud.py needs aiohttp: pip install aiohttp==3.14.3")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HUB = web.AppKey("hub", object)
SCHEDULER = web.AppKey("scheduler", object)


class Device(object):
    """One connected app. Several apps on one phone (XScript and packaged apps) share an
    ANDROID_ID, so a connection is keyed by device id + app id."""

    def __init__(self, ws, hello, remote):
        self.ws = ws
        self.device_id = hello.get("device_id") or ("anon-%x" % id(ws))
        self.app = hello.get("app", "")
        self.id = self.device_id if self.app in ("", "com.xscript.app") else "%s@%s" % (self.device_id, self.app)
        self.reported_group = hello.get("group") or ""
        self.status = hello.get("device") or {}
        self.data = {}
        self.remote = remote
        self.connected = time.time()
        self.seen = time.time()
        self.pending = {}  # correlation id -> Future

    def summary(self, group_override):
        return {
            "id": self.id,
            "device_id": self.device_id,
            "group": group_override or self.reported_group,
            "reported_group": self.reported_group,
            "app": self.app,
            "model": self.status.get("model", ""),
            "brand": self.status.get("brand", ""),
            "running": bool(self.status.get("running")),
            "project": self.status.get("project"),
            "channel": self.status.get("channel"),
            "version": self.status.get("version"),
            "data": self.data,
            "remote": self.remote,
            "connected": int(self.connected),
            "seen": int(self.seen),
        }


class Hub(object):
    def __init__(self, token="", state_file=None, licenses=None, key=None):
        self.token = token
        self.devices = {}
        self.groups = {}       # device id -> group override
        self.tasks = {}        # task id -> task
        self.seq = itertools.count(1)
        self.state_file = state_file
        self.licenses = licenses
        self.key = key
        self.log = []          # recent events for the dashboard
        self._load()

    # ---- persistence (groups and tasks survive restarts)

    def _load(self):
        if not self.state_file or not os.path.isfile(self.state_file):
            return
        with open(self.state_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.groups = data.get("groups", {})
        self.tasks = {t["id"]: t for t in data.get("tasks", [])}

    def _save(self):
        if not self.state_file:
            return
        tmp = self.state_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"groups": self.groups, "tasks": list(self.tasks.values())}, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.state_file)

    def note(self, text):
        self.log.append({"time": int(time.time()), "text": text})
        del self.log[:-200]

    # ---- targeting

    def group_of(self, dev):
        return self.groups.get(dev.id) or dev.reported_group

    def select(self, target):
        target = (target or "all").strip()
        if target == "all":
            return list(self.devices.values())
        if target.startswith("group:"):
            g = target[6:]
            return [d for d in self.devices.values() if self.group_of(d) == g]
        ids = {t.strip() for t in target.split(",")}
        if target.startswith("app:"):
            return [d for d in self.devices.values() if d.app == target[4:]]
        return [d for d in self.devices.values() if d.id in ids]

    # ---- commands

    async def call(self, dev, frame, timeout=20.0):
        """Send one command and wait for its reply (matched by "seq"; "id" is the program id)."""
        cid = "c%d" % next(self.seq)
        frame = dict(frame, seq=cid)
        fut = asyncio.get_running_loop().create_future()
        dev.pending[cid] = fut
        try:
            await dev.ws.send_str(json.dumps(frame, ensure_ascii=False))
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return {"code": -1, "msg": "timeout", "path": frame.get("path")}
        except Exception as e:  # socket closed
            return {"code": -1, "msg": str(e), "path": frame.get("path")}
        finally:
            dev.pending.pop(cid, None)

    async def command(self, target, command, timeout=20.0):
        devs = self.select(target)
        if not isinstance(command, dict) or not command.get("path"):
            raise web.HTTPBadRequest(text=json.dumps({"error": "command needs a path"}), content_type="application/json")
        if command["path"] == "message":
            # Fire-and-forget to scripts: no reply needed from each device.
            frame = {"type": "message", "data": command.get("data")}
            for d in devs:
                await d.ws.send_str(json.dumps(frame, ensure_ascii=False))
            return {d.id: {"code": 1, "msg": "sent"} for d in devs}
        results = await asyncio.gather(*(self.call(d, command, timeout) for d in devs))
        self.note("%s → %s (%d devices)" % (command["path"], target, len(devs)))
        return {d.id: r for d, r in zip(devs, results)}

    async def relay(self, dev, method, path, query=None, body=b"", timeout=30.0):
        cid = "r%d" % next(self.seq)
        fut = asyncio.get_running_loop().create_future()
        dev.pending[cid] = fut
        frame = {"type": "request", "id": cid, "method": method, "path": path, "query": query or {},
                 "body": base64.b64encode(body).decode("ascii")}
        try:
            await dev.ws.send_str(json.dumps(frame))
            return await asyncio.wait_for(fut, timeout)
        finally:
            dev.pending.pop(cid, None)

    # ---- tasks

    def due(self, task, now):
        last = task.get("last", 0)
        if task.get("every"):
            return now - last >= float(task["every"]) * 60
        if task.get("daily"):
            hh, mm = [int(x) for x in task["daily"].split(":")]
            today = dt.datetime.fromtimestamp(now).replace(hour=hh, minute=mm, second=0, microsecond=0).timestamp()
            return now >= today > last
        return False

    async def scheduler(self):
        while True:
            await asyncio.sleep(15)
            now = time.time()
            for task in list(self.tasks.values()):
                if not task.get("enabled", True) or not self.due(task, now):
                    continue
                task["last"] = now
                self._save()
                try:
                    res = await self.command(task["target"], task["command"])
                    task["result"] = {k: v.get("code") for k, v in res.items()}
                except Exception as e:  # keep the loop alive
                    task["result"] = {"error": str(e)}
                self.note("task %s ran" % task["id"])


# ---------------------------------------------------------------- HTTP handlers

def _token_ok(hub, request):
    if not hub.token:
        return True
    got = request.query.get("token") or ""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        got = auth[7:]
    return hmac.compare_digest(got.encode(), hub.token.encode())


def _need_token(handler):
    async def wrapped(request):
        if not _token_ok(request.app[HUB], request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)
    return wrapped


async def ws_device(request):
    hub = request.app[HUB]
    if not _token_ok(hub, request):
        return web.Response(status=401, text="unauthorized")
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=64 * 1024 * 1024)
    await ws.prepare(request)
    dev = None
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            if dev is None:
                if data.get("type") != "hello":
                    continue
                dev = Device(ws, data, request.remote)
                old = hub.devices.get(dev.id)
                if old is not None and old.ws is not ws:
                    await old.ws.close()
                hub.devices[dev.id] = dev
                hub.note("device %s connected" % dev.id)
                continue
            dev.seen = time.time()
            t = data.get("type")
            if t == "status":
                dev.status = data.get("device") or dev.status
                dev.reported_group = data.get("group", dev.reported_group)
            elif t == "data":
                payload = data.get("data")
                if isinstance(payload, dict):
                    dev.data.update(payload)
                else:
                    dev.data["value"] = payload
            elif t == "response" or "path" in data:
                key = data.get("id", "") if t == "response" else data.get("seq", "")
                fut = dev.pending.get(str(key))
                if fut is not None and not fut.done():
                    fut.set_result(data)
    finally:
        if dev is not None and hub.devices.get(dev.id) is dev:
            del hub.devices[dev.id]
            hub.note("device %s disconnected" % dev.id)
            for fut in dev.pending.values():
                if not fut.done():
                    fut.set_result({"code": -1, "msg": "disconnected"})
    return ws


@_need_token
async def api_devices(request):
    hub = request.app[HUB]
    devs = sorted(hub.devices.values(), key=lambda d: (hub.group_of(d), d.id))
    return web.json_response({"devices": [d.summary(hub.groups.get(d.id)) for d in devs],
                              "groups": sorted({hub.group_of(d) for d in devs if hub.group_of(d)}),
                              "log": hub.log[-30:]})


@_need_token
async def api_set_group(request):
    hub = request.app[HUB]
    body = await request.json()
    dev_id = request.match_info["id"]
    g = (body.get("group") or "").strip()
    if g:
        hub.groups[dev_id] = g
    else:
        hub.groups.pop(dev_id, None)
    hub._save()
    return web.json_response({"ok": True, "group": g})


@_need_token
async def api_command(request):
    hub = request.app[HUB]
    body = await request.json()
    res = await hub.command(body.get("target", "all"), body.get("command") or {}, float(body.get("timeout", 20)))
    return web.json_response({"results": res})


@_need_token
async def api_http(request):
    hub = request.app[HUB]
    dev = hub.devices.get(request.match_info["id"])
    if dev is None:
        return web.json_response({"error": "device offline"}, status=404)
    body = await request.json()
    raw = base64.b64decode(body["body_b64"]) if body.get("body_b64") else (body.get("body") or "").encode("utf-8")
    try:
        reply = await hub.relay(dev, body.get("method", "GET"), body.get("path", "/status"), body.get("query"), raw,
                                float(body.get("timeout", 30)))
    except asyncio.TimeoutError:
        return web.json_response({"error": "timeout"}, status=504)
    data = base64.b64decode(reply.get("body") or "")
    mime = reply.get("mime", "application/octet-stream")
    return web.Response(status=int(reply.get("status", 200)), body=data, content_type=mime.split(";")[0])


@_need_token
async def api_tasks(request):
    hub = request.app[HUB]
    if request.method == "GET":
        return web.json_response({"tasks": list(hub.tasks.values())})
    body = await request.json()
    if not body.get("command", {}).get("path") or not (body.get("daily") or body.get("every")):
        return web.json_response({"error": "task needs command.path and daily or every"}, status=400)
    if body.get("daily"):
        try:
            hh, mm = [int(x) for x in body["daily"].split(":")]
            assert 0 <= hh < 24 and 0 <= mm < 60
        except Exception:
            return web.json_response({"error": "daily must be HH:MM"}, status=400)
    tid = "t%d" % int(time.time() * 1000)
    task = {"id": tid, "target": body.get("target", "all"), "command": body["command"],
            "daily": body.get("daily"), "every": body.get("every"), "enabled": True, "last": time.time()}
    hub.tasks[tid] = task
    hub._save()
    return web.json_response(task)


@_need_token
async def api_task_delete(request):
    hub = request.app[HUB]
    ok = hub.tasks.pop(request.match_info["id"], None) is not None
    hub._save()
    return web.json_response({"ok": ok})


async def license_activate(request):
    hub = request.app[HUB]
    if hub.licenses is None:
        return web.json_response({"error": "license server not configured"}, status=404)
    body = await request.json()
    card, device = (body.get("card") or "").strip(), (body.get("device_id") or "").strip()
    if not card or not device:
        return web.json_response({"error": "card and device_id are required"}, status=400)
    token, err = hub.licenses.activate(hub.key, card, device, body.get("app") or "*", body.get("model") or "")
    if err:
        return web.json_response({"error": err}, status=403)
    hub.note("card %s activated on %s" % (card[:7] + "…", device))
    return web.json_response({"token": token})


async def license_verify(request):
    import xscript_license as lic

    hub = request.app[HUB]
    if hub.licenses is None:
        return web.json_response({"error": "license server not configured"}, status=404)
    body = await request.json()
    payload = lic.verify(lic.public_b64(hub.key), body.get("token") or "")
    if payload is None:
        return web.json_response({"status": "revoked", "revoked": True})
    state = hub.licenses.check_token(payload)
    return web.json_response({"status": state, "revoked": state in ("revoked", "unknown")})


async def dashboard(request):
    hub = request.app[HUB]
    if not _token_ok(hub, request):
        return web.Response(status=401, text="add ?token=... to the URL")
    return web.Response(text=DASHBOARD, content_type="text/html", charset="utf-8")


def make_app(hub):
    app = web.Application(client_max_size=256 * 1024 * 1024)
    app[HUB] = hub
    app.router.add_get("/", dashboard)
    app.router.add_get("/ws", ws_device)
    app.router.add_get("/api/devices", api_devices)
    app.router.add_post("/api/devices/{id}/group", api_set_group)
    app.router.add_post("/api/devices/{id}/http", api_http)
    app.router.add_post("/api/command", api_command)
    app.router.add_route("*", "/api/tasks", api_tasks)
    app.router.add_delete("/api/tasks/{id}", api_task_delete)
    app.router.add_post("/license/activate", license_activate)
    app.router.add_post("/license/verify", license_verify)

    async def start_scheduler(app):
        app[SCHEDULER] = asyncio.create_task(hub.scheduler())

    async def stop_scheduler(app):
        app[SCHEDULER].cancel()

    app.on_startup.append(start_scheduler)
    app.on_cleanup.append(stop_scheduler)
    return app


DASHBOARD = r"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>XScript 云控</title>
<style>
body{font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:0;background:#f4f5f7;color:#1f2329}
header{background:#fff;padding:12px 20px;border-bottom:1px solid #e5e6eb;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0 12px 0 0}main{padding:16px 20px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid #eef0f3;text-align:left;vertical-align:top}th{background:#fafbfc;font-weight:600}
button,select,input{font:inherit;padding:5px 10px;border:1px solid #d0d3d9;border-radius:6px;background:#fff}
button{cursor:pointer}button.primary{background:#2f7cf6;border-color:#2f7cf6;color:#fff}
.on{color:#34a853}.muted{color:#8f959e}code{font-size:12px;background:#f2f3f5;padding:1px 4px;border-radius:4px}
#log{font-size:12px;color:#646a73;white-space:pre-wrap;margin-top:12px}img.shot{max-height:220px;border:1px solid #ddd;border-radius:4px}
label{display:inline-flex;gap:4px;align-items:center}
</style></head><body>
<header><h1>XScript 云控</h1>
<label>目标 <select id="target"></select></label>
<label>小程序 <input id="project" placeholder="工程名" size="12"></label>
<label>参数 <input id="param" placeholder='{"name":"李四"}' size="16"></label>
<button class="primary" onclick="send({path:'app_run',id:v('project'),param:json(v('param'))})">启动</button>
<button onclick="send({path:'app_stop'})">停止</button>
<button onclick="send({path:'screen_shot',max:360,quality:30})">截图</button>
<button onclick="send({path:'device_action',action:'key',ori:'home'})">主页</button>
<button onclick="send({path:'device_action',action:'key',ori:'back'})">返回</button>
<label>消息 <input id="msg" placeholder="发给脚本" size="12"></label><button onclick="send({path:'message',data:v('msg')})">发送</button>
</header>
<main><table><thead><tr><th>设备</th><th>分组</th><th>状态</th><th>脚本数据</th><th>最近</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<div id="shots"></div><div id="log"></div></main>
<script>
const T=new URLSearchParams(location.search).get('token')||'';
const H={'Content-Type':'application/json','Authorization':'Bearer '+T};
const v=id=>document.getElementById(id).value.trim();
const json=s=>{try{return s?JSON.parse(s):{}}catch(e){alert('参数不是 JSON');throw e}};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,b){const r=await fetch(p,{method:b?'POST':'GET',headers:H,body:b?JSON.stringify(b):undefined});return r.json()}
async function send(cmd,target){
  const res=await api('/api/command',{target:target||v('target'),command:cmd});
  const shots=document.getElementById('shots');shots.innerHTML='';
  for(const [id,r] of Object.entries(res.results||{})){
    if(r.result&&r.result.image){shots.insertAdjacentHTML('beforeend',`<div><b>${esc(id)}</b><br><img class="shot" src="data:image/jpeg;base64,${r.result.image}"></div>`)}
  }
  document.getElementById('log').textContent=JSON.stringify(res.results,(k,x)=>k==='image'?'…':x,1);refresh();
}
async function setGroup(id){const g=prompt('分组（留空=用设备上报的分组）');if(g===null)return;await api('/api/devices/'+encodeURIComponent(id)+'/group',{group:g});refresh()}
async function refresh(){
  const d=await api('/api/devices');const sel=document.getElementById('target');const cur=sel.value;
  sel.innerHTML='<option value="all">全部设备</option>'+d.groups.map(g=>`<option value="group:${esc(g)}">分组 ${esc(g)}</option>`).join('')
    +d.devices.map(x=>`<option value="${esc(x.id)}">${esc(x.brand+' '+x.model)} · ${esc(x.id.slice(0,8))}</option>`).join('');
  if([...sel.options].some(o=>o.value===cur))sel.value=cur;
  document.getElementById('rows').innerHTML=d.devices.map(x=>`<tr><td>${esc(x.brand)} ${esc(x.model)}<br><code>${esc(x.id)}</code></td>
   <td>${esc(x.group)||'<span class=muted>-</span>'}</td><td>${x.running?'<span class=on>运行 '+esc(x.project)+'</span>':'<span class=muted>空闲</span>'}<br><span class=muted>${esc(x.channel)} · v${esc(x.version)}</span></td>
   <td><code>${esc(JSON.stringify(x.data))}</code></td><td class=muted>${new Date(x.seen*1000).toLocaleTimeString()}</td>
   <td><button data-act="group" data-id="${esc(x.id)}">分组</button> <button data-act="stop" data-id="${esc(x.id)}">停止</button></td></tr>`).join('')
   ||'<tr><td colspan=6 class=muted>还没有设备连接。设备端：云端控制 → ws://本机地址:端口/ws?token=…</td></tr>';
}
// Device ids come from devices; pass them through data- attributes, never into inline JS.
document.getElementById('rows').addEventListener('click',e=>{
  const b=e.target.closest('button[data-act]');if(!b)return;
  if(b.dataset.act==='group')setGroup(b.dataset.id);else send({path:'app_stop'},b.dataset.id);
});
refresh();setInterval(refresh,3000);
</script></body></html>"""


def main(argv=None):
    ap = argparse.ArgumentParser(description="XScript reference 云控 server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token", default=os.environ.get("XSCRIPT_CLOUD_TOKEN", ""),
                    help="shared secret for devices, dashboard and API (strongly recommended)")
    ap.add_argument("--state", default="xscript_cloud_state.json", help="groups and tasks are kept here")
    ap.add_argument("--licenses", help="card database from xscript_license.py cards")
    ap.add_argument("--key", help="license signing key (private.pem); needed with --licenses")
    a = ap.parse_args(argv)
    licenses = key = None
    if a.licenses:
        import xscript_license as lic

        if not a.key:
            ap.error("--licenses needs --key")
        licenses, key = lic.CardDB(a.licenses), lic.load_private(a.key)
    if not a.token:
        print("warning: no --token; anyone who can reach this port controls every connected device", file=sys.stderr)
    hub = Hub(a.token, a.state, licenses, key)
    web.run_app(make_app(hub), host=a.host, port=a.port)


if __name__ == "__main__":
    main()
