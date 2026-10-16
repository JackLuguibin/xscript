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

ACTION_TYPES = ("click", "swipe", "input", "key")
MAX_FILE_CHARS = 2 * 1024 * 1024  # stays under the bridge's 4 MiB request cap even after JSON escaping


def _rel_path(params: dict[str, Any]) -> str:
    """Same rules as the device (ProjectStore.resolve): relative, '/'-separated, no '.', '..' or empty segments."""
    rel = param(params, "path", str)
    if not rel or rel.startswith("/") or "\\" in rel or "\0" in rel or any(p in ("", ".", "..") for p in rel.split("/")):
        raise RpcError("rpc.bad_params", "invalid project path: %r" % rel)
    return rel


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

    def _client(self, params: dict[str, Any]) -> Any:
        rec = self.devices.get(param(params, "id", str))
        if rec.client is None:
            raise RpcError("device.not_found", "device has no client: %s" % rec.id)
        return rec.client

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

        # ---- projects / run / logs / input (P1 slice: design §12.1) ----------------------------------------------------------------

        @d.method("project.list")
        @_map_errors
        async def project_list(params: dict[str, Any]) -> dict[str, Any]:
            return {"projects": await self._client(params).projects()}

        @d.method("project.create")
        @_map_errors
        async def project_create(params: dict[str, Any]) -> dict[str, Any]:
            return await self._client(params).create_project(param(params, "project", str))

        @d.method("project.files")
        @_map_errors
        async def project_files(params: dict[str, Any]) -> dict[str, Any]:
            return await self._client(params).files(param(params, "project", str))

        @d.method("project.read")
        @_map_errors
        async def project_read(params: dict[str, Any]) -> dict[str, Any]:
            return await self._client(params).read_file(param(params, "project", str), _rel_path(params))

        @d.method("project.write")
        @_map_errors
        async def project_write(params: dict[str, Any]) -> dict[str, Any]:
            content = param(params, "content", str)
            if len(content) > MAX_FILE_CHARS:
                raise RpcError("rpc.too_large", "file exceeds %d characters" % MAX_FILE_CHARS)
            encoding = param(params, "encoding", str, default="utf-8")
            if encoding not in ("utf-8", "base64"):
                raise RpcError("rpc.bad_params", "encoding must be utf-8 or base64")
            return await self._client(params).write_file(param(params, "project", str), _rel_path(params), content, encoding,
                                                         param(params, "create", bool, default=False))

        @d.method("project.run")
        @_map_errors
        async def project_run(params: dict[str, Any]) -> dict[str, Any]:
            out = await self._client(params).run_project(param(params, "project", str))
            await self.devices.refresh(param(params, "id", str))  # push the new running/project state right away
            return out

        @d.method("project.stop")
        @_map_errors
        async def project_stop(params: dict[str, Any]) -> dict[str, Any]:
            out = await self._client(params).stop_project(param(params, "project", str))
            await self.devices.refresh(param(params, "id", str))
            return out

        @d.method("device.logs")
        @_map_errors
        async def device_logs(params: dict[str, Any]) -> dict[str, Any]:
            since = param(params, "since", int, default=0)
            if since < 0:
                raise RpcError("rpc.bad_params", "since must be >= 0")
            data = await self._client(params).logs(since)
            if not isinstance(data, dict):
                raise RpcError("device.protocol", "unexpected /logs response")
            entries = data.get("entries") or []
            return {"entries": entries, "next": data.get("next", since)}

        @d.method("device.action")
        @_map_errors
        async def device_action(params: dict[str, Any]) -> dict[str, Any]:
            kind = param(params, "type", str)
            if kind not in ACTION_TYPES:
                raise RpcError("rpc.bad_params", "action type must be one of %s" % ", ".join(ACTION_TYPES))
            payload: dict[str, Any] = {"type": kind}
            for k in ("x", "y", "x1", "y1", "x2", "y2", "dur"):
                if k in params and params[k] is not None:
                    payload[k] = param(params, k, (int, float))
            for k in ("text", "name"):
                if k in params and params[k] is not None:
                    payload[k] = param(params, k, str)
            return await self._client(params).action(payload)
