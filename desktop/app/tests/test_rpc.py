from __future__ import annotations

import asyncio
import json

import pytest

from xscript_desktop.rpc import Dispatcher, RpcError, event_json, param


def make() -> Dispatcher:
    d = Dispatcher()

    @d.method("echo")
    def echo(p):
        return {"echo": p.get("x")}

    @d.method("slow")
    async def slow(p):
        await asyncio.sleep(10)

    @d.method("boom")
    def boom(p):
        raise RpcError("test.boom", "kaboom", retryable=True, details={"a": 1})

    @d.method("crash")
    def crash(p):
        raise RuntimeError("oops")

    return d


async def call(d: Dispatcher, **req) -> dict:
    out = await d.handle(json.dumps(req))
    return json.loads(out)


async def test_ok_and_unicode():
    r = await call(make(), id=1, method="echo", params={"x": "签到"})
    assert r == {"id": 1, "ok": True, "result": {"echo": "签到"}}


async def test_missing_params_defaults_to_empty():
    r = await call(make(), id="a", method="echo")
    assert r["result"] == {"echo": None}


async def test_structured_error():
    r = await call(make(), id=2, method="boom")
    assert r["ok"] is False
    assert r["error"] == {"code": "test.boom", "message": "kaboom", "retryable": True, "details": {"a": 1}}


async def test_unexpected_exception_is_internal_error_without_traceback():
    r = await call(make(), id=3, method="crash")
    assert r["error"]["code"] == "rpc.internal"
    assert "Traceback" not in r["error"]["message"]


async def test_unknown_method_and_bad_requests():
    d = make()
    assert (await call(d, id=1, method="nope"))["error"]["code"] == "rpc.method_not_found"
    assert json.loads(await d.handle("not json"))["error"]["code"] == "rpc.parse"
    assert json.loads(await d.handle("[1]"))["error"]["code"] == "rpc.invalid"
    assert (await call(d, id=1, method="echo", params=[1]))["error"]["code"] == "rpc.invalid"
    assert (await call(d, id=1, method=5))["error"]["code"] == "rpc.invalid"


async def test_oversized_request_rejected():
    d = make()
    big = json.dumps({"id": 1, "method": "echo", "params": {"x": "a" * (5 * 1024 * 1024)}})
    assert json.loads(await d.handle(big))["error"]["code"] == "rpc.too_large"


async def test_cancel():
    d = make()
    t = asyncio.ensure_future(d.handle(json.dumps({"id": 7, "method": "slow"})))
    await asyncio.sleep(0.05)
    assert await d.handle(json.dumps({"method": "cancel", "params": {"id": 7}})) is None
    r = json.loads(await asyncio.wait_for(t, 2))
    assert r["id"] == 7 and r["error"]["code"] == "rpc.cancelled"


def test_duplicate_registration_rejected():
    d = make()
    with pytest.raises(ValueError):
        d.register("echo", lambda p: None)


def test_events_reach_sink_and_sink_errors_do_not_propagate():
    d = Dispatcher()
    seen = []
    d.set_event_sink(lambda t, data: seen.append((t, data)))
    d.emit("device.state", {"id": "x"})
    assert seen == [("device.state", {"id": "x"})]
    d.set_event_sink(lambda t, data: 1 / 0)
    d.emit("device.state", {})  # must not raise
    assert json.loads(event_json("t", {"a": 1})) == {"event": True, "topic": "t", "data": {"a": 1}}


def test_param_validation():
    assert param({"a": 1}, "a", int) == 1
    assert param({}, "a", int, default=5) == 5
    for bad in ({}, {"a": "x"}, {"a": True}):
        with pytest.raises(RpcError):
            param(bad, "a", int)
