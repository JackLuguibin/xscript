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
from typing import Any, Awaitable, Callable

from . import __version__
from .rpc import Dispatcher, RpcError, param
from .services.adb import AdbError, AdbService
from .services.device_client import DeviceError, DeviceTarget, summarize_status
from .services.device_manager import LAN_WARNING, DeviceManager, DeviceRecord, lan_hosts
from .services import sync as syncmod
from .services.debugger import DebugError, DebugSession
from .services.mirror import MirrorProxy, MirrorTimings
from .services.secrets import MemoryBackend, NameIndex, SecretError, SecretStore
from .services.store import AppStore, SavedDevice, StoreError, StoreSyncCache
from .services.tool_pages import TITLES, tool_url

ACTION_TYPES = ("click", "swipe", "input", "key")
MAX_FILE_CHARS = 2 * 1024 * 1024  # stays under the bridge's 4 MiB request cap even after JSON escaping


def _rel_path(params: dict[str, Any], key: str = "path") -> str:
    """Same rules as the device (ProjectStore.resolve): relative, '/'-separated, no '.', '..' or empty segments."""
    rel = param(params, key, str)
    if not rel or rel.startswith("/") or "\\" in rel or "\0" in rel or any(p in ("", ".", "..") for p in rel.split("/")):
        raise RpcError("rpc.bad_params", "invalid project path: %r" % rel)
    return rel


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
        except KeyError as e:
            raise RpcError("device.not_found", "no such connected device: %s" % e.args[0]) from e
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
        self.devices = DeviceManager(self.adb, emit=self.dispatcher.emit, poll_interval=poll_interval, on_online=self._persist_seen)
        self.mirror = MirrorProxy(self._mirror_client, self.dispatcher.emit, timings=mirror_timings)
        # Memory backend until main() swaps in the OS keyring. --selftest never touches the login keychain.
        self.secrets = SecretStore(MemoryBackend(), NameIndex(data_dir / "slot-index.json" if data_dir else None))
        self.ui_ready = threading.Event()
        # Set by the page (app.setUnsaved), read by MainWindow.closeEvent on the GUI thread: plain attribute writes.
        self.unsaved = False
        self.ui_lang = "zh"
        self._register()

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
        try:
            saved = await self.store.aexec(
                self.store._remember, rec.id, rec.transport, self._saved_address(rec),
                str(rec.status.get("device_id") or ""), str(rec.status.get("model") or ""), rec.last_seen or 0.0)
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

    async def connect_saved(self) -> list[dict[str, Any]]:
        """Connect devices with auto_connect=1. Everyone else stays an offline card (design §14.5)."""
        rows = await self.store.aexec(self.store._auto_connect)
        out: list[dict[str, Any]] = []
        any_live = False
        for row in rows:
            try:
                if row.transport == "adb":
                    rec = await self.devices.connect_adb(row.address)
                elif row.transport == "lan":
                    rec = await self.devices.connect_address(row.address)
                else:
                    view = self._offline_view(row, "暂不支持自动连接 %s" % row.transport, "device.unsupported")
                    self.dispatcher.emit("device.state", view)
                    out.append(view)
                    continue
                await self._remember(rec)
                any_live = True
                out.append(rec.to_dict())
            except (AdbError, DeviceError, StoreError) as e:
                view = self._offline_view(row, str(e), error_code(e))
                self.dispatcher.emit("device.state", view)
                out.append(view)
        if any_live:
            self.devices.start_polling()
        return out

    def _debug(self, params: dict[str, Any]) -> DebugSession:
        sess = self.debug_sessions.get(param(params, "id", str))
        if sess is None or sess.state == "ended":
            raise RpcError("debug.no_session", "no active debug session on this device")
        return sess

    async def shutdown(self) -> None:
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
                serial = param(params, "serial", str)
                dev_id, op = "adb:" + serial, lambda: self.devices.connect_adb(serial, param(params, "localPort", int, default=0))
            elif transport == "lan":
                address = param(params, "address", str)
                try:
                    dev_id = "lan:" + DeviceTarget.parse(address).address
                except ValueError:
                    dev_id = ""
                op = lambda: self.devices.connect_address(address)
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
            return rec.to_dict()

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

        @d.method("project.deleteFile")
        @_map_errors
        async def project_delete_file(params: dict[str, Any]) -> dict[str, Any]:
            return await self._client(params).delete_file(param(params, "project", str), _rel_path(params))

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

        # ---- local folder sync (port of the VS Code extension's sync.ts) ------------------------------------------------------

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

        def _bp_map(raw: Any) -> dict[str, list[int]]:
            if raw is None:
                return {}
            if not isinstance(raw, dict):
                raise RpcError("rpc.bad_params", "breakpoints must be {path: [lines]}")
            out: dict[str, list[int]] = {}
            for rel, lines in raw.items():
                _rel_path({"path": rel})
                if not isinstance(lines, list) or not all(isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in lines):
                    raise RpcError("rpc.bad_params", "breakpoint lines must be positive integers")
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
            return await self._debug(params).evaluate(param(params, "expression", str), param(params, "frameId", int, default=None))

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
            await self.open_tools(rec.target.host, rec.target.port, url, TITLES.get(page, "XScript"))
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
