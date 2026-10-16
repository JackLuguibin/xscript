"""DeviceClient over httpx.MockTransport: every error class the UI must distinguish (timeout, connect, 4xx/5xx, bad JSON, wrong shape)."""
from __future__ import annotations

import json

import httpx
import pytest

from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget, is_xscript_status, summarize_status


def client(handler) -> DeviceClient:
    return DeviceClient(DeviceTarget("127.0.0.1", 9860), transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("text,host,port", [
    ("", "127.0.0.1", 9860), ("192.168.1.20", "192.168.1.20", 9860), ("192.168.1.20:19860", "192.168.1.20", 19860),
    ("http://phone.local:9861/status", "phone.local", 9861), (":9862", "127.0.0.1", 9862), ("[::1]:9860", "::1", 9860),
    ("[fe80::1]", "fe80::1", 9860), ("fe80::1", "fe80::1", 9860), ("  localhost:9860  ", "localhost", 9860),
])
def test_parse_target_table(text, host, port):
    t = DeviceTarget.parse(text)
    assert (t.host, t.port) == (host, port)


@pytest.mark.parametrize("text", ["host:abc", "host:0", "host:65536", "host:-1", "[::1", "host:12 3"])
def test_parse_target_rejects_bad_ports_and_brackets(text):
    with pytest.raises(ValueError):
        DeviceTarget.parse(text)


@pytest.mark.parametrize("kw,retry", [
    (dict(kind="connect"), True), (dict(kind="timeout"), True), (dict(kind="protocol"), False), (dict(status=429), True),
    (dict(status=502), True), (dict(status=503), True), (dict(status=504), True), (dict(status=500), False), (dict(status=404), False),
])
def test_retryable_matrix(kw, retry):
    assert DeviceError("x", **kw).retryable is retry


async def test_timeout_maps_to_kind_timeout():
    def h(req):
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(DeviceError) as e:
        await client(h).status()
    assert e.value.kind == "timeout" and e.value.retryable


async def test_connect_error_maps_to_kind_connect():
    def h(req):
        raise httpx.ConnectError("refused", request=req)

    with pytest.raises(DeviceError) as e:
        await client(h).status()
    assert e.value.kind == "connect" and "127.0.0.1:9860" in str(e.value)


async def test_remote_protocol_error_is_a_connect_failure():
    def h(req):
        raise httpx.RemoteProtocolError("server closed", request=req)

    with pytest.raises(DeviceError) as e:
        await client(h).status()
    assert e.value.kind == "connect"


@pytest.mark.parametrize("body,ctype", [(b"<html>oops</html>", "text/html"), (b"{not json", "application/json"), (b"", "application/json")])
async def test_status_non_json_is_protocol_error(body, ctype):
    with pytest.raises(DeviceError) as e:
        await client(lambda r: httpx.Response(200, content=body, headers={"content-type": ctype})).status()
    assert e.value.kind == "protocol"


@pytest.mark.parametrize("payload", [[], "ok", 3, None])
async def test_status_non_object_is_protocol_error(payload):
    with pytest.raises(DeviceError) as e:
        await client(lambda r: httpx.Response(200, json=payload)).status()
    assert e.value.kind == "protocol"


async def test_http_error_detail_from_json_and_from_text():
    with pytest.raises(DeviceError) as e:
        await client(lambda r: httpx.Response(503, json={"error": "capture_unavailable"})).screen()
    assert e.value.status == 503 and e.value.detail == "capture_unavailable" and e.value.retryable
    with pytest.raises(DeviceError) as e:
        await client(lambda r: httpx.Response(500, text="boom" * 100)).status()
    assert e.value.status == 500 and len(e.value.detail) <= 200 and not e.value.retryable


async def test_screen_passes_params_and_returns_mime():
    seen = {}

    def h(req):
        seen["q"] = dict(req.url.params)
        return httpx.Response(200, content=b"JPEGDATA", headers={"content-type": "image/jpeg"})

    body, mime = await client(h).screen("jpg", 70, 360)
    assert body == b"JPEGDATA" and mime == "image/jpeg" and seen["q"] == {"format": "jpg", "quality": "70", "max": "360"}


async def test_projects_shapes():
    assert await client(lambda r: httpx.Response(200, json={"projects": ["a", "b"]})).projects() == [{"name": "a"}, {"name": "b"}]
    assert await client(lambda r: httpx.Response(200, json={"projects": ["a"], "details": [{"name": "a", "size": 3}]})).projects() == [{"name": "a", "size": 3}]
    assert await client(lambda r: httpx.Response(200, json=["x"])).projects() == []


async def test_logs_since_and_simple_verbs():
    calls = []

    def h(req):
        calls.append((req.method, req.url.raw_path.decode().split('?')[0], dict(req.url.params), req.headers.get("content-type")))
        return httpx.Response(200, json={"ok": True, "lines": []})

    c = client(h)
    await c.logs(5)
    await c.stop_project("my proj")
    await c.delete_project("a/b")
    await c.upload_zip("p", b"PK\x03\x04", replace=False)
    await c.action({"type": "tap", "x": 1, "y": 2})
    assert calls[0] == ("GET", "/logs", {"since": "5"}, None)
    assert calls[1][:2] == ("POST", "/projects/my%20proj/stop")
    assert calls[2][:2] == ("DELETE", "/projects/a%2Fb")  # a slash in a project name can never add a path segment
    assert calls[3][0] == "PUT" and calls[3][2] == {"replace": "false"} and calls[3][3] == "application/zip"
    assert calls[4][:2] == ("POST", "/action")


async def test_eval_timeout_408_is_a_result_not_an_exception():
    r = await client(lambda r: httpx.Response(408, json={"error": "timeout"})).eval_python("while True: pass", 100)
    assert r == {"ok": False, "error": "timeout"}


async def test_eval_sends_code_and_timeout():
    seen = {}

    def h(req):
        seen.update(json.loads(req.content))
        return httpx.Response(200, json={"ok": True, "result": "2"})

    assert (await client(h).eval_python("1+1", 1234))["ok"] is True
    assert seen == {"code": "1+1", "timeout_ms": 1234}


def test_client_never_uses_system_proxy():
    c = DeviceClient(DeviceTarget())
    assert c._http._trust_env is False


@pytest.mark.parametrize("st,ok", [({"device_id": "x"}, True), ({"app_id": "a"}, True), ({"model": "m"}, True), ({}, False), ({"hello": 1}, False), ([], False), (None, False)])
def test_is_xscript_status(st, ok):
    assert is_xscript_status(st) is ok


def test_summarize_status_defaults_for_a_sparse_device():
    s = summarize_status({"model": "X"})
    assert s["name"] == "X" and s["running"] is False and s["project"] == "" and s["sdk"] is None and s["capture"] is False
