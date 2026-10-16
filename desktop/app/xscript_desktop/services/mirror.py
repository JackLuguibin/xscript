"""One MJPEG upstream per device, fanned out to every subscriber (design §14.4).

The page never opens `/screen/stream` itself. It subscribes here, hears `mirror.frame {id, seq, w, h}`, and reads the
latest JPEG from `xsapp://app/_frame/<id>?seq=N` (scheme B). Rules that exist because the device leaks viewer slots:

* never open a stream when `/status.capture` is false (a stream that produces no frames is never released);
* one upstream per device; the last subscriber, a disconnect, or shutdown closes it and waits until that response ends;
* 429 falls back to `GET /screen` (~2 fps) and retries the stream after max(0.5, 1, 2, 4, 8 s, 1.5 s);
* three seconds without a frame closes the stream and does not retry until the user asks or `capture` changes.
"""
from __future__ import annotations

import asyncio
import logging
import math
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from .device_client import DeviceClient, DeviceError

log = logging.getLogger("xscript_desktop.mirror")

BOUNDARY = b"--xscriptframe"
_SIZE = re.compile(r"(\d+)x(\d+)")
DEFAULT_FPS, DEFAULT_SCALE, DEFAULT_QUALITY = 12, 0.5, 60
POLL_MAX, POLL_QUALITY = 480, 40
_MAX_PART = 8_000_000
_EOF = object()

ClientFor = Callable[[str], DeviceClient | None]
Emit = Callable[[str, Any], None]


@dataclass(frozen=True)
class MirrorTimings:
    """Design defaults. Tests pass a shorter copy; nothing else should."""

    first_frame_s: float = 3.0
    stall_s: float = 3.0
    backoff: tuple[float, ...] = (0.5, 1.0, 2.0, 4.0, 8.0)
    min_reopen_s: float = 1.5  # the device frees a slot ~1.35 s after the client closes
    poll_interval_s: float = 0.5  # ~2 fps while a 429 has us on screenshots
    status_poll_s: float = 2.0


def backoff_delay(timings: MirrorTimings, index: int) -> float:
    """`0.5→1→2→4→8` capped, and never sooner than `min_reopen_s` after the previous close."""
    step = timings.backoff[min(max(index, 0), len(timings.backoff) - 1)]
    return max(float(step), float(timings.min_reopen_s))


def clamp_stream_params(fps: Any, scale: Any, quality: Any) -> tuple[int, float, int]:
    """Device clamps (`ScreenStream.Options.from`); we clamp the same way before the request."""
    if fps is None:
        fps = DEFAULT_FPS
    if scale is None:
        scale = DEFAULT_SCALE
    if quality is None:
        quality = DEFAULT_QUALITY
    if isinstance(fps, bool) or isinstance(scale, bool) or isinstance(quality, bool):
        raise ValueError("stream params must be numbers")
    if not isinstance(fps, (int, float)) or not isinstance(scale, (int, float)) or not isinstance(quality, (int, float)):
        raise ValueError("stream params must be numbers")
    if not all(math.isfinite(float(v)) for v in (fps, scale, quality)):
        raise ValueError("stream params must be finite")
    return (min(15, max(1, int(fps))), round(min(1.0, max(0.2, float(scale))), 2), min(95, max(10, int(quality))))


@dataclass(frozen=True)
class JpegPart:
    body: bytes
    w: int
    h: int


class MjpegParser:
    """Incremental `multipart/x-mixed-replace` parser. Frame size comes from `Content-Length`, so a JPEG that happens to
    contain the boundary bytes is not split."""

    def __init__(self) -> None:
        self._buf = b""

    def feed(self, data: bytes) -> list[JpegPart]:
        if data:
            self._buf += data
        out: list[JpegPart] = []
        while True:
            start = self._buf.find(BOUNDARY)
            if start < 0:
                if len(self._buf) > len(BOUNDARY):
                    self._buf = self._buf[-(len(BOUNDARY) - 1):]
                break
            if start:
                self._buf = self._buf[start:]
            if self._buf.startswith(BOUNDARY + b"--"):
                self._buf = b""
                break
            hdr_end = self._buf.find(b"\r\n\r\n")
            if hdr_end < 0:
                break
            length, w, h = _headers(self._buf[:hdr_end])
            if length is None or length < 0 or length > _MAX_PART:
                self._buf = self._buf[len(BOUNDARY):]  # resync at the next boundary; do not scan the JPEG for one
                continue
            body_at = hdr_end + 4
            if len(self._buf) < body_at + length:
                break
            body = self._buf[body_at:body_at + length]
            self._buf = self._buf[body_at + length:]
            if self._buf.startswith(b"\r\n"):
                self._buf = self._buf[2:]
            out.append(JpegPart(body, w, h))
        return out


def _headers(raw: bytes) -> tuple[int | None, int, int]:
    length: int | None = None
    w = h = 0
    for line in raw.decode("latin1", "replace").split("\r\n"):
        low = line.lower()
        if low.startswith("content-length:"):
            try:
                length = int(line.split(":", 1)[1].strip())
            except ValueError:
                length = None
        elif low.startswith("x-screen-size:"):
            m = _SIZE.search(line.split(":", 1)[1])
            if m:
                w, h = int(m.group(1)), int(m.group(2))
    return length, w, h


def _viewer_ok(viewer: str) -> None:
    if not viewer or len(viewer) > 64 or any(c in viewer for c in "/\\\0"):
        raise ValueError("invalid viewer id")


async def _pull(agen: Any) -> Any:
    try:
        return await agen.__anext__()
    except StopAsyncIteration:
        return _EOF


async def _quiet(task: asyncio.Task) -> None:
    try:
        await task
    except (asyncio.CancelledError, Exception):
        return


class _Session:
    def __init__(self, device_id: str, client_for: ClientFor, emit: Emit, timings: MirrorTimings, lock: asyncio.Lock) -> None:
        self.device_id = device_id
        self._client_for = client_for
        self._emit = emit
        self.timings = timings
        self._mu = lock
        self.viewers: dict[str, tuple[int, float, int]] = {}
        self.state = "idle"
        self.reason = ""
        self.seq = 0
        self.frame: tuple[bytes, int, int] | None = None
        self._frame_lock = threading.Lock()
        self._stop = asyncio.Event()
        self._wake = asyncio.Event()
        self._retry = False
        self._retune = False
        self._task: asyncio.Task | None = None
        self._capture: bool | None = None
        self._screen = (0, 0)
        self._backoff_i = 0
        self._active: tuple[int, float, int] | None = None

    def snapshot(self) -> dict[str, Any]:
        with self._frame_lock:
            seq = self.seq
            w, h = (self.frame[1], self.frame[2]) if self.frame else (0, 0)
        fps, scale, quality = self._effective()
        return {"id": self.device_id, "state": self.state, "reason": self.reason, "seq": seq, "w": w, "h": h,
                "viewers": len(self.viewers), "fps": fps, "scale": scale, "quality": quality}

    def _effective(self) -> tuple[int, float, int]:
        vals = list(self.viewers.values())
        if not vals:
            return self._active or (DEFAULT_FPS, DEFAULT_SCALE, DEFAULT_QUALITY)
        return (max(v[0] for v in vals), max(v[1] for v in vals), max(v[2] for v in vals))

    def _client(self) -> DeviceClient:
        client = self._client_for(self.device_id)
        if client is None:
            raise DeviceError("device has no client", kind="connect")
        return client

    def _poke(self) -> None:
        self._wake.set()

    def _set(self, state: str, reason: str = "") -> None:
        if self.state == state and self.reason == reason:
            return
        self.state, self.reason = state, reason
        self._emit("mirror.state", {"id": self.device_id, "state": state, "reason": reason, "viewers": len(self.viewers)})
        log.info("mirror %s -> %s %s", self.device_id, state, reason)

    def _publish(self, body: bytes, w: int, h: int) -> None:
        with self._frame_lock:
            self.seq += 1
            self.frame = (bytes(body), int(w), int(h))
            seq = self.seq
        self._emit("mirror.frame", {"id": self.device_id, "seq": seq, "w": int(w), "h": int(h)})

    def ensure_task(self) -> None:
        if self._task is None or self._task.done():
            self._stop.clear()
            self._task = asyncio.create_task(self.run(), name="mirror-%s" % self.device_id)

    def set_viewer(self, viewer: str, params: tuple[int, float, int]) -> None:
        self.viewers[viewer] = params
        self._stop.clear()
        wake = False
        if self.state in ("stalled", "blocked"):
            self._retry = True
            wake = True
        if self._active is not None and self._effective() != self._active:
            self._retune = True
            wake = True
        if wake:
            self._poke()

    async def run(self) -> None:
        try:
            while self.viewers and not self._stop.is_set():
                outcome = await self._cycle()
                if outcome in ("leave", "stopped"):
                    break
                if outcome == "blocked":
                    await self._wait_until_capture_changes()
                    continue
                if outcome == "stall":
                    self._set("stalled", "no_frames")
                    await self._wait_until_capture_changes()
                    continue
                if outcome == "busy":
                    self._set("busy", "viewers_full")
                    await self._poll_for(backoff_delay(self.timings, self._backoff_i))
                    if self._stop.is_set() or not self.viewers:
                        break
                    self._backoff_i += 1
                    continue
                if outcome == "retune":
                    await self._sleep_full(self.timings.min_reopen_s)
                    continue
                self._set("backoff", outcome)
                await self._sleep_full(backoff_delay(self.timings, self._backoff_i))
                if self._stop.is_set() or not self.viewers:
                    break
                self._backoff_i += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("mirror %s failed", self.device_id)
        finally:
            async with self._mu:
                if self._task is asyncio.current_task():
                    self._task = None
                restart = bool(self.viewers) and not self._stop.is_set()
                if restart:
                    self._task = asyncio.create_task(self.run(), name="mirror-%s" % self.device_id)
            if not restart:
                self._set("idle", "")

    async def _cycle(self) -> str:
        if self._stop.is_set() or not self.viewers:
            return "leave"
        self._retune = False
        self._wake.clear()
        if self._stop.is_set() or not self.viewers or self._retry:
            self._retry = False
            if self._stop.is_set() or not self.viewers:
                return "leave"
        self._set("connecting", "")
        try:
            status = await self._client().status()
        except KeyError:
            self._stop.set()
            return "leave"
        except DeviceError as e:
            return "timeout" if e.kind == "timeout" else ("connect" if e.kind == "connect" else "http")
        if not isinstance(status, dict):
            return "http"
        self._capture = bool(status.get("capture"))
        self._screen = (_dim(status.get("width")), _dim(status.get("height")))
        if not self._capture:
            self._set("blocked", "no_capture")
            return "blocked"
        if self._stop.is_set() or not self.viewers:
            return "leave"
        params = self._effective()
        self._active = params
        try:
            async with self._client().open_screen_stream(*params) as resp:
                code = resp.status_code
                if code == 429:
                    await resp.aread()
                    return "busy"
                if code != 200:
                    await resp.aread()
                    return "http"
                if self._stop.is_set() or not self.viewers:
                    return "stopped"
                if self._retune or self._effective() != params:
                    return "retune"
                # drop a poke that arrived during preflight; consume arms the wake wait itself
                self._wake.clear()
                if self._stop.is_set() or not self.viewers:
                    return "stopped"
                return await self._consume(resp)
        except KeyError:
            self._stop.set()
            return "leave"
        except DeviceError as e:
            return "timeout" if e.kind == "timeout" else "connect"
        except (httpx.TransportError, httpx.TimeoutException):
            return "connect"
        except httpx.HTTPError:
            return "http"
        finally:
            self._active = None

    async def _consume(self, resp: httpx.Response) -> str:
        parser = MjpegParser()
        agen = resp.aiter_bytes().__aiter__()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.timings.first_frame_s
        while self.viewers and not self._stop.is_set():
            if self._retune or self._effective() != self._active:
                return "retune"
            timeout = deadline - loop.time()
            if timeout <= 0:
                return "stall"
            kind, chunk = await self._read_or_leave(agen, timeout)
            if kind != "data":
                return kind
            for part in parser.feed(chunk):
                w = part.w or self._screen[0]
                h = part.h or self._screen[1]
                self._publish(part.body, w, h)
                self._set("streaming", "")
                self._backoff_i = 0
                deadline = loop.time() + self.timings.stall_s
        return "stopped"

    async def _read_or_leave(self, agen: Any, timeout: float) -> tuple[str, bytes]:
        """A chunk, or a reason to abandon this stream. The read is cancelled only when we are leaving the stream
        (stop, retune, stall); a healthy stream is never interrupted, so the parser stays in sync."""
        pull = asyncio.create_task(_pull(agen))
        leave = asyncio.create_task(self._wake.wait())
        try:
            done, _pending = await asyncio.wait({pull, leave}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            pull.cancel()
            leave.cancel()
            await _quiet(pull)
            await _quiet(leave)
            raise
        if pull in done and leave not in done:
            leave.cancel()
            await _quiet(leave)
            try:
                item = pull.result()
            except Exception:
                return "http", b""
            if item is _EOF:
                return "eof", b""
            return "data", item
        pull.cancel()
        await _quiet(pull)
        if leave in done:
            await _quiet(leave)
            self._wake.clear()
            if self._stop.is_set() or not self.viewers:
                return "stopped", b""
            return "retune", b""
        leave.cancel()
        await _quiet(leave)
        return "stall", b""

    async def _wait_until_capture_changes(self) -> None:
        """Blocked and stalled both sit here: no stream, until the user retries or `/status.capture` flips."""
        seen = self._capture
        while self.viewers and not self._stop.is_set():
            if self._retry:
                self._retry = False
                return
            try:
                status = await self._client().status()
            except (DeviceError, KeyError):
                status = None
            if isinstance(status, dict) and bool(status.get("capture")) != bool(seen):
                self._capture = bool(status.get("capture"))
                self._screen = (_dim(status.get("width")), _dim(status.get("height")))
                return
            if await self._wait_poke(self.timings.status_poll_s):
                continue
        return

    async def _wait_poke(self, seconds: float) -> bool:
        if self._stop.is_set() or not self.viewers:
            return True
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
        except asyncio.TimeoutError:
            return False
        self._wake.clear()
        return True

    async def _sleep_full(self, seconds: float) -> None:
        """Wait out the slot-release gap. A parameter change must not shorten it; stop/unsubscribe does."""
        deadline = asyncio.get_running_loop().time() + seconds
        while self.viewers and not self._stop.is_set():
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return
            try:
                await asyncio.wait_for(self._wake.wait(), remaining)
            except asyncio.TimeoutError:
                return
            self._wake.clear()

    async def _poll_for(self, delay: float) -> None:
        task = asyncio.create_task(self._poll())
        try:
            await self._sleep_full(delay)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _poll(self) -> None:
        while True:
            try:
                body, _mime = await self._client().screen("jpg", POLL_QUALITY, POLL_MAX)
            except asyncio.CancelledError:
                raise
            except (DeviceError, KeyError):
                body = b""
            if body and self.viewers and not self._stop.is_set():
                self._publish(body, self._screen[0], self._screen[1])
            await asyncio.sleep(self.timings.poll_interval_s)


def _dim(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value) if value > 0 else 0


class MirrorProxy:
    def __init__(self, client_for: ClientFor, emit: Emit, timings: MirrorTimings | None = None) -> None:
        self._client_for = client_for
        self._emit = emit or (lambda _topic, _data: None)
        self._timings = timings or MirrorTimings()
        self._sessions: dict[str, _Session] = {}
        self._mu = asyncio.Lock()

    def latest(self, device_id: str) -> bytes | None:
        """The newest JPEG, or None. Called from the Qt thread (the scheme handler); the bytes are immutable."""
        sess = self._sessions.get(device_id)
        if sess is None:
            return None
        with sess._frame_lock:
            return None if sess.frame is None else sess.frame[0]

    async def subscribe(self, device_id: str, viewer: str, fps: Any = None, scale: Any = None, quality: Any = None) -> dict[str, Any]:
        _viewer_ok(viewer)
        params = clamp_stream_params(fps, scale, quality)
        async with self._mu:
            sess = self._sessions.get(device_id)
            if sess is None:
                sess = _Session(device_id, self._client_for, self._emit, self._timings, self._mu)
                self._sessions[device_id] = sess
            sess.set_viewer(viewer, params)
            sess.ensure_task()
            return sess.snapshot()

    async def unsubscribe(self, device_id: str, viewer: str) -> dict[str, Any]:
        _viewer_ok(viewer)
        async with self._mu:
            sess = self._sessions.get(device_id)
            if sess is None:
                return {"ok": True, "viewers": 0}
            sess.viewers.pop(viewer, None)
            task: asyncio.Task | None = None
            if sess.viewers:
                if sess._active is not None and sess._effective() != sess._active:
                    sess._retune = True
                    sess._poke()
            else:
                sess._stop.set()
                sess._poke()
                task = sess._task
        if task is not None:
            await task  # the stream's response is closed before this returns
        async with self._mu:
            sess = self._sessions.get(device_id)
            if sess is not None and not sess.viewers and (sess._task is None or sess._task.done()):
                self._sessions.pop(device_id, None)
                return {"ok": True, "viewers": 0}
            return {"ok": True, "viewers": len(sess.viewers) if sess else 0}

    async def retry(self, device_id: str) -> dict[str, Any]:
        async with self._mu:
            sess = self._sessions.get(device_id)
            if sess is None or not sess.viewers:
                raise KeyError(device_id)
            sess._retry = True
            sess._poke()
            sess.ensure_task()
            return sess.snapshot()

    async def close(self, device_id: str) -> None:
        async with self._mu:
            sess = self._sessions.get(device_id)
            if sess is None:
                return
            sess.viewers.clear()
            sess._stop.set()
            sess._poke()
            task = sess._task
        if task is not None:
            await task
        async with self._mu:
            cur = self._sessions.get(device_id)
            if cur is not None and not cur.viewers and (cur._task is None or cur._task.done()):
                self._sessions.pop(device_id, None)

    async def shutdown(self) -> None:
        for device_id in list(self._sessions):
            await self.close(device_id)
