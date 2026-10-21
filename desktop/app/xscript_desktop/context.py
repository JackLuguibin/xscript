"""AppContext: wires the services to the RPC dispatcher. No Qt imports here, so it is testable headless."""
from __future__ import annotations

import asyncio
import hashlib
import functools
import json
from pathlib import Path
import platform
import sys
import threading
import time
from typing import Any, Awaitable, Callable

from . import __version__
from .rpc import Dispatcher, RpcError, param
from .services.adb import AdbError, AdbService
from .services import backend_client
from .services.backend_client import BackendError, CloudService, _Settings
from .services.device_client import DeviceError, DeviceTarget, summarize_status
from .services.device_manager import LAN_WARNING, DeviceManager, DeviceRecord, lan_hosts
from .services import sync as syncmod
from .services.debugger import DebugError, DebugSession
from .services.mirror import MirrorProxy, MirrorTimings
from .services.secrets import MemoryBackend, NameIndex, SecretError, SecretStore
from .services.store import AppStore, SavedDevice, StoreError, StoreSyncCache
from .services.tool_pages import TITLES, paired_url, tool_url
from .services.updater import UpdateError, UpdateService
from .services import diagnostics

ACTION_TYPES = ("click", "swipe", "input", "key")
MAX_FILE_CHARS = 2 * 1024 * 1024  # stays under the bridge's 4 MiB request cap even after JSON escaping
MAX_EVAL_CHARS = 64 * 1024  # a step-run snippet is one node; anything bigger is a mistake
EVAL_TIMEOUT_MS = (200, 15000)  # openapi EvalRequest.timeout_ms bounds
AUTO_RECONNECT_KEY = "autoReconnect"  # settings row: "0" turns auto-reconnect off globally; absent / "1" = on (design §14.5)
SAVED_CONNECT_TIMEOUT = 20.0  # startup reconnect: per-device ceiling (they run in parallel, so one slow device blocks nobody)
SCAN_PROGRESS_EVERY = 0.25  # s between device.scan.progress events (a /24 scan is ~2500 probes)


def _rel_path(params: dict[str, Any], key: str = "path") -> str:
    """Same rules as the device (ProjectStore.resolve): relative, '/'-separated, no '.', '..' or empty segments."""
    rel = param(params, key, str)
    if not rel or rel.startswith("/") or "\\" in rel or "\0" in rel or any(p in ("", ".", "..") for p in rel.split("/")):
        raise RpcError("rpc.bad_params", "invalid project path: %r" % rel)
    return rel


class _KeychainPairing:
    """Device pairing codes in the OS keychain, as `device/<device id>` credential slots (design §5.2)."""

    def __init__(self, ctx: "AppContext") -> None:
        self._ctx = ctx

    def get(self, device_id: str) -> str:
        return self._ctx.secrets.reveal("device", device_id) or ""

    def put(self, device_id: str, code: str) -> None:
        self._ctx.secrets.set("device", device_id, code)


def error_code(e: BaseException) -> str:
    """The RPC error code of a service-layer failure (also put on offline device cards as `errorCode`)."""
    if isinstance(e, DeviceError):
        return e.code
    if isinstance(e, StoreError):
        return {"db.not_found": "device.not_found"}.get(e.code, e.code)
    code = getattr(e, "code", "")
    return code if isinstance(code, str) and code else "rpc.internal"


def _map_errors(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    @functools.wraps(fn)
    async def wrapper(params: dict[str, Any]) -> Any:
        try:
            return await fn(params)
        except DebugError as e:
            raise RpcError(e.code, e.message) from e
        except syncmod.SyncError as e:
            raise RpcError(e.code, e.message) from e
        except AdbError as e:
            raise RpcError(e.code, e.message, details=e.details) from e
        except DeviceError as e:
            raise RpcError(e.code, str(e), retryable=e.retryable, details={"status": e.status, "detail": e.detail}) from e
        except StoreError as e:
            raise RpcError(error_code(e), e.message) from e
        except SecretError as e:
            raise RpcError(e.code, e.message) from e
        except BackendError as e:
            raise RpcError(e.code, e.message, retryable=e.retryable, details={"status": e.status}) from e
        except KeyError as e:
            raise RpcError("device.not_found", "no such connected device: %s" % e.args[0]) from e
        except UpdateError as e:
            raise RpcError("update." + e.kind, str(e)) from e
        except ValueError as e:
            raise RpcError("rpc.bad_params", str(e)) from e

    return wrapper


class AppContext:
    def __init__(self, adb: AdbService | None = None, poll_interval: float = 5.0, data_dir: Path | None = None,
                 mirror_timings: MirrorTimings | None = None) -> None:
        self.dispatcher = Dispatcher()
        # set by the Qt shell (main.py): shows a native folder dialog on the GUI thread; None in headless/tests
        self.debug_sessions: dict[str, DebugSession] = {}
        self.debug_options: dict[str, Any] = {}  # tests shorten the poll intervals
        self.pick_directory: Callable[[str], Awaitable[str | None]] | None = None
        self.open_tools: Callable[[str, int, str, str], Awaitable[None]] | None = None
        self.save_file: Callable[[], Awaitable[str | None]] | None = None
        self.copy_text: Callable[[str], Awaitable[None]] | None = None
        self.adb = adb or AdbService()
        db_path = data_dir / "desktop.db" if data_dir else None
        legacy = data_dir / "sync-cache.json" if data_dir else None
        self.store = AppStore(db_path, legacy)
        self.sync_cache: Any = StoreSyncCache(self.store)  # tests may swap in the JSON SyncCache
        if self.adb._configured is None:
            saved_adb = self.store.get_setting("adbPath")
            if saved_adb:
                self.adb.set_path(saved_adb)
        self.devices = DeviceManager(self.adb, emit=self.dispatcher.emit, poll_interval=poll_interval, on_online=self._persist_seen,
                                     pairing=_KeychainPairing(self))
        self.mirror = MirrorProxy(self._mirror_client, self.dispatcher.emit, timings=mirror_timings)
        # Memory backend until main() swaps in the OS keyring. --selftest never touches the login keychain.
        self.secrets = SecretStore(MemoryBackend(), NameIndex(data_dir / "slot-index.json" if data_dir else None))
        # Admin backend for cloud control (P4): origin in settings, token in the keyring slot backend/<origin>.
        self.cloud = CloudService(self.secrets, _Settings(
            get=lambda k: self.store.aexec(self.store._get_setting, k),
            set=lambda k, v: self.store.aexec(self.store._set_setting, k, v),
            delete=lambda k: self.store.aexec(self.store._delete_setting, k)))
        # Desktop auto-update (P5.4). Downloads go to <data dir>/updates (a temp folder without a data dir).
        self._data_dir = data_dir
        self.updates = UpdateService(__version__, self._update_dir)
        # set by the Qt shell: quit the app from any thread (the update helper finishes once this process is gone)
        self.quit_app: Callable[[], None] | None = None
        self.ui_ready = threading.Event()
        # Set by the page (app.setUnsaved), read by MainWindow.closeEvent on the GUI thread: plain attribute writes.
        self.unsaved = False
        self.ui_lang = "zh"
        self._scans: dict[str, asyncio.Event] = {}  # scanId -> cancel flag of a running device.scan
        self._adb_ready: set[str] | None = None  # serials in state "device" at the last device.adb.list (None: no baseline yet)
        self._hotplug_tasks: set[asyncio.Task] = set()
        self._register()

    def _update_dir(self) -> Path:
        if self._data_dir is None:
            import tempfile

            self._data_dir_tmp = getattr(self, "_data_dir_tmp", None) or Path(tempfile.mkdtemp(prefix="xscript-updates-"))
            return self._data_dir_tmp
        return self._data_dir / "updates"

    async def diagnostics_info(self) -> dict[str, Any]:
        """What a bug report needs, without identifiers or secrets: versions, platform, counts and states."""
        try:
            from PySide6 import __version__ as pyside, QtCore
            qt = QtCore.qVersion()
        except Exception:  # noqa: BLE001 - pure-Python test runs
            pyside, qt = None, None
        devices = self.devices.list()
        states: dict[str, int] = {}
        for rec in devices:
            states[rec.state] = states.get(rec.state, 0) + 1
        try:
            saved = len(await self.store.aexec(self.store.list_devices))
        except Exception:  # noqa: BLE001
            saved = None
        origin = await self.cloud.origin() if self.cloud else None
        upd = self.updates.info()
        return {
            "app": {"version": __version__, "frozen": bool(getattr(sys, "frozen", False)), "install": str(self.updates.install_path or "")},
            "platform": {"os": sys.platform, "release": platform.release(), "machine": platform.machine(),
                         "python": platform.python_version(), "pyside6": pyside, "qt": qt},
            "adb": {"path": self.adb.path()},
            "devices": {"connected": len(devices), "states": states, "saved": saved},
            "cloud": {"configured": bool(origin)},
            "update": {k: upd.get(k) for k in ("platform", "configured", "feed", "state", "error", "canInstall")},
            "ui": {"lang": self.ui_lang, "unsaved": self.unsaved},
            "dataDir": str(self._data_dir) if self._data_dir else None,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }

    async def install_update(self) -> dict[str, Any]:
        """Stage the verified download, start the helper, then quit so it can swap/upgrade and relaunch."""
        if self.unsaved:
            raise RpcError("update.unsaved", "save or discard the open edits before installing the update")
        r = await asyncio.to_thread(self.updates.prepare_install)
        if self.quit_app:
            self.quit_app()
        return r

    def _mirror_client(self, device_id: str):
        return self.devices.get(device_id).client

    # ---- binary data for xsapp://shot/... (called from the scheme handler through the asyncio loop) -------------------------------

    async def screen(self, device_id: str, max_side: int | None = 480, quality: int = 60) -> tuple[bytes, str]:
        rec = self.devices.get(device_id)
        assert rec.client is not None
        try:
            return await rec.client.screen("jpg", quality, max_side)
        except DeviceError as e:
            raise e

    async def cloud_thumb(self, device_id: str, max_side: int = 480) -> tuple[bytes, str]:
        """Cloud device screenshot for xsapp://app/_cloudshot/<id>.jpg (the wall's binary path; never JSON over the bridge)."""
        return await backend_client.thumb(await self.cloud.client(), device_id, max_side)

    def _client(self, params: dict[str, Any]) -> Any:
        rec = self.devices.get(param(params, "id", str))
        if rec.client is None:
            raise RpcError("device.not_found", "device has no client: %s" % rec.id)
        return rec.client

    def _sync_key(self, params: dict[str, Any]) -> str:
        rec = self.devices.get(param(params, "id", str))
        return "%s:%s" % (rec.status.get("device_id") or rec.id, param(params, "project", str))

    @staticmethod
    def _local_dir(params: dict[str, Any], must_be_project: bool) -> Path:
        raw = param(params, "dir", str)
        p = Path(raw).expanduser()
        if not p.is_absolute():
            raise RpcError("rpc.bad_params", "local folder must be an absolute path: %s" % raw)
        if not p.is_dir():
            raise RpcError("sync.no_dir", "local folder does not exist: %s" % raw)
        if must_be_project and not syncmod.is_project_dir(p):
            raise RpcError("sync.not_project", "%s has no __init__.py (or build.as): pick the project folder itself" % raw)
        return p

    async def _plan(self, params: dict[str, Any]) -> tuple[Any, syncmod.UploadPlan]:
        root = self._local_dir(params, True)
        client = self._client(params)
        project = param(params, "project", str)
        full = param(params, "full", bool, default=False)
        files = await asyncio.to_thread(lambda: syncmod.collect_files(root, syncmod.load_ignore_rules(root)))
        remote = await client.files_or_none(project)
        return client, syncmod.plan_upload(files, remote, {} if full else self.sync_cache.get(self._sync_key(params)))

    async def _push_state(self, device_id: str) -> None:
        """After run/stop: re-read /status and push it (refresh only emits on online/offline changes, not on running/project)."""
        rec = await self.devices.refresh(device_id)
        self.dispatcher.emit("device.state", rec.to_dict())

    @staticmethod
    def _apply_saved(rec: DeviceRecord, saved: SavedDevice | None) -> None:
        if saved is None:
            return
        rec.saved_name, rec.group, rec.note = saved.name, saved.grp, saved.note
        rec.auto_connect, rec.sort_order, rec.saved = bool(saved.auto_connect), saved.sort_order, True

    @staticmethod
    def _saved_address(rec: DeviceRecord) -> str:
        """What goes in the devices.address column: adb serial or host:port. Never the forward port."""
        return rec.serial if rec.transport == "adb" else rec.target.address

    async def _remember(self, rec: DeviceRecord) -> None:
        # In-memory when there is no data dir (selftest and most tests): still saved for this process,
        # so disconnect leaves the offline card the same way a real desktop.db does.
        if self.store.read_only:
            saved = await self.store.aexec(self.store._get, rec.id)
            self._apply_saved(rec, saved)
            if saved is not None:
                self.dispatcher.emit("device.state", rec.to_dict())
            return
        auto = await self.auto_reconnect_enabled()  # a NEW row opts in to auto-reconnect while the global switch is on
        try:
            saved = await self.store.aexec(
                self.store._remember, rec.id, rec.transport, self._saved_address(rec),
                str(rec.status.get("device_id") or ""), str(rec.status.get("model") or ""), rec.last_seen or 0.0, auto)
        except StoreError as e:
            if e.code != "db.newer":
                raise
            return
        self._apply_saved(rec, saved)
        self.dispatcher.emit("device.state", rec.to_dict())

    async def _restore_after_failed_connect(self, dev_id: str, was_live: bool, err: BaseException) -> None:
        """connect_adb drops the previous session before probing. If that probe fails, put the card back."""
        if not dev_id or any(r.id == dev_id for r in self.devices.list()):
            return
        saved = None
        try:
            saved = await self.store.aexec(self.store._get, dev_id)
        except StoreError:
            saved = None
        if saved is not None:
            self.dispatcher.emit("device.state", self._offline_view(saved, str(err), error_code(err)))
        elif was_live:
            self.dispatcher.emit("device.removed", {"id": dev_id})

    async def _persist_seen(self, rec: DeviceRecord) -> None:
        if self.store.read_only:
            return
        try:
            await self.store.aexec(
                self.store._touch, rec.id, str(rec.status.get("device_id") or ""),
                str(rec.status.get("model") or ""), rec.last_seen or 0.0)
        except StoreError:
            return

    @staticmethod
    def _offline_view(saved: SavedDevice, error: str = "", code: str = "") -> dict[str, Any]:
        info = summarize_status({"name": saved.name, "model": saved.model, "device_id": saved.device_id})
        info.pop("capture", None)  # unknown until /status; a missing flag must not say capture was denied
        warning = ""
        if saved.transport == "lan":
            host = saved.address[1:saved.address.find("]")] if saved.address.startswith("[") else saved.address.rsplit(":", 1)[0]
            if not DeviceManager._is_loopback(host):
                warning = LAN_WARNING
        return {
            "id": saved.id, "transport": saved.transport, "address": saved.address,
            "serial": saved.address if saved.transport == "adb" else "", "forwardPort": 0,
            "state": "offline", "error": error, "errorCode": code if error else "", "warning": warning, "lastSeen": saved.last_seen or 0,
            "info": info, "status": {}, "name": saved.name, "group": saved.grp, "note": saved.note,
            "autoConnect": bool(saved.auto_connect), "sortOrder": saved.sort_order, "saved": True,
        }

    async def auto_reconnect_enabled(self) -> bool:
        """The global switch (settings `autoReconnect`): on unless the user turned it off."""
        try:
            return await self.store.aexec(self.store._get_setting, AUTO_RECONNECT_KEY) != "0"
        except StoreError:
            return True

    async def connect_saved(self, timeout: float = SAVED_CONNECT_TIMEOUT) -> list[dict[str, Any]]:
        """Reconnect the devices with auto_connect=1, all at once (design §14.5). Everyone else stays an offline card.

        Each device shows "connecting" right away and gets its own `timeout`, so one slow or dead device no longer
        holds up the rest (this used to be a serial loop with a ~10 s probe per device). Off when the user disabled
        auto-reconnect.
        """
        if not await self.auto_reconnect_enabled():
            return []
        rows = await self.store.aexec(self.store._auto_connect)

        async def one(row: SavedDevice) -> tuple[dict[str, Any], bool]:
            if row.transport not in ("adb", "lan"):
                view = self._offline_view(row, "暂不支持自动连接 %s" % row.transport, "device.unsupported")
                self.dispatcher.emit("device.state", view)
                return view, False
            self.dispatcher.emit("device.state", {**self._offline_view(row), "state": "connecting"})
            try:
                op = self.devices.connect_adb(row.address) if row.transport == "adb" else self.devices.connect_address(row.address)
                rec = await asyncio.wait_for(op, timeout)
                await self._remember(rec)
                return rec.to_dict(), True
            except asyncio.TimeoutError:
                view = self._offline_view(row, "自动连接 %s 超时（%.0f 秒）" % (row.address, timeout), "device.timeout")
            except (AdbError, DeviceError, StoreError) as e:
                view = self._offline_view(row, str(e), error_code(e))
            self.dispatcher.emit("device.state", view)
            return view, False

        results = await asyncio.gather(*(one(r) for r in rows))
        if any(live for _, live in results):
            self.devices.start_polling()
        return [view for view, _ in results]

    async def _connect(self, transport: str, target: str, local_port: int = 0) -> DeviceRecord:
        """device.connect and the ADB hotplug path: connect, put the card back on failure, remember, start polling."""
        if transport == "adb":
            dev_id, op = "adb:" + target, lambda: self.devices.connect_adb(target, local_port)
        elif transport == "lan":
            try:
                dev_id = "lan:" + DeviceTarget.parse(target).address
            except ValueError:
                dev_id = ""
            op = lambda: self.devices.connect_address(target)
        else:
            raise RpcError("rpc.bad_params", "unknown transport: %s" % transport)
        was_live = bool(dev_id) and any(r.id == dev_id for r in self.devices.list())
        try:
            rec = await op()
        except Exception as e:
            await self._restore_after_failed_connect(dev_id, was_live, e)
            raise
        await self._remember(rec)
        self.devices.start_polling()
        return rec

    async def _hotplug(self, devs: list[Any]) -> list[str]:
        """Called with every adb listing. A serial that just became ready ("device": plugged in, or USB debugging just
        allowed) and belongs to a saved auto-reconnect device gets connected in the background. The first listing
        only sets the baseline: at startup connect_saved already covers the devices that were plugged in.
        Returns the device ids it started connecting."""
        ready = {d.serial for d in devs if d.state == "device"}
        prev, self._adb_ready = self._adb_ready, ready
        if prev is None or not await self.auto_reconnect_enabled():
            return []
        started: list[str] = []
        for serial in sorted(ready - prev):
            dev_id = "adb:" + serial
            rec = self.devices._devices.get(dev_id)
            if rec is not None and rec.state != "offline":
                continue  # already connected (a replug with a stale forward shows up as offline and is reconnected)
            try:
                saved = await self.store.aexec(self.store._get, dev_id)
            except StoreError:
                continue
            if saved is None or not saved.auto_connect:
                continue
            self.dispatcher.emit("device.state", {**self._offline_view(saved), "state": "connecting"})
            task = asyncio.ensure_future(self._hotplug_connect(serial))
            self._hotplug_tasks.add(task)
            task.add_done_callback(self._hotplug_tasks.discard)
            started.append(dev_id)
        return started

    async def _hotplug_connect(self, serial: str) -> None:
        try:
            await self._connect("adb", serial)
        except Exception:
            pass  # _connect already put the offline card (with the mapped error) back

    def _debug(self, params: dict[str, Any]) -> DebugSession:
        sess = self.debug_sessions.get(param(params, "id", str))
        if sess is None or sess.state == "ended":
            raise RpcError("debug.no_session", "no active debug session on this device")
        return sess

    async def shutdown(self) -> None:
        for task in list(self._hotplug_tasks):
            task.cancel()
        for ev in self._scans.values():
            ev.set()
        try:
            await self.mirror.shutdown()  # close viewer slots before the device HTTP clients go away
        finally:
            for sess in list(self.debug_sessions.values()):
                try:
                    await sess.stop(terminate=False, quiet=True)
                except Exception:  # pragma: no cover - best effort at exit
                    pass
            self.debug_sessions.clear()
            await self.devices.shutdown()
            self.store.close()

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
            self.unsaved = False  # a (re)loaded page starts without edits
            return {"version": __version__, "platform": sys.platform, "adbPath": self.adb.path(), "methods": d.methods}

        @d.method("app.setUnsaved")
        def set_unsaved(params: dict[str, Any]) -> dict[str, Any]:
            """The page reports whether it holds unsaved edits; closing the window asks first while it does."""
            self.unsaved = param(params, "unsaved", bool)
            lang = param(params, "lang", str, default=self.ui_lang)
            self.ui_lang = lang if lang in ("zh", "en") else "zh"
            return {"unsaved": self.unsaved}

        @d.method("app.settings.set")
        @_map_errors
        async def set_settings(params: dict[str, Any]) -> dict[str, Any]:
            if "adbPath" in params:
                raw = param(params, "adbPath", str, default="") or ""
                self.adb.set_path(raw or None)
                if raw:
                    await self.store.aexec(self.store._set_setting, "adbPath", raw)
                else:
                    await self.store.aexec(self.store._delete_setting, "adbPath")
            if "autoReconnect" in params:
                on = param(params, "autoReconnect", bool)
                await self.store.aexec(self.store._set_setting, AUTO_RECONNECT_KEY, "1" if on else "0")
            return {"adbPath": self.adb.path(), "autoReconnect": await self.auto_reconnect_enabled()}

        @d.method("app.settings.get")
        @_map_errors
        async def get_settings(params: dict[str, Any]) -> dict[str, Any]:
            return {"adbPath": self.adb.path(), "autoReconnect": await self.auto_reconnect_enabled()}

        @d.method("device.adb.list")
        @_map_errors
        async def adb_list(params: dict[str, Any]) -> dict[str, Any]:
            devs = await self.adb.devices()
            started = await self._hotplug(devs)
            return {"adbPath": self.adb.path(), "devices": [x.to_dict() for x in devs], "autoConnecting": started}

        @d.method("device.connect")
        @_map_errors
        async def connect(params: dict[str, Any]) -> dict[str, Any]:
            transport = param(params, "transport", str)
            if transport == "adb":
                rec = await self._connect("adb", param(params, "serial", str), param(params, "localPort", int, default=0))
            elif transport == "lan":
                rec = await self._connect("lan", param(params, "address", str))
            else:
                raise RpcError("rpc.bad_params", "unknown transport: %s" % transport)
            return rec.to_dict()

        @d.method("device.check")
        @_map_errors
        async def check(params: dict[str, Any]) -> dict[str, Any]:
            """Step-by-step connection check for one adb serial or LAN address (does not connect)."""
            transport = param(params, "transport", str)
            if transport == "adb":
                return await self.devices.check("adb", param(params, "serial", str))
            if transport == "lan":
                return await self.devices.check("lan", param(params, "address", str))
            raise RpcError("rpc.bad_params", "unknown transport: %s" % transport)

        @d.method("device.list")
        async def list_devices(params: dict[str, Any]) -> dict[str, Any]:
            saved = await self.store.aexec(self.store._list_devices)
            live = {r.id: r for r in self.devices.list()}
            out: list[dict[str, Any]] = []
            seen: set[str] = set()
            for row in saved:
                seen.add(row.id)
                rec = live.get(row.id)
                if rec is not None:
                    self._apply_saved(rec, row)
                    out.append(rec.to_dict())
                else:
                    out.append(self._offline_view(row))
            for rec in self.devices.list():
                if rec.id not in seen:
                    out.append(rec.to_dict())
            return {"devices": out, "notice": self.store.notice, "noticeDetail": self.store.notice_detail}

        @d.method("flow.recordRun")
        @_map_errors
        async def flow_record_run(params: dict[str, Any]) -> dict[str, Any]:
            flow = param(params, "flow", str)
            nodes = params.get("nodes")
            if not isinstance(nodes, list) or not all(isinstance(n, dict) for n in nodes):
                raise RpcError("rpc.bad_params", "nodes must be a list of objects")
            started = float(params.get("startedAt") or params.get("started_at") or 0)
            ended = float(params.get("endedAt") or params.get("ended_at") or started)
            status = str(params.get("status") or "success")
            error_line = params.get("errorLine", params.get("error_line"))
            exit_code = params.get("exitCode", params.get("exit_code"))
            run_id = await self.store.aexec(
                self.store._record_run,
                flow,
                nodes,
                started,
                ended,
                status,
                str(params.get("project") or ""),
                str(params.get("deviceId") or params.get("device_id") or ""),
                str(params.get("errorNode") or params.get("error_node") or ""),
                None if error_line is None else int(error_line),
                None if exit_code is None else int(exit_code),
            )
            return {"id": run_id}

        @d.method("flow.listRuns")
        @_map_errors
        async def flow_list_runs(params: dict[str, Any]) -> dict[str, Any]:
            limit = int(params.get("limit") or 20)
            return {"runs": await self.store.aexec(self.store._list_runs, limit)}

        @d.method("device.pair")
        @_map_errors
        async def pair(params: dict[str, Any]) -> dict[str, Any]:
            """Pair with the code shown on the phone (开发与连接 → 配对码). The code goes to the keychain, never back out."""
            return (await self.devices.pair(param(params, "id", str), param(params, "code", str))).to_dict()

        @d.method("device.refresh")
        @_map_errors
        async def refresh(params: dict[str, Any]) -> dict[str, Any]:
            return (await self.devices.refresh(param(params, "id", str))).to_dict()

        @d.method("device.disconnect")
        @_map_errors
        async def disconnect(params: dict[str, Any]) -> dict[str, Any]:
            dev_id = param(params, "id", str)
            await self.mirror.close(dev_id)  # release the stream slot while the HTTP client still exists
            closed = await self.devices.disconnect(dev_id)
            saved = await self.store.aexec(self.store._get, dev_id)
            if saved is not None:
                view = self._offline_view(saved)  # the card stays; only the live connection is gone
                self.dispatcher.emit("device.state", view)
                return {"removed": closed, "device": view} if closed else {"removed": False}
            if closed:
                self.dispatcher.emit("device.removed", {"id": dev_id})
            return {"removed": closed}

        @d.method("device.update")
        @_map_errors
        async def update_device(params: dict[str, Any]) -> dict[str, Any]:
            dev_id = param(params, "id", str)
            fields: dict[str, Any] = {}
            if "name" in params:
                fields["name"] = param(params, "name", str)
            if "group" in params:
                fields["grp"] = param(params, "group", str)
            if "note" in params:
                fields["note"] = param(params, "note", str)
            if "autoConnect" in params:
                fields["auto_connect"] = param(params, "autoConnect", bool)
            if "sortOrder" in params:
                fields["sort_order"] = param(params, "sortOrder", int)
            if not fields:
                raise RpcError("rpc.bad_params", "nothing to update")
            saved = await self.store.aexec(self.store._update, dev_id, fields)
            rec = self.devices._devices.get(dev_id)
            if rec is not None:
                self._apply_saved(rec, saved)
                view = rec.to_dict()
            else:
                view = self._offline_view(saved)
            self.dispatcher.emit("device.state", view)
            return view

        @d.method("device.forget")
        @_map_errors
        async def forget_device(params: dict[str, Any]) -> dict[str, Any]:
            dev_id = param(params, "id", str)
            await self.mirror.close(dev_id)
            await self.devices.disconnect(dev_id)
            gone = await self.store.aexec(self.store._forget, dev_id)
            self.dispatcher.emit("device.removed", {"id": dev_id})
            return {"forgotten": gone}

        @d.method("device.scan")
        @_map_errors
        async def scan(params: dict[str, Any]) -> dict[str, Any]:
            hosts = params.get("hosts")
            if hosts is None:
                hosts = lan_hosts(param(params, "cidr", str, default=None))
            if not isinstance(hosts, list) or not all(isinstance(h, str) for h in hosts) or len(hosts) > 1024:
                raise RpcError("rpc.bad_params", "hosts must be a list of at most 1024 strings")
            # With a scanId the page gets device.scan.found per hit and throttled device.scan.progress, and can cancel.
            scan_id = param(params, "scanId", str, default="") or ""
            cancel = asyncio.Event()
            if scan_id:
                if scan_id in self._scans:
                    raise RpcError("rpc.bad_params", "scan already running: %s" % scan_id)
                self._scans[scan_id] = cancel
            last = [0.0]

            def progress(done: int, total: int) -> None:
                now = time.monotonic()
                if scan_id and (done == total or now - last[0] >= SCAN_PROGRESS_EVERY):
                    last[0] = now
                    self.dispatcher.emit("device.scan.progress", {"scanId": scan_id, "done": done, "total": total})

            def found(hit: dict[str, Any]) -> None:
                if scan_id:
                    self.dispatcher.emit("device.scan.found", {"scanId": scan_id, "device": hit})

            try:
                hits = await self.devices.scan(hosts, on_found=found, on_progress=progress, cancel=cancel)
            finally:
                self._scans.pop(scan_id, None)
            return {"found": hits, "cancelled": cancel.is_set(), "total": len(hosts)}

        @d.method("device.scan.cancel")
        def scan_cancel(params: dict[str, Any]) -> dict[str, Any]:
            ev = self._scans.get(param(params, "scanId", str))
            if ev is not None:
                ev.set()
            return {"cancelled": ev is not None}

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

        @d.method("project.search")
        @_map_errors
        async def project_search(params: dict[str, Any]) -> dict[str, Any]:
            from .services import project_search as ps

            try:
                pattern = ps.compile_query(param(params, "query", str), param(params, "regex", bool, default=False),
                                           param(params, "caseSensitive", bool, default=False))
            except ValueError as e:
                raise RpcError("rpc.bad_params", str(e)) from None
            project = param(params, "project", str)
            client = self._client(params)
            listing = await client.files(project)
            files = [f for f in listing["files"] if isinstance(f, dict) and isinstance(f.get("path"), str)]
            wanted = [f["path"] for f in files if ps.is_searchable(f["path"], f.get("size") or 0)]
            gate = asyncio.Semaphore(6)

            async def read(path: str) -> dict[str, Any] | None:
                async with gate:
                    try:
                        return await client.read_file(project, path)
                    except Exception:  # noqa: BLE001 - a file that cannot be read is skipped, not fatal
                        return None

            contents = await asyncio.gather(*(read(p) for p in wanted))
            matches: list[dict[str, Any]] = []
            searched = 0
            for path, got in zip(wanted, contents):
                if not got or got.get("encoding", "utf-8") != "utf-8" or not isinstance(got.get("content"), str):
                    continue
                searched += 1
                matches.extend(ps.search_text(path, got["content"], pattern, ps.MAX_MATCHES + 1 - len(matches)))
                if len(matches) > ps.MAX_MATCHES:
                    break
            truncated = len(matches) > ps.MAX_MATCHES
            return {"matches": matches[:ps.MAX_MATCHES], "filesSearched": searched,
                    "filesSkipped": len(files) - searched, "truncated": truncated}

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

        @d.method("project.deleteFile")
        @_map_errors
        async def project_delete_file(params: dict[str, Any]) -> dict[str, Any]:
            return await self._client(params).delete_file(param(params, "project", str), _rel_path(params),
                                                          param(params, "recursive", bool, default=False))

        @d.method("project.move")
        @_map_errors
        async def project_move(params: dict[str, Any]) -> dict[str, Any]:
            src, dst = _rel_path(params, "from"), _rel_path(params, "to")
            if src == dst:
                raise RpcError("rpc.bad_params", "source and target are the same")
            return await self._client(params).move(param(params, "project", str), src, dst)

        @d.method("project.run")
        @_map_errors
        async def project_run(params: dict[str, Any]) -> dict[str, Any]:
            out = await self._client(params).run_project(param(params, "project", str))
            await self._push_state(param(params, "id", str))
            return out

        @d.method("project.stop")
        @_map_errors
        async def project_stop(params: dict[str, Any]) -> dict[str, Any]:
            out = await self._client(params).stop_project(param(params, "project", str))
            await self._push_state(param(params, "id", str))
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

        @d.method("device.requestCapture")
        @_map_errors
        async def device_request_capture(params: dict[str, Any]) -> dict[str, Any]:
            """截图状态 → 在手机上授权: the phone shows the system screen-recording dialog (and a notification)."""
            return await self._client(params).request_capture()

        # ---- local folder sync (port of the VS Code extension's sync.ts) ------------------------------------------------------

        @d.method("device.eval")
        @_map_errors
        async def device_eval(params: dict[str, Any]) -> dict[str, Any]:
            """One short snippet in the device's `:eval` process (flow step-run). The answer is whatever the snippet put in `_result`."""
            code = param(params, "code", str)
            if not code.strip():
                raise RpcError("rpc.bad_params", "code must not be empty")
            if len(code) > MAX_EVAL_CHARS:
                raise RpcError("rpc.too_large", "code exceeds %d characters" % MAX_EVAL_CHARS)
            timeout = param(params, "timeoutMs", int, default=8000)
            if isinstance(timeout, bool) or not EVAL_TIMEOUT_MS[0] <= timeout <= EVAL_TIMEOUT_MS[1]:
                raise RpcError("rpc.bad_params", "timeoutMs must be between %d and %d" % EVAL_TIMEOUT_MS)
            r = await self._client(params).eval_python(code, timeout)
            return {"ok": bool(r.get("ok")), "result": str(r.get("result") or ""), "error": str(r.get("error") or "")}

        @d.method("app.pickDirectory")
        async def pick_directory(params: dict[str, Any]) -> dict[str, Any]:
            if self.pick_directory is None:
                raise RpcError("app.unavailable", "no folder dialog in this mode")
            return {"path": await self.pick_directory(param(params, "title", str, default=""))}

        @d.method("sync.preview")
        @_map_errors
        async def sync_preview(params: dict[str, Any]) -> dict[str, Any]:
            _, plan = await self._plan(params)
            return plan.summary()

        @d.method("sync.upload")
        @_map_errors
        async def sync_upload(params: dict[str, Any]) -> dict[str, Any]:
            client, plan = await self._plan(params)
            project = param(params, "project", str)
            sent = 0
            for chunk in syncmod.batches(plan.upload):
                await client.upload_files(project, [f.upload_body() for f in chunk])
                sent += len(chunk)
                self.dispatcher.emit("sync.progress", {"id": params["id"], "project": project, "sent": sent, "total": len(plan.upload)})
            self.sync_cache.put(self._sync_key(params), plan.hashes, plan.sizes)
            return dict(plan.summary(), uploaded=sent)

        @d.method("sync.pull")
        @_map_errors
        async def sync_pull(params: dict[str, Any]) -> dict[str, Any]:
            root = self._local_dir(params, False)
            client = self._client(params)
            project = param(params, "project", str)
            listing = await client.files_or_none(project)
            if listing is None:
                raise RpcError("sync.no_project", "project %s does not exist on the device" % project)
            pulled = [(f["path"], await client.read_raw(project, f["path"])) for f in listing if syncmod.safe_relative(str(f.get("path", "")))]
            diff = syncmod.diff_against_local(root, pulled)
            if param(params, "dryRun", bool, default=False):
                return dict(diff, written=0)
            written = await asyncio.to_thread(syncmod.write_pulled, root, pulled, diff)
            # what we just wrote equals the device: remember it so the next incremental upload skips it
            self.sync_cache.put(
                self._sync_key(params),
                {rel: hashlib.sha1(data).hexdigest() for rel, data in pulled},
                {rel: len(data) for rel, data in pulled},
            )
            return dict(diff, written=written)

        # ---- breakpoint debugging (/debug/*; port of ide/vscode-extension/src/dap.ts) --------------------------------------------

        _BP_KEYS = ("condition", "hitCondition", "logMessage")

        def _bp_item(n: Any) -> bool:
            if isinstance(n, int):
                return not isinstance(n, bool) and n > 0
            if not isinstance(n, dict) or not _bp_item(n.get("line")) or set(n) - {"line", *_BP_KEYS}:
                return False
            return all(n.get(k) is None or (isinstance(n[k], str) and len(n[k]) <= 1000) for k in _BP_KEYS)

        def _bp_map(raw: Any) -> dict[str, list[Any]]:
            """{path: [line | {line, condition?, hitCondition?, logMessage?}]}; plain line lists stay valid."""
            if raw is None:
                return {}
            if not isinstance(raw, dict):
                raise RpcError("rpc.bad_params", "breakpoints must be {path: [lines]}")
            out: dict[str, list[Any]] = {}
            for rel, lines in raw.items():
                _rel_path({"path": rel})
                if not isinstance(lines, list) or not all(_bp_item(n) for n in lines):
                    raise RpcError("rpc.bad_params", "breakpoints must be positive line numbers or {line, condition, hitCondition, logMessage}")
                out[rel] = lines
            return out

        @d.method("debug.start")
        @_map_errors
        async def debug_start(params: dict[str, Any]) -> dict[str, Any]:
            dev_id = param(params, "id", str)
            old = self.debug_sessions.get(dev_id)
            if old is not None and old.state != "ended":
                raise RpcError("debug.already", "a debug session is already active on this device")
            bps = _bp_map(params.get("breakpoints"))
            sess = DebugSession(dev_id, self._client(params), param(params, "project", str), self.dispatcher.emit, **self.debug_options)
            self.debug_sessions[dev_id] = sess
            out = await sess.start(bps)
            await self._push_state(dev_id)
            return out

        @d.method("debug.status")
        def debug_status(params: dict[str, Any]) -> dict[str, Any]:
            sess = self.debug_sessions.get(param(params, "id", str))
            return sess.snapshot() if sess else {"id": params["id"], "state": "idle", "frames": []}

        @d.method("debug.setBreakpoints")
        @_map_errors
        async def debug_set_breakpoints(params: dict[str, Any]) -> dict[str, Any]:
            rel = _rel_path(params)
            lines = _bp_map({rel: params.get("lines") or []})[rel]
            return {"breakpoints": await self._debug(params).set_breakpoints(rel, lines)}

        @d.method("debug.step")
        @_map_errors
        async def debug_step(params: dict[str, Any]) -> dict[str, Any]:
            await self._debug(params).step(param(params, "command", str))
            return {"ok": True}

        @d.method("debug.scopes")
        @_map_errors
        async def debug_scopes(params: dict[str, Any]) -> dict[str, Any]:
            return {"scopes": await self._debug(params).scopes(param(params, "frameId", int))}

        @d.method("debug.variables")
        @_map_errors
        async def debug_variables(params: dict[str, Any]) -> dict[str, Any]:
            ref = param(params, "ref", int)
            if ref <= 0:
                raise RpcError("rpc.bad_params", "ref must be > 0")
            return {"variables": await self._debug(params).variables(ref)}

        @d.method("debug.evaluate")
        @_map_errors
        async def debug_evaluate(params: dict[str, Any]) -> dict[str, Any]:
            return await self._debug(params).evaluate(param(params, "expression", str), param(params, "frameId", int, default=None),
                                                      param(params, "context", str, default="repl"))

        @d.method("debug.stop")
        @_map_errors
        async def debug_stop(params: dict[str, Any]) -> dict[str, Any]:
            dev_id = param(params, "id", str)
            sess = self.debug_sessions.get(dev_id)
            if sess is None:
                return {"stopped": False}
            await sess.stop(terminate=param(params, "terminate", bool, default=True))
            try:
                await self._push_state(dev_id)
            except Exception:
                pass
            return {"stopped": True}

        # ---- mirror (one MJPEG upstream per device; design §14.4) ------------------------------------------------------------

        @d.method("mirror.subscribe")
        @_map_errors
        async def mirror_subscribe(params: dict[str, Any]) -> dict[str, Any]:
            dev_id = param(params, "id", str)
            self.devices.get(dev_id)  # KeyError -> device.not_found; don't open a stream for an unknown id
            return await self.mirror.subscribe(dev_id, param(params, "viewer", str, default="mirror"),
                                               params.get("fps"), params.get("scale"), params.get("quality"))

        @d.method("mirror.unsubscribe")
        @_map_errors
        async def mirror_unsubscribe(params: dict[str, Any]) -> dict[str, Any]:
            return await self.mirror.unsubscribe(param(params, "id", str), param(params, "viewer", str, default="mirror"))

        @d.method("mirror.retry")
        @_map_errors
        async def mirror_retry(params: dict[str, Any]) -> dict[str, Any]:
            return await self.mirror.retry(param(params, "id", str))

        # ---- credentials (design §5.2). The value is never part of the result. ---------------------------------------------

        @d.method("secret.list")
        @_map_errors
        async def secret_list(params: dict[str, Any]) -> dict[str, Any]:
            return await asyncio.to_thread(self.secrets.list_slots)

        @d.method("secret.set")
        @_map_errors
        async def secret_set(params: dict[str, Any]) -> dict[str, Any]:
            return await asyncio.to_thread(self.secrets.set, param(params, "kind", str), param(params, "name", str), param(params, "value", str))

        @d.method("secret.delete")
        @_map_errors
        async def secret_delete(params: dict[str, Any]) -> dict[str, Any]:
            return await asyncio.to_thread(self.secrets.delete, param(params, "kind", str), param(params, "name", str))

        @d.method("secret.has")
        @_map_errors
        async def secret_has(params: dict[str, Any]) -> dict[str, Any]:
            return await asyncio.to_thread(self.secrets.has, param(params, "kind", str), param(params, "name", str))

        # ---- cloud control: the admin backend (P4). The token goes in once and never comes back out. -----------------------

        @d.method("cloud.status")
        @_map_errors
        async def cloud_status(params: dict[str, Any]) -> dict[str, Any]:
            return await self.cloud.status()

        @d.method("cloud.connect")
        @_map_errors
        async def cloud_connect(params: dict[str, Any]) -> dict[str, Any]:
            return await self.cloud.connect(param(params, "origin", str), param(params, "token", str))

        @d.method("cloud.devices")
        @_map_errors
        async def cloud_devices(params: dict[str, Any]) -> dict[str, Any]:
            online = params.get("online")
            if online is not None and not isinstance(online, bool):
                raise RpcError("rpc.bad_params", "parameter online has the wrong type")
            return await backend_client.list_devices(
                await self.cloud.client(), q=param(params, "q", str, default=""), group=param(params, "group", str, default=""),
                app=param(params, "app", str, default=""), online=online, page=param(params, "page", int, default=1),
                page_size=param(params, "pageSize", int, default=50))

        @d.method("cloud.groups")
        @_map_errors
        async def cloud_groups(params: dict[str, Any]) -> dict[str, Any]:
            c = await self.cloud.client()
            return {"groups": await backend_client.list_groups(c), "apps": await backend_client.list_apps(c)}

        @d.method("cloud.command")
        @_map_errors
        async def cloud_command(params: dict[str, Any]) -> dict[str, Any]:
            ids = param(params, "ids", list)
            return await backend_client.batch_command(
                await self.cloud.client(), ids, param(params, "action", str), param(params, "project", str, default=""),
                param(params, "param", dict, default=None))

        @d.method("cloud.logs")
        @_map_errors
        async def cloud_logs(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.device_logs(
                await self.cloud.client(), param(params, "id", str), q=param(params, "q", str, default=""),
                stream=param(params, "stream", str, default=""), before=param(params, "before", int, default=0),
                limit=param(params, "limit", int, default=300))

        @d.method("cloud.tasks")
        @_map_errors
        async def cloud_tasks(params: dict[str, Any]) -> dict[str, Any]:
            return {"tasks": await backend_client.list_tasks(await self.cloud.client())}

        @d.method("cloud.taskCreate")
        @_map_errors
        async def cloud_task_create(params: dict[str, Any]) -> dict[str, Any]:
            every = param(params, "every", (int, float), default=None)
            return await backend_client.create_task(
                await self.cloud.client(), name=param(params, "name", str, default=""), target=param(params, "target", str),
                path=param(params, "path", str), project=param(params, "project", str, default=""),
                daily=param(params, "daily", str, default=""), every=None if every is None else float(every),
                enabled=param(params, "enabled", bool, default=True))

        @d.method("cloud.taskUpdate")
        @_map_errors
        async def cloud_task_update(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.update_task(await self.cloud.client(), param(params, "id", int),
                                                    enabled=param(params, "enabled", bool, default=None),
                                                    name=param(params, "name", str, default=None))

        @d.method("cloud.taskRun")
        @_map_errors
        async def cloud_task_run(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.run_task(await self.cloud.client(), param(params, "id", int))

        @d.method("cloud.taskDelete")
        @_map_errors
        async def cloud_task_delete(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.delete_task(await self.cloud.client(), param(params, "id", int))

        @d.method("cloud.flowVersions")
        @_map_errors
        async def cloud_flow_versions(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.flow_versions(await self.cloud.client(), param(params, "project", str))

        @d.method("cloud.flowDeploy")
        @_map_errors
        async def cloud_flow_deploy(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.deploy_flow(
                await self.cloud.client(), project=param(params, "project", str), files=param(params, "files", list),
                group=param(params, "group", str), version=param(params, "version", str, default=""),
                notes=param(params, "notes", str, default=""), run=param(params, "run", bool, default=True))

        @d.method("cloud.flowRollback")
        @_map_errors
        async def cloud_flow_rollback(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.rollback_flow(
                await self.cloud.client(), script_id=param(params, "scriptId", int), version_id=param(params, "versionId", int),
                group=param(params, "group", str), run=param(params, "run", bool, default=True))

        @d.method("app.diagnostics")
        @_map_errors
        async def app_diagnostics(params: dict[str, Any]) -> dict[str, Any]:
            """Ask where to save, then write a zip with redacted info.json + the app's logs (P5.5). Nothing is uploaded."""
            if self.save_file is None:
                raise RpcError("app.unavailable", "no save dialog in this mode")
            name = "xscript-diagnostics-%s.zip" % time.strftime("%Y%m%d-%H%M")
            chosen = await self.save_file("导出诊断包" if self.ui_lang == "zh" else "Export diagnostics", name, "Zip (*.zip)")
            if not chosen:
                return {"saved": False}
            data, files = await asyncio.to_thread(diagnostics.build, await self.diagnostics_info(),
                                                  diagnostics.log_files(self._data_dir))
            dest = Path(chosen)
            if dest.suffix.lower() != ".zip":
                dest = dest.with_suffix(".zip")
            await asyncio.to_thread(dest.write_bytes, data)
            return {"saved": True, "path": str(dest), "bytes": len(data), "files": files}

        @d.method("update.info")
        def update_info(params: dict[str, Any]) -> dict[str, Any]:
            """Version, platform, whether a trusted update key and feed are configured, and the current update state."""
            return self.updates.info()

        @d.method("update.status")
        def update_status(params: dict[str, Any]) -> dict[str, Any]:
            return self.updates.status()

        @d.method("update.check")
        @_map_errors
        async def update_check(params: dict[str, Any]) -> dict[str, Any]:
            return await self.updates.check()

        @d.method("update.download")
        @_map_errors
        async def update_download(params: dict[str, Any]) -> dict[str, Any]:
            return await self.updates.download()

        @d.method("update.install")
        @_map_errors
        async def update_install(params: dict[str, Any]) -> dict[str, Any]:
            """Only after the user confirmed in the UI: the app quits and restarts as the new version."""
            return await self.install_update()

        @d.method("cloud.console")
        @_map_errors
        async def cloud_console(params: dict[str, Any]) -> dict[str, Any]:
            origin = await self.cloud.origin()
            if not origin:
                raise BackendError("backend.not_configured", "还没有连接后台")
            return {"links": backend_client.console_links(origin)}

        @d.method("cloud.packJobs")
        @_map_errors
        async def cloud_pack_jobs(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.pack_jobs(await self.cloud.client(), param(params, "page", int, default=1))

        @d.method("cloud.packLog")
        @_map_errors
        async def cloud_pack_log(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.pack_log(await self.cloud.client(), param(params, "id", int), param(params, "offset", int, default=0))

        @d.method("cloud.packCancel")
        @_map_errors
        async def cloud_pack_cancel(params: dict[str, Any]) -> dict[str, Any]:
            return await backend_client.pack_cancel(await self.cloud.client(), param(params, "id", int))

        @d.method("cloud.packSave")
        @_map_errors
        async def cloud_pack_save(params: dict[str, Any]) -> dict[str, Any]:
            if self.save_file is None:
                raise RpcError("app.unavailable", "no save dialog in this mode")
            job_id = param(params, "id", int)
            name = param(params, "name", str, default="") or "xscript-%d.apk" % job_id
            name = "".join(ch for ch in name if ch.isalnum() or ch in "._-") or "xscript.apk"
            chosen = await self.save_file("保存 APK", name if name.endswith(".apk") else name + ".apk", "APK (*.apk)")
            if not chosen:
                return {"saved": False}
            data = await backend_client.pack_apk(await self.cloud.client(), job_id)
            dest = Path(chosen)
            if dest.suffix.lower() != ".apk":
                dest = dest.with_suffix(".apk")
            await asyncio.to_thread(dest.write_bytes, data)
            return {"saved": True, "path": str(dest), "bytes": len(data)}

        @d.method("cloud.disconnect")
        @_map_errors
        async def cloud_disconnect(params: dict[str, Any]) -> dict[str, Any]:
            return await self.cloud.disconnect()

        @d.method("app.copyText")
        async def copy_text(params: dict[str, Any]) -> dict[str, Any]:
            text = param(params, "text", str)
            if text == "" or "\0" in text or len(text) > 16_000:
                raise RpcError("rpc.bad_params", "clipboard text must be 1–16000 characters")
            if self.copy_text is None:
                raise RpcError("app.unavailable", "no clipboard in this mode")
            await self.copy_text(text)
            return {"ok": True}

        # ---- device tools window, inspector, color, screenshot (design §11.1, §12.1) ----------------------------------------

        @d.method("tools.open")
        @_map_errors
        async def tools_open(params: dict[str, Any]) -> dict[str, Any]:
            page = param(params, "page", str, default="home")
            rec = self.devices.get(param(params, "id", str))
            if rec.state == "unpaired":
                raise RpcError("device.unpaired", "设备需要配对码，配对后才能打开工具页")
            if rec.state != "online" or rec.client is None:
                raise RpcError("tools.offline", "设备不在线，打不开工具页")
            if rec.transport not in ("adb", "lan"):
                raise RpcError("tools.no_direct", "这种连接没有本机地址，打不开设备上的工具页")
            try:
                url = tool_url(rec.target.host, rec.target.port, page)
            except ValueError as e:
                raise RpcError("rpc.bad_params", str(e)) from e
            if self.open_tools is None:
                raise RpcError("app.unavailable", "no tool window in this mode")
            # The tool window is its own browser profile: pass the pairing code once through /pair, which sets the
            # device's SameSite cookie and redirects to the page. The plain URL is what goes back to the page.
            load = paired_url(url, rec.client.token)
            await self.open_tools(rec.target.host, rec.target.port, load, TITLES.get(page, "XScript"))
            return {"url": url, "page": page, "warning": rec.warning}

        @d.method("device.uiTree")
        @_map_errors
        async def device_ui_tree(params: dict[str, Any]) -> dict[str, Any]:
            mode = param(params, "mode", int, default=0)
            if mode not in (0, 1):
                raise RpcError("rpc.bad_params", "mode must be 0 or 1")
            data = await self._client(params).ui_tree(mode)
            if len(json.dumps(data)) > 1_500_000:
                raise RpcError("rpc.too_large", "控件树太大")
            return data

        @d.method("device.pixel")
        @_map_errors
        async def device_pixel(params: dict[str, Any]) -> dict[str, Any]:
            x, y = param(params, "x", int), param(params, "y", int)
            if x < 0 or y < 0 or x > 20000 or y > 20000:
                raise RpcError("rpc.bad_params", "pixel coordinates are out of range")
            client = self._client(params)
            snap = await client.capture_snapshot()
            out = await client.vision_pixel(str(snap["id"]), x, y)
            color = out.get("color")
            if not isinstance(color, str) or len(color) != 7 or not color.startswith("#"):
                color = None
            return {"color": color, "x": x, "y": y}

        @d.method("device.saveScreenshot")
        @_map_errors
        async def device_save_screenshot(params: dict[str, Any]) -> dict[str, Any]:
            if self.save_file is None:
                raise RpcError("app.unavailable", "no save dialog in this mode")
            chosen = await self.save_file()
            if not chosen:
                return {"saved": False}
            data, _ctype = await self._client(params).screen("png", 95, None)
            if not data.startswith(b"\x89PNG"):
                raise RpcError("device.protocol", "screenshot was not a PNG")
            dest = Path(chosen)
            if dest.suffix.lower() != ".png":
                dest = dest.with_suffix(".png")
            await asyncio.to_thread(dest.write_bytes, data)
            return {"saved": True, "path": str(dest), "bytes": len(data)}
