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
from typing import Any, Callable

import httpx

from .adb import DEVICE_PORT, AdbError, AdbService
from .device_client import DeviceClient, DeviceError, DeviceTarget, is_xscript_status, summarize_status

EventEmitter = Callable[[str, Any], None]
ClientFactory = Callable[[DeviceTarget], DeviceClient]

SCAN_PORTS = tuple(range(9860, 9870))  # device API: 9860, taken ports are skipped up to 9869 (openapi.yaml)


@dataclass
class DeviceRecord:
    id: str
    transport: str  # "adb" | "lan"
    target: DeviceTarget
    serial: str = ""  # adb serial (adb transport)
    forward_port: int = 0  # local port of the forward we created (adb transport)
    state: str = "connecting"  # connecting | online | offline
    status: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    last_seen: float = 0.0
    client: DeviceClient | None = None
    warning: str = ""  # e.g. unauthenticated LAN endpoint

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "transport": self.transport, "address": self.target.address, "serial": self.serial,
            "forwardPort": self.forward_port, "state": self.state, "error": self.error, "warning": self.warning,
            "lastSeen": self.last_seen, "info": summarize_status(self.status) if self.status else {}, "status": self.status,
        }


class DeviceManager:
    def __init__(self, adb: AdbService, emit: EventEmitter | None = None, client_factory: ClientFactory | None = None,
                 poll_interval: float = 5.0) -> None:
        self.adb = adb
        self._emit = emit or (lambda topic, data: None)
        self._factory = client_factory or (lambda t: DeviceClient(t))
        self._devices: dict[str, DeviceRecord] = {}
        self._poll_interval = poll_interval
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

    def _set_state(self, rec: DeviceRecord, state: str, error: str = "") -> None:
        changed = rec.state != state or rec.error != error
        rec.state, rec.error = state, error
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
        client.timeout = 10.0
        rec = DeviceRecord(id=dev_id, transport="adb", target=target, serial=serial, forward_port=fw.local_port,
                           state="online", status=status, last_seen=time.time(), client=client)
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
        client.timeout = 10.0
        warning = "" if self._is_loopback(target.host) else "此设备经局域网直连：设备 API 没有鉴权，同网段任何人都能运行代码。仅在可信网络使用，优先用 ADB。"
        rec = DeviceRecord(id=dev_id, transport="lan", target=target, state="online", status=status, last_seen=time.time(),
                           client=client, warning=warning)
        self._devices[dev_id] = rec
        self._emit("device.state", rec.to_dict())
        return rec

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
        self._emit("device.removed", {"id": device_id})
        return True

    async def refresh(self, device_id: str) -> DeviceRecord:
        rec = self.get(device_id)
        assert rec.client is not None
        try:
            rec.status = await rec.client.status()
            rec.last_seen = time.time()
            self._set_state(rec, "online")
        except DeviceError as e:
            self._set_state(rec, "offline", str(e))
        return rec

    # ---- health polling -------------------------------------------------------------------------------------------------------------

    def start_polling(self) -> None:
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.ensure_future(self._poll_loop())

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self._poll_interval)
            for rec in list(self._devices.values()):
                if rec.client is None:
                    continue
                before = (rec.state, rec.status.get("running"), rec.status.get("project"))
                try:
                    rec.status = await rec.client.status()
                    rec.last_seen = time.time()
                    self._set_state(rec, "online")
                    if before[1:] != (rec.status.get("running"), rec.status.get("project")):
                        self._emit("device.state", rec.to_dict())
                except DeviceError as e:
                    self._set_state(rec, "offline", str(e))

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

    async def scan(self, hosts: list[str], ports: tuple[int, ...] = SCAN_PORTS, concurrency: int = 64,
                   timeout: float = 0.8) -> list[dict[str, Any]]:
        """Probe `GET /status` on every host:port. Returns only endpoints that answer like an XScript device."""
        sem = asyncio.Semaphore(concurrency)
        found: list[dict[str, Any]] = []

        async def probe(host: str, port: int) -> None:
            async with sem:
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
                    found.append({"address": DeviceTarget(host, port).address, "host": host, "port": port, "info": summarize_status(st)})

        await asyncio.gather(*(probe(h, p) for h in hosts for p in ports))
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
