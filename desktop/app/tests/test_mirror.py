"""MirrorProxy (design §14.4): one MJPEG upstream, no stream without capture, 429 fallback, stall, reconnect, fan-out.

The streaming cases talk to a tiny asyncio server. One case uses httpx.MockTransport, as the design asks for both.
"""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from urllib.parse import parse_qs

import httpx
import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget
from xscript_desktop.services.mirror import (
    BOUNDARY, MirrorProxy, MirrorTimings, MjpegParser, _viewer_ok, backoff_delay, clamp_stream_params,
)

JPEG = b"\xff\xd8\xff\xd9"
FAST = MirrorTimings(0.3, 0.3, (0.05, 0.05, 0.05, 0.05, 0.05), 0.05, 0.05, 0.05)


def part(body: bytes, w: int, h: int) -> bytes:
    head = ("--xscriptframe\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\nX-Screen-Size: %dx%d\r\n\r\n" % (len(body), w, h)).encode()
    return head + body + b"\r\n"


def test_parser_reads_screen_size_across_chunks_and_ignores_a_boundary_inside_the_jpeg():
    """Content-Length, not a byte scan, splits parts — a JPEG may contain the boundary text."""
    jpeg = b"\xff\xd8" + BOUNDARY + b"\xff\xd9"
    raw = part(jpeg, 1080, 2400) + part(b"\xff\xd8\xff\xd9", 11, 22)
    parser = MjpegParser()
    out = []
    for i in range(0, len(raw), 7):
        out += parser.feed(raw[i:i + 7])
    assert [(p.w, p.h, p.body) for p in out] == [(1080, 2400, jpeg), (11, 22, b"\xff\xd8\xff\xd9")]
    assert parser.feed(b"") == []


def test_parser_skips_a_part_without_content_length_and_reads_the_next():
    blob = b"--xscriptframe\r\nX-Nope: 1\r\n\r\nGARBAGE" + part(b"\xff\xd8\xff\xd9", 8, 9)
    frames = MjpegParser().feed(blob)
    assert len(frames) == 1 and frames[0].w == 8 and frames[0].h == 9


def test_backoff_and_clamp_follow_the_slot_rules():
    """0.5/1 s steps wait out the 1.5 s slot release; fps/scale/quality clamp like the device."""
    timings = MirrorTimings()
    assert [backoff_delay(timings, i) for i in range(7)] == [1.5, 1.5, 2.0, 4.0, 8.0, 8.0, 8.0]
    assert clamp_stream_params(None, None, None) == (12, 0.5, 60)
    assert clamp_stream_params(99, 5, 1) == (15, 1.0, 10)
    assert clamp_stream_params(0, 0.1, 200) == (1, 0.2, 95)
    with pytest.raises(ValueError):
        clamp_stream_params(True, 0.5, 60)
    with pytest.raises(ValueError):
        _viewer_ok("a/b")


def test_frame_url_rejects_a_path_escape():
    pytest.importorskip("PySide6.QtWebEngineWidgets")
    from xscript_desktop.scheme import frame_device_id

    assert frame_device_id("/_frame/adb%3Aemulator-5554") == "adb:emulator-5554"
    assert frame_device_id("/_frame/adb%3Aemulator-5554.jpg") == "adb:emulator-5554"
    assert frame_device_id("/_frame/..") is None
    assert frame_device_id("/_frame/a%2F..%2Fb") is None
    assert frame_device_id("/_frame/a%00b") is None
    assert frame_device_id("/_shot/x") is None


def _chunk(payload: bytes) -> bytes:
    return b"%x\r\n" % len(payload) + payload + b"\r\n"


async def _send(writer: asyncio.StreamWriter, code: int, ctype: str, body: bytes) -> None:
    reason = {200: "OK", 404: "Not Found", 429: "Too Many Requests"}.get(code, "OK")
    head = ("HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (code, reason, ctype, len(body))).encode()
    writer.write(head + body)
    await writer.drain()


class StreamBox:
    """One loopback device: /status, /screen, and a chunked /screen/stream whose mode the test flips."""

    def __init__(self) -> None:
        self.capture = True
        self.mode = "frames"  # frames | hang | drop | deny | deny_once
        self.live = 0
        self.peak = 0
        self.stream_attempts = 0
        self.stream_times: list[float] = []
        self.screens = 0
        self.screen_qs: list[str] = []
        self.queries: list[str] = []
        self.hits: list[str] = []
        self.width = 1080
        self.height = 2400
        self.port = 0

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2)
        except Exception:
            writer.close()
            return
        try:
            target = data.split(b"\r\n", 1)[0].decode("latin1").split(" ")[1]
        except IndexError:
            writer.close()
            return
        path, _, query = target.partition("?")
        self.hits.append(path)
        try:
            if path == "/status":
                body = json.dumps({"capture": self.capture, "device_id": "d", "model": "m", "width": self.width, "height": self.height}).encode()
                await _send(writer, 200, "application/json", body)
            elif path == "/screen":
                self.screens += 1
                self.screen_qs.append(query)
                await _send(writer, 200, "image/jpeg", JPEG)
            elif path == "/screen/stream":
                self.queries.append(query)
                await self._stream(reader, writer)
            else:
                await _send(writer, 404, "application/json", b"{}")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _stream(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.stream_attempts += 1
        self.stream_times.append(time.monotonic())
        if self.mode == "deny" or (self.mode == "deny_once" and self.stream_attempts == 1):
            await _send(writer, 429, "application/json", b'{"error":"too many screen streams (max 2)"}')
            return
        self.live += 1
        self.peak = max(self.peak, self.live)
        try:
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=xscriptframe\r\n"
                         b"Cache-Control: no-cache, no-store\r\nTransfer-Encoding: chunked\r\n\r\n")
            await writer.drain()
            if self.mode == "hang":
                while await reader.read(1024):
                    pass
                return

            async def pump() -> None:
                try:
                    while True:
                        writer.write(_chunk(part(JPEG, self.width, self.height)))
                        await writer.drain()
                        if self.mode == "drop":
                            writer.write(b"0\r\n\r\n")
                            await writer.drain()
                            return
                        await asyncio.sleep(0.02)
                except (ConnectionResetError, BrokenPipeError, RuntimeError, OSError):
                    return

            async def watch() -> None:
                while await reader.read(1024):
                    pass

            tasks = {asyncio.create_task(pump()), asyncio.create_task(watch())}
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in pending:
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
            for task in done:
                try:
                    task.result()
                except Exception:
                    pass
        finally:
            self.live -= 1


@asynccontextmanager
async def serving(**kw):
    box = StreamBox()
    for k, v in kw.items():
        setattr(box, k, v)
    server = await asyncio.start_server(box.handle, "127.0.0.1", 0)
    box.port = server.sockets[0].getsockname()[1]
    try:
        yield box
    finally:
        server.close()
        await server.wait_closed()


def _proxy(box: StreamBox, timings: MirrorTimings = FAST):
    client = DeviceClient(DeviceTarget("127.0.0.1", box.port), timeout=2)
    events: list = []
    proxy = MirrorProxy(lambda _id: client, lambda topic, data: events.append((topic, data)), timings=timings)
    return proxy, client, events


async def _until(pred, timeout: float = 3.0, detail: str = ""):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(detail or "timed out")


async def test_no_capture_never_opens_a_stream_until_it_flips():
    """Preflight: capture=false must not touch /screen/stream (that leak never releases the slot)."""
    async with serving(capture=False) as box:
        proxy, client, events = _proxy(box)
        try:
            await proxy.subscribe("dev", "main")
            await _until(lambda: any(d.get("state") == "blocked" for t, d in events if t == "mirror.state"))
            await asyncio.sleep(0.2)
            assert box.stream_attempts == 0 and "/screen/stream" not in box.hits
            box.capture = True
            await _until(lambda: box.stream_attempts >= 1 and box.live == 1)
        finally:
            await proxy.shutdown()
            await client.aclose()


async def test_429_polls_screenshots_then_rejoins_the_stream():
    """429 -> GET /screen?max=480&quality=40, then the stream, not sooner than the reopen gap."""
    async with serving(mode="deny_once") as box:
        proxy, client, events = _proxy(box)
        try:
            await proxy.subscribe("dev", "main")
            await _until(lambda: any(d.get("state") == "streaming" for t, d in events if t == "mirror.state"))
            assert any(d.get("reason") == "viewers_full" for t, d in events if t == "mirror.state")
            assert box.screens >= 1 and box.stream_attempts >= 2
            qs = parse_qs(box.screen_qs[0])
            assert qs.get("format") == ["jpg"] and qs.get("max") == ["480"] and qs.get("quality") == ["40"]
            assert any(t == "mirror.frame" and d["w"] == 1080 for t, d in events)
        finally:
            await proxy.shutdown()
            await client.aclose()


async def test_retry_after_429_waits_out_the_slot_release_gap():
    timings = MirrorTimings(0.2, 0.2, (0.01,), 0.35, 0.05, 0.05)
    async with serving(mode="deny") as box:
        proxy, client, _events = _proxy(box, timings)
        try:
            await proxy.subscribe("dev", "main")
            await _until(lambda: len(box.stream_times) >= 2)
            assert box.stream_times[1] - box.stream_times[0] >= 0.3
            assert box.screens >= 1
        finally:
            await proxy.shutdown()
            await client.aclose()


async def test_no_frames_within_the_watchdog_stalls_without_retrying():
    """A 200 with no bytes is the slot leak. Close it, and do not open another until retry."""
    async with serving(mode="hang") as box:
        proxy, client, events = _proxy(box)
        try:
            await proxy.subscribe("dev", "main")
            await _until(lambda: any(d.get("state") == "stalled" and d.get("reason") == "no_frames" for t, d in events if t == "mirror.state"))
            await _until(lambda: box.live == 0)
            await asyncio.sleep(0.45)
            assert box.stream_attempts == 1
            box.mode = "frames"
            await proxy.retry("dev")
            await _until(lambda: any(t == "mirror.frame" for t, _d in events))
            assert box.stream_attempts >= 2
        finally:
            await proxy.shutdown()
            await client.aclose()


async def test_a_dropped_stream_reconnects():
    async with serving(mode="drop") as box:
        proxy, client, events = _proxy(box)
        try:
            await proxy.subscribe("dev", "main")
            await _until(lambda: box.stream_attempts >= 2 and any(t == "mirror.frame" for t, _d in events))
        finally:
            await proxy.shutdown()
            await client.aclose()
            await _until(lambda: box.live == 0)


async def test_one_upstream_fans_out_and_the_last_viewer_closes_it():
    async with serving() as box:
        proxy, client, events = _proxy(box)
        try:
            await proxy.subscribe("dev", "main")
            await _until(lambda: box.live == 1 and any(t == "mirror.frame" for t, _d in events))
            await proxy.subscribe("dev", "wall")
            await asyncio.sleep(0.1)
            assert box.peak == 1 and box.live == 1 and box.stream_attempts == 1
            assert "fps=12" in box.queries[0] and "scale=0.5" in box.queries[0] and "quality=60" in box.queries[0]
            await proxy.unsubscribe("dev", "main")
            assert box.live == 1  # the wall viewer still holds the one upstream
            await proxy.unsubscribe("dev", "wall")
            await _until(lambda: box.live == 0)
        finally:
            await proxy.shutdown()
            await client.aclose()


async def test_mock_transport_429_then_a_parsed_frame():
    """Same 429-then-stream path, with httpx.MockTransport instead of a socket."""
    calls: list[str] = []
    body = part(JPEG, 320, 640)

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        if req.url.path == "/status":
            return httpx.Response(200, json={"capture": True, "width": 320, "height": 640, "device_id": "d", "model": "m"})
        if req.url.path == "/screen":
            return httpx.Response(200, content=JPEG, headers={"content-type": "image/jpeg"})
        n = sum(1 for p in calls if p == "/screen/stream")
        if n == 1:
            return httpx.Response(429, json={"error": "too many screen streams (max 2)"})
        return httpx.Response(200, content=body, headers={"content-type": "multipart/x-mixed-replace; boundary=xscriptframe"})

    client = DeviceClient(DeviceTarget("127.0.0.1", 9), transport=httpx.MockTransport(handler))
    events: list = []
    proxy = MirrorProxy(lambda _id: client, lambda topic, data: events.append((topic, data)), timings=FAST)
    try:
        await proxy.subscribe("dev", "main")
        await _until(lambda: any(d.get("state") == "streaming" for t, d in events if t == "mirror.state")
                     and any(t == "mirror.frame" and d["w"] == 320 and d["h"] == 640 for t, d in events))
        assert calls.count("/screen/stream") >= 2 and "/screen" in calls
        assert any(d.get("reason") == "viewers_full" for t, d in events if t == "mirror.state")
    finally:
        await proxy.shutdown()
        await client.aclose()


async def test_disconnect_releases_the_viewer_slot():
    async with serving() as box:
        ctx = AppContext(poll_interval=60, mirror_timings=FAST)
        events: list = []
        ctx.dispatcher.set_event_sink(lambda topic, data: events.append((topic, data)))
        try:
            raw = await ctx.dispatcher.handle(json.dumps({"id": 1, "method": "device.connect", "params": {"transport": "lan", "address": "127.0.0.1:%d" % box.port}}))
            res = json.loads(raw)
            assert res["ok"], res
            dev = res["result"]["id"]
            sub = json.loads(await ctx.dispatcher.handle(json.dumps({"id": 2, "method": "mirror.subscribe", "params": {"id": dev}})))
            assert sub["ok"], sub
            await _until(lambda: any(t == "mirror.frame" for t, _d in events) and box.live == 1)
            gone = json.loads(await ctx.dispatcher.handle(json.dumps({"id": 3, "method": "device.disconnect", "params": {"id": dev}})))
            assert gone["result"]["removed"] is True
            await _until(lambda: box.live == 0)
            missing = json.loads(await ctx.dispatcher.handle(json.dumps({"id": 4, "method": "mirror.subscribe", "params": {"id": "nope"}})))
            assert missing["ok"] is False and missing["error"]["code"] == "device.not_found"
        finally:
            await ctx.shutdown()


@pytest.mark.timeout(10)
async def test_poll_ends_even_when_a_cancel_is_swallowed():
    """The 429 screenshot poll ends even when its cancel is swallowed.

    Python 3.10 + httpx/anyio can lose that cancel; the session then waited on the poll forever (the CI desktop job's
    120 s pytest timeout)."""
    from xscript_desktop.services.mirror import _Session

    class SwallowingClient:
        screens = 0

        async def screen(self, *_a, **_k):
            SwallowingClient.screens += 1
            try:
                await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                pass  # what the buggy stack does: the cancel is lost and a body comes back
            return JPEG, "image/jpeg"

    timings = MirrorTimings(0.2, 0.2, (0.05,), 0.05, 0.001, 0.05)
    sess = _Session("dev", lambda _id: SwallowingClient(), lambda *_a: None, timings, asyncio.Lock())
    sess.viewers["main"] = (12, 0.5, 60)
    await asyncio.wait_for(sess._poll_for(0.1), 3)
    assert SwallowingClient.screens >= 1
