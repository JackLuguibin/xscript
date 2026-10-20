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
