"""AppContext: wires the services to the RPC dispatcher. No Qt imports here, so it is testable headless."""
from __future__ import annotations

import functools
import platform
import sys
import threading
from typing import Any, Awaitable, Callable

from . import __version__
from .rpc import Dispatcher, RpcError, param
from .services.adb import AdbError, AdbService
from .services.device_client import DeviceError
from .services.device_manager import DeviceManager, lan_hosts


def _map_errors(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    @functools.wraps(fn)
    async def wrapper(params: dict[str, Any]) -> Any:
        try:
            return await fn(params)
        except AdbError as e:
            raise RpcError(e.code, e.message, details=e.details) from e
        except DeviceError as e:
            code = {"connect": "device.unreachable", "timeout": "device.timeout", "protocol": "device.protocol"}.get(e.kind, "device.http")
            raise RpcError(code, str(e), retryable=e.retryable, details={"status": e.status, "detail": e.detail}) from e
        except KeyError as e:
            raise RpcError("device.not_found", "no such connected device: %s" % e.args[0]) from e
        except ValueError as e:
            raise RpcError("rpc.bad_params", str(e)) from e

    return wrapper


class AppContext:
    def __init__(self, adb: AdbService | None = None, poll_interval: float = 5.0) -> None:
        self.dispatcher = Dispatcher()
        self.adb = adb or AdbService()
        self.devices = DeviceManager(self.adb, emit=self.dispatcher.emit, poll_interval=poll_interval)
        self.ui_ready = threading.Event()
        self._register()

    # ---- binary data for xsapp://shot/... (called from the scheme handler through the asyncio loop) -------------------------------

    async def screen(self, device_id: str, max_side: int | None = 480, quality: int = 60) -> tuple[bytes, str]:
        rec = self.devices.get(device_id)
        assert rec.client is not None
        try:
            return await rec.client.screen("jpg", quality, max_side)
        except DeviceError as e:
            raise e

    async def shutdown(self) -> None:
        await self.devices.shutdown()

    # ---- RPC methods ---------------------------------------------------------------------------------------------------------------------------

    def _register(self) -> None:
        d = self.dispatcher

        @d.method("app.ping")
        def ping(params: dict[str, Any]) -> dict[str, Any]:
            return {"pong": params.get("echo"), "version": __version__, "python": platform.python_version(), "platform": sys.platform}

        @d.method("app.hello")
        def hello(params: dict[str, Any]) -> dict[str, Any]:
            """The page calls this once it has mounted (used by --selftest and to tell the UI the shell's capabilities)."""
            if params.get("pingOk") is True:  # the page proved a full request/response round trip
                self.ui_ready.set()
            return {"version": __version__, "platform": sys.platform, "adbPath": self.adb.path(), "methods": d.methods}

        @d.method("app.settings.set")
        def set_settings(params: dict[str, Any]) -> dict[str, Any]:
            if "adbPath" in params:
                self.adb.set_path(param(params, "adbPath", str, default="") or None)
            return {"adbPath": self.adb.path()}

        @d.method("device.adb.list")
        @_map_errors
        async def adb_list(params: dict[str, Any]) -> dict[str, Any]:
            devs = await self.adb.devices()
            return {"adbPath": self.adb.path(), "devices": [x.to_dict() for x in devs]}

        @d.method("device.connect")
        @_map_errors
        async def connect(params: dict[str, Any]) -> dict[str, Any]:
            transport = param(params, "transport", str)
            if transport == "adb":
                rec = await self.devices.connect_adb(param(params, "serial", str), param(params, "localPort", int, default=0))
            elif transport == "lan":
                rec = await self.devices.connect_address(param(params, "address", str))
            else:
                raise RpcError("rpc.bad_params", "unknown transport: %s" % transport)
            self.devices.start_polling()
            return rec.to_dict()

        @d.method("device.list")
        def list_devices(params: dict[str, Any]) -> dict[str, Any]:
            return {"devices": [r.to_dict() for r in self.devices.list()]}

        @d.method("device.refresh")
        @_map_errors
        async def refresh(params: dict[str, Any]) -> dict[str, Any]:
            return (await self.devices.refresh(param(params, "id", str))).to_dict()

        @d.method("device.disconnect")
        @_map_errors
        async def disconnect(params: dict[str, Any]) -> dict[str, Any]:
            return {"removed": await self.devices.disconnect(param(params, "id", str))}

        @d.method("device.scan")
        @_map_errors
        async def scan(params: dict[str, Any]) -> dict[str, Any]:
            hosts = params.get("hosts")
            if hosts is None:
                hosts = lan_hosts(param(params, "cidr", str, default=None))
            if not isinstance(hosts, list) or not all(isinstance(h, str) for h in hosts) or len(hosts) > 1024:
                raise RpcError("rpc.bad_params", "hosts must be a list of at most 1024 strings")
            return {"found": await self.devices.scan(hosts)}
