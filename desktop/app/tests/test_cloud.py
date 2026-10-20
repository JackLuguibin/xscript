"""Cloud control (P4): backend connection, token handling and the cloud.* RPCs, against tests/fake_backend.py."""
from __future__ import annotations

import json

import httpx
import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services.backend_client import BackendClient, BackendError

from .fake_backend import ORIGIN, FakeBackend


@pytest.fixture
def fb() -> FakeBackend:
    return FakeBackend()


@pytest.fixture
def ctx(fb: FakeBackend, tmp_path) -> AppContext:
    c = AppContext(poll_interval=60, data_dir=tmp_path)
    c.cloud.transport = fb.transport()
    return c


async def rpc(ctx: AppContext, method: str, **params):
    raw = await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params}))
    return json.loads(raw), raw


async def test_not_configured_until_connected(ctx):
    r, _ = await rpc(ctx, "cloud.status")
    assert r["result"] == {"state": "not_configured", "origin": ""}


async def test_connect_checks_the_token_and_keeps_it_only_in_the_keyring(ctx, fb, tmp_path):
    r, raw = await rpc(ctx, "cloud.connect", origin="HTTPS://Cloud.Example.Test/", token=" xsk_op ")
    assert r["ok"], r
    assert r["result"] == {"state": "connected", "origin": ORIGIN,
                           "account": {"username": "olga", "role": "operator", "canOperate": True, "isAdmin": False}}
    assert "xsk_op" not in raw
    assert ctx.secrets.backend.get("xscript", "backend:" + ORIGIN) == "xsk_op"
    assert await ctx.store.aexec(ctx.store._get_setting, "backendOrigin") == ORIGIN
    s, raw = await rpc(ctx, "cloud.status")
    assert s["result"]["state"] == "connected" and s["result"]["account"]["role"] == "operator" and "xsk_op" not in raw
    assert fb.calls[-1][:2] == ("GET", "/api/auth/me")
    ctx.store.close()
    blob = b"".join(p.read_bytes() for p in tmp_path.rglob("*") if p.is_file())
    assert b"xsk_op" not in blob  # not in SQLite, not in the slot index


@pytest.mark.parametrize("token,code", [("xsk_wrong", "backend.unauthorized"), ("", "backend.bad_token"),
                                        ("two words", "backend.bad_token"), ("xsk_reseller", "backend.forbidden")])
async def test_rejected_tokens_store_nothing(ctx, token, code):
    r, raw = await rpc(ctx, "cloud.connect", origin=ORIGIN, token=token)
    assert not r["ok"] and r["error"]["code"] == code, r
    assert "xsk_wrong" not in raw  # the fake backend echoes the token in its 401 detail
    assert ctx.secrets.list_slots()["slots"] == []
    assert (await rpc(ctx, "cloud.status"))[0]["result"]["state"] == "not_configured"


@pytest.mark.parametrize("origin", ["http://10.0.0.8:8000", "https://x.test/api", "ftp://x.test", "https://u:p@x.test"])
async def test_origin_must_be_https_or_local_http(ctx, origin):
    r, _ = await rpc(ctx, "cloud.connect", origin=origin, token="xsk_admin")
    assert r["error"]["code"] == "backend.bad_origin"


async def test_local_http_backend_is_allowed(ctx, fb):
    r, _ = await rpc(ctx, "cloud.connect", origin="http://127.0.0.1:8000", token="xsk_view")
    assert r["result"]["origin"] == "http://127.0.0.1:8000" and r["result"]["account"]["canOperate"] is False


async def test_expired_and_unreachable_states(ctx, fb):
    await rpc(ctx, "cloud.connect", origin=ORIGIN, token="xsk_admin")
    del fb.tokens["xsk_admin"]  # revoked in the console / expired
    s = (await rpc(ctx, "cloud.status"))[0]["result"]
    assert s["state"] == "expired" and s["code"] == "backend.unauthorized" and "xsk_admin" not in s["message"]
    fb.tokens["xsk_admin"] = ("alice", "admin")
    fb.down = True
    s = (await rpc(ctx, "cloud.status"))[0]["result"]
    assert s["state"] == "unreachable" and s["origin"] == ORIGIN


async def test_switching_backend_forgets_the_old_token_and_disconnect_forgets_everything(ctx):
    await rpc(ctx, "cloud.connect", origin=ORIGIN, token="xsk_admin")
    await rpc(ctx, "cloud.connect", origin="http://localhost:8000", token="xsk_view")
    assert ctx.secrets.list_slots()["slots"] == [{"kind": "backend", "name": "http://localhost:8000"}]
    r, _ = await rpc(ctx, "cloud.disconnect")
    assert r["result"]["state"] == "not_configured"
    assert ctx.secrets.list_slots()["slots"] == []
    assert (await rpc(ctx, "cloud.status"))[0]["result"]["state"] == "not_configured"


async def test_client_maps_http_failures_without_leaking_the_token(fb):
    fb.route("GET", r"/boom", "viewer", lambda req, u, m: (500, {"detail": "kaputt xsk_admin"}))
    fb.route("GET", r"/admin-only", "admin", lambda req, u, m: {})
    c = BackendClient(ORIGIN, "xsk_view", fb.transport())
    with pytest.raises(BackendError) as e:
        await c.get("/admin-only")
    assert e.value.code == "backend.forbidden" and e.value.status == 403
    with pytest.raises(BackendError) as e:
        await c.get("/nope")
    assert e.value.code == "backend.not_found"
    c2 = BackendClient(ORIGIN, "xsk_admin", fb.transport())
    with pytest.raises(BackendError) as e:
        await c2.get("/boom")
    assert e.value.code == "backend.http" and e.value.retryable and "xsk_admin" not in e.value.message
    html = BackendClient(ORIGIN, "xsk_admin", httpx.MockTransport(lambda r: httpx.Response(200, text="<html>")))
    with pytest.raises(BackendError) as e:
        await html.get("/auth/me")
    assert e.value.code == "backend.bad_response"
    slow = BackendClient(ORIGIN, "xsk_admin", httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("t", request=r))))
    with pytest.raises(BackendError) as e:
        await slow.get("/auth/me")
    assert e.value.code == "backend.timeout" and e.value.retryable
    for x in (c, c2, html, slow):
        await x.aclose()


# ---- P4.2 device fleet --------------------------------------------------------------------------------------------

async def connected(ctx, token="xsk_view"):
    r, _ = await rpc(ctx, "cloud.connect", origin=ORIGIN, token=token)
    assert r["ok"], r


async def test_devices_need_a_connection(ctx):
    r, _ = await rpc(ctx, "cloud.devices")
    assert r["error"]["code"] == "backend.not_configured"


async def test_device_list_filters_and_drops_bulky_fields(ctx, fb):
    await connected(ctx)
    r, raw = await rpc(ctx, "cloud.devices")
    res = r["result"]
    assert res["total"] == 3 and res["page"] == 1 and res["pageSize"] == 50
    a1 = res["items"][0]
    assert a1["id"] == "dev-a1" and a1["online"] and a1["running"] and a1["group"] == "farm-1" and a1["note"] == "rack A"
    assert "data" not in a1 and "remote" not in a1 and "10.0.0.5" not in raw
    r, _ = await rpc(ctx, "cloud.devices", q="mi", online=True, group="farm-1", app="com.xscript.app", pageSize=25)
    assert [d["id"] for d in r["result"]["items"]] == ["dev-b2"]
    path, _ = fb.calls[-1][1], None
    assert path == "/api/devices"
    r, _ = await rpc(ctx, "cloud.devices", online=False)
    assert [d["id"] for d in r["result"]["items"]] == ["dev-c3"]


async def test_device_list_rejects_bad_params_and_odd_page_size(ctx):
    await connected(ctx)
    r, _ = await rpc(ctx, "cloud.devices", online="yes")
    assert r["error"]["code"] == "rpc.bad_params"
    r, _ = await rpc(ctx, "cloud.devices", pageSize=10_000)
    assert r["result"]["pageSize"] == 50


async def test_groups_and_apps(ctx):
    await connected(ctx)
    r, _ = await rpc(ctx, "cloud.groups")
    assert r["result"] == {"groups": [{"name": "farm-1", "total": 2, "online": 2}, {"name": "farm-2", "total": 1, "online": 0}],
                           "apps": ["com.other.app", "com.xscript.app"]}


async def test_device_list_maps_a_revoked_token(ctx, fb):
    await connected(ctx)
    del fb.tokens["xsk_view"]
    r, raw = await rpc(ctx, "cloud.devices")
    assert r["error"]["code"] == "backend.unauthorized" and "xsk_view" not in raw


# ---- P4.3 batch commands ------------------------------------------------------------------------------------------

async def test_batch_run_summarizes_per_device_and_marks_offline(ctx, fb):
    await connected(ctx, "xsk_op")
    r, _ = await rpc(ctx, "cloud.command", ids=["dev-c3", "dev-a1", "dev-b2", "dev-a1"], action="run", project="daily", param={"n": 2})
    assert r["result"] == {"ok": 2, "total": 3, "rows": [
        {"id": "dev-c3", "ok": False, "offline": True, "msg": "离线，未下发"},
        {"id": "dev-a1", "ok": True, "offline": False, "msg": "ok"},
        {"id": "dev-b2", "ok": True, "offline": False, "msg": "ok"}]}
    assert fb.calls[-1] == ("POST", "/api/command", {"target": "dev-c3,dev-a1,dev-b2", "timeout": 20,
                                                      "command": {"path": "app_run", "id": "daily", "param": {"n": 2}}})


async def test_batch_stop_and_device_side_failure(ctx, fb):
    await connected(ctx, "xsk_admin")
    r, _ = await rpc(ctx, "cloud.command", ids=["dev-a1"], action="stop")
    assert r["result"]["ok"] == 1 and fb.calls[-1][2]["command"] == {"path": "app_stop"}
    r, _ = await rpc(ctx, "cloud.command", ids=["dev-a1"], action="run", project="missing")
    assert r["result"]["rows"][0] == {"id": "dev-a1", "ok": False, "offline": False, "msg": "工程不存在"}


async def test_viewer_is_refused_by_the_backend(ctx):
    await connected(ctx, "xsk_view")
    r, _ = await rpc(ctx, "cloud.command", ids=["dev-a1"], action="stop")
    assert r["error"]["code"] == "backend.forbidden"


@pytest.mark.parametrize("ids,action,project", [([], "stop", ""), (["all,dev-a1"], "stop", ""), (["group:farm-1"], "stop", ""),
                                                (["dev-a1"], "run", ""), (["dev-a1"], "run", "../x"), (["dev-a1"], "wipe", ""),
                                                (["d%d" % i for i in range(501)], "stop", "")])
async def test_batch_rejects_bad_requests_before_calling_the_backend(ctx, fb, ids, action, project):
    await connected(ctx, "xsk_admin")
    n = len(fb.calls)
    r, _ = await rpc(ctx, "cloud.command", ids=ids, action=action, project=project)
    assert r["error"]["code"] == "backend.bad_request" and len(fb.calls) == n
