"""AsyncRuntime and Bridge units (no browser): threading contract, shutdown draining, bridge reply/event delivery, failure paths."""
from __future__ import annotations

import asyncio
import json
import threading

import pytest

from xscript_desktop.rpc import Dispatcher, RpcError, event_json, param
from xscript_desktop.runtime import AsyncRuntime


def test_runtime_runs_coroutines_on_its_own_thread_and_returns_values():
    rt = AsyncRuntime("t-runtime").start()
    try:
        async def where():
            return threading.current_thread().name

        assert rt.run(where(), timeout=2) == "t-runtime"
        assert rt.loop.is_running()
        box = []
        rt.call_soon(box.append, 1)
        rt.run(asyncio.sleep(0.01), timeout=2)
        assert box == [1]
    finally:
        rt.stop()


def test_runtime_propagates_exceptions_and_survives_them():
    rt = AsyncRuntime().start()
    try:
        async def boom():
            raise ValueError("x")

        with pytest.raises(ValueError):
            rt.run(boom(), timeout=2)
        assert rt.run(asyncio.sleep(0, "ok"), timeout=2) == "ok"
    finally:
        rt.stop()


def test_runtime_stop_cancels_pending_tasks_and_is_idempotent():
    rt = AsyncRuntime().start()
    started = threading.Event()
    cancelled = threading.Event()

    async def forever():
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    rt.submit(forever())
    assert started.wait(2)
    rt.stop()
    rt.stop()
    assert cancelled.is_set()
    assert not rt._thread.is_alive()


def test_runtime_run_times_out():
    rt = AsyncRuntime().start()
    try:
        with pytest.raises(Exception):
            rt.run(asyncio.sleep(5), timeout=0.1)
    finally:
        rt.stop()


async def test_rpc_param_edge_cases():
    assert param({"a": 1}, "a", int) == 1
    assert param({}, "a", int, default=7) == 7
    assert param({"a": None}, "a", str, default="d") == "d"
    with pytest.raises(RpcError):
        param({"a": True}, "a", int)  # bool is not an int here
    with pytest.raises(RpcError):
        param({"a": 1}, "a", str)
    with pytest.raises(RpcError) as e:
        param({}, "a", str, label="the thing")
    assert "the thing" in e.value.message


async def test_rpc_sync_and_async_handlers_and_non_ascii_roundtrip():
    d = Dispatcher()
    d.register("sync", lambda p: {"echo": p.get("s")})

    async def a(p):
        await asyncio.sleep(0)
        return [p.get("s")]

    d.register("async", a)
    r1 = json.loads(await d.handle(json.dumps({"id": "k", "method": "sync", "params": {"s": "中文✓"}})))
    r2 = json.loads(await d.handle(json.dumps({"id": 2, "method": "async", "params": {"s": "é"}})))
    assert r1 == {"id": "k", "ok": True, "result": {"echo": "中文✓"}} and r2["result"] == ["é"]
    assert d.methods == ["async", "sync"]


@pytest.mark.parametrize("raw,code", [
    ("not json", "rpc.parse"), ("[]", "rpc.invalid"), ("3", "rpc.invalid"), ('{"id":1}', "rpc.invalid"),
    ('{"id":1,"method":5}', "rpc.invalid"), ('{"id":1,"method":"x","params":[1]}', "rpc.invalid"), ('{"id":1,"method":"nope"}', "rpc.method_not_found"),
])
async def test_rpc_malformed_requests(raw, code):
    d = Dispatcher()
    out = json.loads(await d.handle(raw))
    assert out["ok"] is False and out["error"]["code"] == code and out["error"]["retryable"] is False


async def test_rpc_cancel_in_flight_request_yields_cancelled_and_unknown_cancel_is_silent():
    d = Dispatcher()
    started = asyncio.Event()

    async def slow(p):
        started.set()
        await asyncio.sleep(30)

    d.register("slow", slow)
    t = asyncio.ensure_future(d.handle(json.dumps({"id": 9, "method": "slow"})))
    await started.wait()
    assert await d.handle(json.dumps({"method": "cancel", "params": {"id": 9}})) is None
    assert json.loads(await t)["error"]["code"] == "rpc.cancelled"
    assert await d.handle(json.dumps({"method": "cancel", "params": {"id": 12345}})) is None


async def test_rpc_concurrent_requests_do_not_mix_up_ids():
    d = Dispatcher()

    async def echo(p):
        await asyncio.sleep(0.001 * (p["n"] % 5))
        return p["n"]

    d.register("echo", echo)
    outs = await asyncio.gather(*(d.handle(json.dumps({"id": i, "method": "echo", "params": {"n": i}})) for i in range(200)))
    assert [json.loads(o)["result"] for o in outs] == list(range(200))


def test_event_json_serialises_objects_with_to_dict_and_rejects_the_rest():
    class X:
        def to_dict(self):
            return {"a": 1}

    assert json.loads(event_json("t", X()))["data"] == {"a": 1}
    with pytest.raises(TypeError):
        event_json("t", object())


@pytest.mark.qt
def test_bridge_delivers_replies_and_events_on_the_gui_thread(qtbot):
    pytest.importorskip("PySide6.QtCore")
    from xscript_desktop.bridge import Bridge
    from xscript_desktop.context import AppContext

    rt = AsyncRuntime().start()
    try:
        ctx = AppContext(poll_interval=60)
        bridge = Bridge(ctx, rt)
        got: list[tuple[str, str]] = []
        bridge.message.connect(lambda m: got.append((threading.current_thread().name, m)))
        bridge.call(json.dumps({"id": 1, "method": "app.ping", "params": {"echo": "x"}}))
        qtbot.waitUntil(lambda: len(got) == 1, timeout=3000)
        assert json.loads(got[0][1])["result"]["pong"] == "x" and got[0][0] == threading.main_thread().name
        ctx.dispatcher.emit("device.state", {"id": "a"})
        qtbot.waitUntil(lambda: len(got) == 2, timeout=3000)
        assert json.loads(got[1][1]) == {"event": True, "topic": "device.state", "data": {"id": "a"}}
        # cancel produces no reply; garbage produces a parse error with id null
        bridge.call(json.dumps({"method": "cancel", "params": {"id": 1}}))
        bridge.call("garbage")
        qtbot.waitUntil(lambda: len(got) == 3, timeout=3000)
        assert json.loads(got[2][1])["error"]["code"] == "rpc.parse" and json.loads(got[2][1])["id"] is None
    finally:
        rt.stop()


@pytest.mark.qt
def test_bridge_reports_a_failed_dispatcher_future(qtbot):
    from xscript_desktop.bridge import RpcErrorResponse

    assert json.loads(RpcErrorResponse(RuntimeError("x")))["error"]["code"] == "rpc.internal"
