"""DeviceManager: registry of connected devices, connect/disconnect, health polling, LAN scan (design §5.2, §3.4).

Transports in P0: `adb` (adb forward -> loopback) and `lan` (host:port typed by the user or found by a scan).
The relay (cloud) transport is P1/P4.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

import httpx

from .adb import DEVICE_PORT, AdbError, AdbService
from .device_client import (DeviceClient, DeviceError, DeviceTarget, is_xscript_status, needs_pairing, normalize_code,
                            summarize_status, valid_code)

EventEmitter = Callable[[str, Any], None]
ClientFactory = Callable[[DeviceTarget], DeviceClient]

SCAN_PORTS = tuple(range(9860, 9870))  # device API: 9860, taken ports are skipped up to 9869 (openapi.yaml)
POLL_TIMEOUT = 3.0  # per-device /status budget of one health round: one dead LAN device must not stall the others
LAN_WARNING = "此设备关闭了配对（或 App 版本较旧）：设备 API 不需要配对码，同网段任何人都能运行代码。仅在可信网络使用，优先用 ADB。"
UNPAIRED = "需要配对码：在手机 XScript 首页「开发与连接 → 配对码」查看后输入"
OnOnline = Callable[["DeviceRecord"], Awaitable[None]]
OnFound = Callable[[dict[str, Any]], None]
OnProgress = Callable[[int, int], None]


class PairingStore(Protocol):
    """Pairing codes per device id ("adb:<serial>", "lan:<host>:<port>"). The app keeps them in the OS keychain."""

    def get(self, device_id: str) -> str: ...
    def put(self, device_id: str, code: str) -> None: ...


class MemoryPairing:
    def __init__(self) -> None:
        self.codes: dict[str, str] = {}

    def get(self, device_id: str) -> str:
        return self.codes.get(device_id, "")

    def put(self, device_id: str, code: str) -> None:
        self.codes[device_id] = code


@dataclass
class DeviceRecord:
    id: str
    transport: str  # "adb" | "lan"
    target: DeviceTarget
    serial: str = ""  # adb serial (adb transport)
    forward_port: int = 0  # local port of the forward we created (adb transport)
    state: str = "connecting"  # connecting | online | unpaired | offline
    status: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    error_code: str = ""  # machine-readable twin of `error` (DeviceError.code), "" when there is no error
    last_seen: float = 0.0
    client: DeviceClient | None = None
    warning: str = ""  # e.g. unauthenticated LAN endpoint
    # copied from the saved row (design §14.5) so health events don't wipe the name the user typed
    saved_name: str = ""
    group: str = ""
    note: str = ""
    auto_connect: bool = False
    sort_order: int = 0
    saved: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "transport": self.transport, "address": self.target.address, "serial": self.serial,
            "forwardPort": self.forward_port, "state": self.state, "error": self.error, "errorCode": self.error_code, "warning": self.warning,
            "lastSeen": self.last_seen, "info": summarize_status(self.status) if self.status else {}, "status": self.status,
            "name": self.saved_name, "group": self.group, "note": self.note, "autoConnect": self.auto_connect,
            "sortOrder": self.sort_order, "saved": self.saved,
        }


class DeviceManager:
    def __init__(self, adb: AdbService, emit: EventEmitter | None = None, client_factory: ClientFactory | None = None,
                 poll_interval: float = 5.0, on_online: OnOnline | None = None, poll_timeout: float = POLL_TIMEOUT,
                 pairing: PairingStore | None = None) -> None:
        self.adb = adb
        self._pairing: PairingStore = pairing or MemoryPairing()
        self._emit = emit or (lambda topic, data: None)
        self._factory = client_factory or (lambda t: DeviceClient(t))
        self._on_online = on_online
        self._devices: dict[str, DeviceRecord] = {}
        self._poll_interval = poll_interval
        self._poll_timeout = poll_timeout
        self._poll_task: asyncio.Task | None = None

    # ---- helpers --------------------------------------------------------------------------------------------------------------

    def _probe_client(self, target: DeviceTarget, timeout: float = 5.0) -> DeviceClient:
        c = self._factory(target)
        c.timeout = timeout
        return c

    def get(self, device_id: str) -> DeviceRecord:
        rec = self._devices.get(device_id)
        if rec is None:
            raise KeyError(device_id)
        return rec

    def list(self) -> list[DeviceRecord]:
        return list(self._devices.values())

    @staticmethod
    def _is_loopback(host: str) -> bool:
        try:
            return ipaddress.ip_address(host).is_loopback or host == "localhost"
        except ValueError:
            return host == "localhost"

    # ---- pairing ----------------------------------------------------------------------------------------------------------------------

    def _stored_code(self, device_id: str) -> str:
        try:
            return normalize_code(self._pairing.get(device_id) or "")
        except Exception:
            return ""  # keychain locked or unavailable: ask the user instead

    def _save_code(self, device_id: str, code: str) -> None:
        try:
            self._pairing.put(device_id, normalize_code(code))
        except Exception:
            pass  # still paired for this session; the next start asks again

    async def _pair_up(self, device_id: str, client: DeviceClient, status: dict[str, Any], serial: str = "") -> dict[str, Any]:
        """Bring a pairing-protected device to paired: the saved code first, then (USB) the code read over adb.
        Returns the device's /status as seen with whatever code worked, or the unpaired status."""
        if not needs_pairing(status):
            return status
        tried: set[str] = set()
        stored = self._stored_code(device_id)
        sources = [(stored, False)] if stored else []
        for i in range(2):
            if i == 1 and serial:
                code = await self.adb.pairing_code(serial, str(status.get("app_id") or ""))
                if code:
                    sources.append((code, True))
            while sources:
                code, fresh = sources.pop(0)
                if code in tried:
                    continue
                tried.add(code)
                client.set_token(code)
                st = await client.status()
                if not needs_pairing(st):
                    if fresh:
                        self._save_code(device_id, code)
                    return st
        client.set_token("")
        return status

    def _pair_state(self, rec: DeviceRecord) -> None:
        if needs_pairing(rec.status):
            self._set_state(rec, "unpaired", UNPAIRED, "device.unpaired")
        else:
            self._set_state(rec, "online")

    async def pair(self, device_id: str, code: str) -> DeviceRecord:
        """Pair with the code the user typed. Raises DeviceError(kind="auth") when the device refuses it."""
        rec = self.get(device_id)
        if rec.client is None:
            raise DeviceError("设备未连接", kind="connect")
        if not valid_code(code):
            raise DeviceError("配对码是 8 位字母或数字，例如 ABCD-EFGH", kind="auth")
        old = rec.client.token
        rec.client.set_token(code)
        try:
            st = await rec.client.status()
        except DeviceError:
            rec.client.set_token(old)
            raise
        if needs_pairing(st):
            rec.client.set_token(old)
            raise DeviceError("配对码不正确（手机上重新生成过？）", status=401, kind="auth")
        self._save_code(rec.id, code)
        rec.status, rec.last_seen = st, time.time()
        rec.warning = self._warning(rec)
        self._pair_state(rec)
        self._emit("device.state", rec.to_dict())
        await self._note_online(rec)
        return rec

    def _warning(self, rec: DeviceRecord) -> str:
        if rec.transport != "lan" or self._is_loopback(rec.target.host):
            return ""
        return "" if rec.status.get("pairing") else LAN_WARNING

    def _set_state(self, rec: DeviceRecord, state: str, error: str = "", code: str = "") -> None:
        changed = rec.state != state or rec.error != error or rec.error_code != code
        rec.state, rec.error, rec.error_code = state, error, code
        if changed:
            self._emit("device.state", rec.to_dict())

    # ---- connect / disconnect ------------------------------------------------------------------------------------------------------

    async def connect_adb(self, serial: str, local_port: int = 0) -> DeviceRecord:
        """adb forward <auto port> -> 9860 on `serial`, then probe /status. Cleans up its own forward on failure."""
        devs = {d.serial: d for d in await self.adb.devices()}
        dev = devs.get(serial)
        if dev is None:
            raise AdbError("adb.no_such_device", "adb 设备不存在或已断开: %s" % serial)
        if dev.state != "device":
            raise AdbError("adb.not_ready", "设备 %s 状态为 %s（需要 device；unauthorized 请在手机上允许 USB 调试）" % (serial, dev.state))
        dev_id = "adb:" + serial
        old = self._devices.get(dev_id)
        if old is not None:
            await self.disconnect(dev_id)
        fw = await self.adb.forward(serial, DEVICE_PORT, local_port)
        target = DeviceTarget("127.0.0.1", fw.local_port)
        client = self._probe_client(target)
        try:
            status = await client.status()
        except asyncio.CancelledError:  # e.g. the startup reconnect gave up on this device: leave no forward behind
            await client.aclose()
            try:
                await self.adb.remove_forward(serial, fw.local_port)
            except AdbError:
                pass
            raise
        except DeviceError as e:
            await client.aclose()
            await self.adb.remove_forward(serial, fw.local_port)
            raise DeviceError(
                "已建立 adb forward，但 127.0.0.1:%d 没有响应 XScript（App 没打开或服务未启动？）: %s" % (fw.local_port, e),
                status=e.status, detail=e.detail, kind=e.kind) from e
        if not is_xscript_status(status):
            await client.aclose()
            await self.adb.remove_forward(serial, fw.local_port)
            raise DeviceError("127.0.0.1:%d 有响应，但不像 XScript 设备（/status 缺少 device_id/app_id/model）" % fw.local_port, kind="protocol")
        try:
            status = await self._pair_up(dev_id, client, status, serial)
        except DeviceError:
            pass  # keep the unpaired status: the card offers "输入配对码"
        client.timeout = 10.0
        rec = DeviceRecord(id=dev_id, transport="adb", target=target, serial=serial, forward_port=fw.local_port,
                           state="online", status=status, last_seen=time.time(), client=client)
        if needs_pairing(status):
            rec.state, rec.error, rec.error_code = "unpaired", UNPAIRED, "device.unpaired"
        self._devices[dev_id] = rec
        self._emit("device.state", rec.to_dict())
        return rec

    async def connect_address(self, address: str) -> DeviceRecord:
        """LAN / manual host:port. The device API has no authentication: non-loopback gets a warning (design §6.1)."""
        try:
            target = DeviceTarget.parse(address)
        except ValueError as e:
            raise DeviceError(str(e), kind="protocol") from e
        dev_id = "lan:" + target.address
        old = self._devices.get(dev_id)
        if old is not None:
            await self.disconnect(dev_id)
        client = self._probe_client(target)
        try:
            status = await client.status()
        except DeviceError:
            await client.aclose()
            raise
        if not is_xscript_status(status):
            await client.aclose()
            raise DeviceError("%s 有响应，但不像 XScript 设备（/status 缺少 device_id/app_id/model）" % target.address, kind="protocol")
        try:
            status = await self._pair_up(dev_id, client, status)
        except DeviceError:
            pass
        client.timeout = 10.0
        rec = DeviceRecord(id=dev_id, transport="lan", target=target, state="online", status=status, last_seen=time.time(),
                           client=client)
        rec.warning = self._warning(rec)
        if needs_pairing(status):
            rec.state, rec.error, rec.error_code = "unpaired", UNPAIRED, "device.unpaired"
        self._devices[dev_id] = rec
        self._emit("device.state", rec.to_dict())
        return rec

    # ---- connection check ---------------------------------------------------------------------------------------------------------

    async def check(self, transport: str, target: str) -> dict[str, Any]:
        """Walk the connection one step at a time and stop at the first failure (the 「逐项检查」 panel).

        adb: adb found → device listed → USB debugging allowed → port forward → app answers → XScript → paired.
        lan: address valid → port reachable → app answers → XScript → paired.
        Each step is {id, ok, detail}; ok is None for steps not reached. Leaves no forward or client behind and does
        not add a device (connect does that).
        """
        steps: list[dict[str, Any]] = []
        order = (["adb", "device", "authorized", "forward"] if transport == "adb" else ["address", "reach"]) + ["app", "xscript", "pairing"]

        def done(step: str, ok: bool, detail: str = "") -> bool:
            steps.append({"id": step, "ok": ok, "detail": detail})
            return ok

        def result() -> dict[str, Any]:
            seen = {x["id"] for x in steps}
            out = steps + [{"id": i, "ok": None, "detail": ""} for i in order if i not in seen]
            return {"transport": transport, "target": target, "ok": all(x["ok"] for x in out), "steps": out}

        forward: tuple[str, int] | None = None
        client: DeviceClient | None = None
        try:
            if transport == "adb":
                try:
                    devs = {d.serial: d for d in await self.adb.devices()}
                except AdbError as e:
                    if e.code in ("adb.not_found", "adb.spawn"):
                        done("adb", False, str(e))
                    else:
                        done("adb", True)
                        done("device", False, str(e))
                    return result()
                done("adb", True)
                dev = devs.get(target)
                if not done("device", dev is not None, "" if dev else "adb devices 里没有 %s" % target):
                    return result()
                if not done("authorized", dev.state == "device", dev.state):
                    return result()
                live = self._devices.get("adb:" + target)
                if live is not None and live.forward_port and live.state != "offline":
                    dt = DeviceTarget("127.0.0.1", live.forward_port)  # already connected: check through its forward
                    done("forward", True, "127.0.0.1:%d → %d" % (live.forward_port, DEVICE_PORT))
                else:
                    try:
                        fw = await self.adb.forward(target, DEVICE_PORT, 0)
                    except AdbError as e:
                        done("forward", False, str(e))
                        return result()
                    forward = (target, fw.local_port)
                    dt = DeviceTarget("127.0.0.1", fw.local_port)
                    done("forward", True, "127.0.0.1:%d → %d" % (fw.local_port, DEVICE_PORT))
            else:
                try:
                    dt = DeviceTarget.parse(target)
                except ValueError as e:
                    done("address", False, str(e))
                    return result()
                done("address", True, dt.address)
                try:
                    _, writer = await asyncio.wait_for(asyncio.open_connection(dt.host, dt.port), 3.0)
                    writer.close()
                except asyncio.TimeoutError:
                    done("reach", False, "timeout")
                    return result()
                except OSError as e:
                    done("reach", False, "refused" if isinstance(e, ConnectionRefusedError) else (e.strerror or str(e)))
                    return result()
                done("reach", True, dt.address)
            client = self._probe_client(dt, timeout=5.0)
            try:
                status = await client.status()
            except DeviceError as e:
                done("app", False, str(e))
                return result()
            done("app", True)
            if not done("xscript", is_xscript_status(status), "%s %s" % (status.get("model", ""), status.get("version", "")) if isinstance(status, dict) else ""):
                return result()
            dev_id = ("adb:" if transport == "adb" else "lan:") + (target if transport == "adb" else dt.address)
            try:
                status = await self._pair_up(dev_id, client, status, target if transport == "adb" else "")
            except DeviceError as e:
                done("pairing", False, str(e))
                return result()
            done("pairing", not needs_pairing(status), "pairing" if status.get("pairing") else "off")
            return result()
        finally:
            if client is not None:
                await client.aclose()
            if forward is not None:
                try:
                    await self.adb.remove_forward(*forward)
                except AdbError:
                    pass

    async def disconnect(self, device_id: str) -> bool:
        rec = self._devices.pop(device_id, None)
        if rec is None:
            return False
        if rec.client is not None:
            await rec.client.aclose()
        if rec.transport == "adb" and rec.forward_port:
            try:
                await self.adb.remove_forward(rec.serial, rec.forward_port)
            except AdbError:
                pass  # device already gone: nothing left to remove
        rec.state = "offline"
        # no device.removed here: a saved device stays as an offline card. AppContext emits removed only on forget.
        return True

    async def refresh(self, device_id: str) -> DeviceRecord:
        rec = self.get(device_id)
        assert rec.client is not None
        try:
            status = await rec.client.status()
            if needs_pairing(status):
                status = await self._pair_up(rec.id, rec.client, status, rec.serial if rec.transport == "adb" else "")
            rec.status = status
            rec.last_seen = time.time()
            rec.warning = self._warning(rec)
            self._pair_state(rec)
            if rec.state == "online":
                await self._note_online(rec)
        except DeviceError as e:
            self._set_state(rec, "offline", str(e), e.code)
        return rec

    # ---- health polling -------------------------------------------------------------------------------------------------------------

    def start_polling(self) -> None:
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.ensure_future(self._poll_loop())

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self._poll_interval)
            await self.poll_once()

    async def poll_once(self) -> None:
        """One health round: every connected device at once, each bounded by `poll_timeout` (was serial, 10 s each)."""
        recs = [r for r in self._devices.values() if r.client is not None]
        await asyncio.gather(*(self._poll_one(r) for r in recs), return_exceptions=True)

    async def _poll_one(self, rec: DeviceRecord) -> None:
        assert rec.client is not None
        before = (rec.status.get("running"), rec.status.get("project"))
        try:
            status = await asyncio.wait_for(rec.client.status(), self._poll_timeout)
        except asyncio.TimeoutError:
            if self._devices.get(rec.id) is rec:
                self._set_state(rec, "offline", "device GET /status timed out after %.0f s" % self._poll_timeout, "device.timeout")
            return
        except DeviceError as e:
            if self._devices.get(rec.id) is rec:
                self._set_state(rec, "offline", str(e), e.code)
            return
        if self._devices.get(rec.id) is not rec:
            return  # disconnected (or reconnected as a new record) while this request was in flight
        if needs_pairing(status) and rec.state != "unpaired" and rec.transport == "adb":
            # the code was regenerated on the phone: over USB, read the new one once instead of nagging
            try:
                status = await self._pair_up(rec.id, rec.client, status, rec.serial)
            except DeviceError:
                pass
        rec.status = status
        rec.last_seen = time.time()
        rec.warning = self._warning(rec)
        self._pair_state(rec)
        if rec.state == "online":
            await self._note_online(rec)
        if before != (rec.status.get("running"), rec.status.get("project")):
            self._emit("device.state", rec.to_dict())

    async def _note_online(self, rec: DeviceRecord) -> None:
        if self._on_online is None:
            return
        try:
            await self._on_online(rec)
        except Exception:
            pass  # remembering last_seen must not kill the health loop

    async def shutdown(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):
                pass
        for dev_id in list(self._devices):
            await self.disconnect(dev_id)
        await self.adb.cleanup()

    # ---- LAN scan -------------------------------------------------------------------------------------------------------------------------

    async def scan(self, hosts: list[str], ports: tuple[int, ...] | None = None, concurrency: int = 64,
                   timeout: float = 0.8, *, on_found: OnFound | None = None, on_progress: OnProgress | None = None,
                   cancel: asyncio.Event | None = None) -> list[dict[str, Any]]:
        """Probe `GET /status` on every host:port. Returns only endpoints that answer like an XScript device.

        The default port goes first over all hosts (almost every device is on 9860), then the fallback ports.
        `on_found` gets each hit as soon as it answers, `on_progress(done, total)` after every probe. Setting
        `cancel` stops it: probes not started yet are skipped, the ones in flight finish (bounded by `timeout`).
        """
        ports = SCAN_PORTS if ports is None else ports
        sem = asyncio.Semaphore(concurrency)
        found: list[dict[str, Any]] = []
        total = len(hosts) * len(ports)
        done = 0

        def tick() -> None:
            nonlocal done
            done += 1
            if on_progress is not None:
                on_progress(done, total)

        async def probe(host: str, port: int) -> None:
            try:
                async with sem:
                    if cancel is not None and cancel.is_set():
                        return
                    # a cheap TCP connect first so closed ports cost ~nothing; only then speak HTTP
                    try:
                        _, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
                        w.close()
                    except (OSError, asyncio.TimeoutError):
                        return
                    c = self._factory(DeviceTarget(host, port))
                    c.timeout = max(timeout, 2.0)
                    try:
                        st = await c.status()
                    except DeviceError:
                        return
                    finally:
                        await c.aclose()
                    if is_xscript_status(st):
                        hit = {"address": DeviceTarget(host, port).address, "host": host, "port": port, "info": summarize_status(st)}
                        found.append(hit)
                        if on_found is not None:
                            on_found(hit)
            finally:
                tick()

        for phase in (ports[:1], ports[1:]):
            if cancel is not None and cancel.is_set():
                break
            await asyncio.gather(*(probe(h, p) for p in phase for h in hosts))
        if done < total:  # cancelled before the fallback ports started: report the bar as finished
            done = total - 1
            tick()
        found.sort(key=lambda d: (d["host"], d["port"]))
        return found


def lan_hosts(cidr: str | None = None, limit: int = 1024) -> list[str]:
    """Host list for a scan: the given CIDR, else the /24 around this machine's primary IPv4 address."""
    if cidr:
        net = ipaddress.ip_network(cidr, strict=False)
    else:
        ip = _local_ipv4()
        if not ip:
            return []
        net = ipaddress.ip_network(ip + "/24", strict=False)
    count = max(net.num_addresses - 2, 1) if net.version == 4 else net.num_addresses  # check BEFORE materialising: a /8 is 16M hosts
    if count > limit:
        raise ValueError("scan range too large (%d hosts > %d)" % (count, limit))
    return [str(h) for h in net.hosts()]


def _local_ipv4() -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("203.0.113.1", 9))  # TEST-NET-3: no packet is sent, this just selects the outgoing interface
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
