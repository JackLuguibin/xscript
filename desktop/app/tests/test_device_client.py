from __future__ import annotations

import httpx
import pytest

from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget, summarize_status


@pytest.mark.parametrize("text,host,port", [
    ("", "127.0.0.1", 9860),
    ("192.168.1.5", "192.168.1.5", 9860),
    ("192.168.1.5:9861", "192.168.1.5", 9861),
    ("http://10.0.0.2:9860/tools/", "10.0.0.2", 9860),
    (":19860", "127.0.0.1", 19860),
    ("[fe80::1]:9862", "fe80::1", 9862),
    ("[::1]", "::1", 9860),
    ("fe80::1", "fe80::1", 9860),
    ("phone.local", "phone.local", 9860),
    ("  localhost:9860  ", "localhost", 9860),
])
def test_parse_target(text, host, port):
    t = DeviceTarget.parse(text)
    assert (t.host, t.port) == (host, port)


@pytest.mark.parametrize("bad", ["host:0", "host:70000", "host:abc", "[::1", "host:-1"])
def test_parse_target_rejects(bad):
    with pytest.raises(ValueError):
        DeviceTarget.parse(bad)


def test_base_url_and_address_ipv6():
    t = DeviceTarget.parse("[fe80::1]:9862")
    assert t.base_url == "http://[fe80::1]:9862" and t.address == "[fe80::1]:9862"


def make(handler) -> DeviceClient:
    return DeviceClient(DeviceTarget("127.0.0.1", 9860), transport=httpx.MockTransport(handler))


async def test_status_sends_client_header():
    seen = {}

    def h(req: httpx.Request):
        seen["h"] = req.headers.get("x-xscript-client")
        return httpx.Response(200, json={"name": "x", "model": "m"})

    c = make(h)
    assert (await c.status())["name"] == "x"
    assert seen["h"] == "desktop"
    await c.aclose()


async def test_http_error_carries_device_detail():
    c = make(lambda r: httpx.Response(409, json={"error": "已有脚本在运行"}))
    with pytest.raises(DeviceError) as e:
        await c.status()
    assert e.value.status == 409 and e.value.detail == "已有脚本在运行" and not e.value.retryable
    await c.aclose()


async def test_429_is_retryable_and_run_409_is_returned():
    c = make(lambda r: httpx.Response(429, json={"error": "观看者已满"}))
    with pytest.raises(DeviceError) as e:
        await c.screen()
    assert e.value.retryable
    await c.aclose()
    c = make(lambda r: httpx.Response(409, json={"error": "busy"}))
    assert (await c.run_project("p"))["error"] == "busy"
    await c.aclose()


async def test_connect_error_is_mapped():
    def h(req):
        raise httpx.ConnectError("refused")

    c = make(h)
    with pytest.raises(DeviceError) as e:
        await c.status()
    assert e.value.kind == "connect" and e.value.retryable
    await c.aclose()


async def test_non_json_and_wrong_shape():
    c = make(lambda r: httpx.Response(200, text="<html>"))
    with pytest.raises(DeviceError) as e:
        await c.status()
    assert e.value.kind == "protocol"
    await c.aclose()
    c = make(lambda r: httpx.Response(200, json=[1]))
    with pytest.raises(DeviceError):
        await c.status()
    await c.aclose()


async def test_project_names_are_url_quoted():
    seen = []
    c = make(lambda r: (seen.append(r.url.raw_path.decode()), httpx.Response(200, json={}))[1])
    await c.stop_project("a b/c")
    assert seen == ["/projects/a%20b%2Fc/stop"]
    await c.aclose()


def test_summarize_status_real_shape():
    s = summarize_status({"name": "emu", "model": "sdk", "sdk": 37, "release": "17", "width": 1080, "height": 2337, "version": "0.2.6",
                          "device_id": "abc", "running": False, "accessibility": False, "app_id": "com.xscript.app"})
    assert s["android"] == "17" and s["deviceId"] == "abc" and s["running"] is False and s["width"] == 1080
