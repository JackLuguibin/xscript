"""debug.* RPCs / DebugSession against a scripted debugpy behind a fake /debug/* bridge (tests/fake_debug_device.py)."""
from __future__ import annotations

import asyncio

import pytest

from .conftest import FakeAdb
from .fake_debug_device import REMOTE_ROOT, FakeDebugDevice
from .test_context import make_ctx, rpc

DEV = "adb:dbg01"


@pytest.fixture()
def fdev():
    d = FakeDebugDevice()
    try:
        yield d
    finally:
        d.close()


@pytest.fixture()
async def ctx(fdev):
    c = make_ctx(FakeAdb([("dbg01", "device", fdev.port)]))
    c.debug_options = {"poll_interval": 0.02, "log_interval": 0.05, "connect_tries": 5, "request_timeout": 5}
    assert (await rpc(c, "device.connect", transport="adb", serial="dbg01"))["ok"]
    events: list = []
    c.dispatcher.set_event_sink(lambda t, d: events.append((t, d)))
    c.events = events  # type: ignore[attr-defined]
    try:
        yield c
    finally:
        await c.shutdown()


async def wait_state(c, state: str, line: int | None = None, timeout: float = 5.0) -> dict:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        for t, d in reversed(c.events):
            if t == "debug.state":
                if d["state"] == state and (line is None or d.get("line") == line):
                    return d
                break
        await asyncio.sleep(0.02)
    raise AssertionError("no %s state (line %s); last: %s" % (state, line, [d for t, d in c.events if t == "debug.state"][-1:]))


def outputs(c) -> str:
    return "".join(d["text"] for t, d in c.events if t == "debug.output")


async def test_breakpoint_stack_variables_step_continue(ctx, fdev):
    r = await rpc(ctx, "debug.start", id=DEV, project="dbg", breakpoints={"__init__.py": [3, 5], "lib/x.py": [1]})
    assert r["ok"], r
    # handshake order (dap.ts): initialize -> attach -> setBreakpoints -> setExceptionBreakpoints -> configurationDone
    cmds = [b["command"] for m, p, b in fdev.requests if p == "/debug/request"]
    assert cmds[:6] == ["initialize", "attach", "setBreakpoints", "setBreakpoints", "setExceptionBreakpoints", "configurationDone"]
    assert fdev.bps[REMOTE_ROOT + "/__init__.py"] == [3, 5] and fdev.bps[REMOTE_ROOT + "/lib/x.py"] == [1]
    st = await wait_state(ctx, "stopped", 3)
    assert st["path"] == "__init__.py" and st["reason"] == "breakpoint"
    assert st["frames"][1]["path"] is None and st["frames"][1]["file"] == "runpy.py"  # outside the project
    assert (await rpc(ctx, "debug.status", id=DEV))["result"]["state"] == "stopped"

    scopes = (await rpc(ctx, "debug.scopes", id=DEV, frameId=st["frames"][0]["id"]))["result"]["scopes"]
    assert [s["name"] for s in scopes] == ["Locals", "Globals"] and scopes[1]["expensive"]
    loc = (await rpc(ctx, "debug.variables", id=DEV, ref=scopes[0]["ref"]))["result"]["variables"]
    assert loc[0] == {"name": "total", "value": "30", "type": "int", "ref": 0} and loc[1]["ref"] == 11
    assert (await rpc(ctx, "debug.variables", id=DEV, ref=11))["result"]["variables"][0]["value"] == "1"
    assert (await rpc(ctx, "debug.variables", id=DEV, ref=0))["error"]["code"] == "rpc.bad_params"
    ev = await rpc(ctx, "debug.evaluate", id=DEV, expression="total", frameId=100)
    assert ev["result"]["result"] == "eval:total"
    assert (await rpc(ctx, "debug.evaluate", id=DEV, expression="boom"))["error"]["code"] == "debug.failed"

    assert (await rpc(ctx, "debug.step", id=DEV, command="next"))["ok"]
    await wait_state(ctx, "stopped", 4)
    assert (await rpc(ctx, "debug.step", id=DEV, command="continue"))["ok"]
    await wait_state(ctx, "stopped", 5)
    # the page re-sends a file's breakpoints when the user toggles one mid-session
    bps = (await rpc(ctx, "debug.setBreakpoints", id=DEV, path="__init__.py", lines=[6, 99]))["result"]["breakpoints"]
    assert bps == [{"line": 6, "verified": True, "message": ""}, {"line": 99, "verified": False, "message": ""}]
    await rpc(ctx, "debug.step", id=DEV, command="continue")
    await wait_state(ctx, "stopped", 6)
    await rpc(ctx, "debug.step", id=DEV, command="continue")
    end = await wait_state(ctx, "ended")
    assert end["reason"] == "脚本已结束"
    text = outputs(ctx)
    assert "line 1\n" in text and "line 6\n" in text and "old run" not in text  # logs from this run only
    assert "logpoint hit" in text and "dup of the script" not in text
    assert (await rpc(ctx, "debug.step", id=DEV, command="next"))["error"]["code"] == "debug.no_session"
    assert ("DELETE", "/debug", {}) in fdev.requests


async def test_stop_disconnects_then_stops_script(ctx, fdev):
    assert (await rpc(ctx, "debug.start", id=DEV, project="dbg", breakpoints={"__init__.py": [2]}))["ok"]
    await wait_state(ctx, "stopped", 2)
    assert (await rpc(ctx, "debug.start", id=DEV, project="dbg"))["error"]["code"] == "debug.already"
    assert (await rpc(ctx, "debug.stop", id=DEV))["result"]["stopped"]
    paths = [(m, p, b.get("command")) for m, p, b in fdev.requests]
    i_disc = paths.index(("POST", "/debug/request", "disconnect"))
    disc = [b for m, p, b in fdev.requests if b.get("command") == "disconnect"][0]
    assert disc["arguments"] == {"terminateDebuggee": False}
    assert paths.index(("DELETE", "/debug", None)) > i_disc and fdev.stopped_project
    assert (await wait_state(ctx, "ended"))["reason"] == "已停止"
    # a fresh session may start afterwards
    fdev.reset()
    assert (await rpc(ctx, "debug.start", id=DEV, project="dbg"))["ok"]
    assert (await rpc(ctx, "debug.stop", id=DEV, terminate=False))["ok"]
    assert not fdev.stopped_project
    assert (await rpc(ctx, "debug.stop", id="adb:nope"))["result"] == {"stopped": False}


async def test_busy_device_is_not_stopped(ctx, fdev):
    fdev.running = True  # somebody else's script
    r = await rpc(ctx, "debug.start", id=DEV, project="dbg")
    assert r["error"]["code"] == "debug.busy"
    assert not fdev.stopped_project and fdev.running
    assert (await wait_state(ctx, "ended"))["error"]


async def test_connect_and_initialize_failures(ctx, fdev):
    fdev.mode = "never_ready"
    r = await rpc(ctx, "debug.start", id=DEV, project="dbg")
    assert r["error"]["code"] == "debug.connect_failed"
    assert fdev.stopped_project  # we launched it, so we clean up


async def test_stack_failure_still_pauses(ctx, fdev):
    fdev.mode = "stack_fails"
    assert (await rpc(ctx, "debug.start", id=DEV, project="dbg", breakpoints={"__init__.py": [2]}))["ok"]
    st = await wait_state(ctx, "stopped")
    assert st["frames"] == [] and "stackTrace failed" in outputs(ctx)
    assert (await rpc(ctx, "debug.step", id=DEV, command="bogus"))["error"]["code"] == "rpc.bad_params"


async def test_param_validation(ctx):
    assert (await rpc(ctx, "debug.start", id=DEV, project="dbg", breakpoints={"../x.py": [1]}))["error"]["code"] == "rpc.bad_params"
    assert (await rpc(ctx, "debug.start", id=DEV, project="dbg", breakpoints={"a.py": [0]}))["error"]["code"] == "rpc.bad_params"
    assert (await rpc(ctx, "debug.start", id=DEV, project="dbg", breakpoints=[1]))["error"]["code"] == "rpc.bad_params"
    assert (await rpc(ctx, "debug.scopes", id=DEV, frameId=1))["error"]["code"] == "debug.no_session"
    assert (await rpc(ctx, "debug.status", id=DEV))["result"]["state"] == "idle"
