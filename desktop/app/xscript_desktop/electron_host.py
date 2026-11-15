"""Headless Electron sidecar. stdout is NDJSON exclusively; diagnostics go to stderr.

The private _host messages are only accepted from the Electron main process.
Renderer requests still pass through the existing RPC dispatcher.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .context import AppContext
from .rpc import event_json
from .services.secrets import KeyringBackend


class ElectronHost:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        self.pending: dict[str, asyncio.Future] = {}
        self.serial = 0
        self.tasks: set[asyncio.Task] = set()
        self.stopped = asyncio.Event()
        ctx.dispatcher.set_event_sink(lambda topic, data: self.write(json.loads(event_json(topic, data))))
        ctx.pick_directory = lambda *a: self.native("directory", *a)
        ctx.save_file = lambda *a: self.native("save", *a)
        ctx.open_file = lambda *a: self.native("open", *a)
        ctx.copy_text = lambda text: self.native("clipboard", text)
        ctx.embed_console = lambda origin: self.native("cloud.embed", origin)
        ctx.embed_tools = lambda *a: self.native("tools.embed", *a)
        ctx.open_tools = lambda *a: self.native("tools", *a)
        ctx.quit_app = lambda: self.write({"native": "quit", "args": []})

    @staticmethod
    def write(value: dict) -> None:
        sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    async def native(self, action: str, *args):
        self.serial += 1
        key = str(self.serial)
        fut = asyncio.get_running_loop().create_future()
        self.pending[key] = fut
        self.write({"native": action, "nativeId": key, "args": args})
        try:
            return await fut
        finally:
            self.pending.pop(key, None)

    async def resource(self, raw: str) -> dict:
        url = urlsplit(raw)
        prefix, _, name = url.path.lstrip("/").partition("/")
        device_id = unquote(name.removesuffix(".jpg"))
        if prefix not in ("_shot", "_cloudshot", "_frame") or not device_id or any(c in device_id for c in ("/", "\\", "\0")) or device_id in (".", ".."):
            raise ValueError("invalid media path")
        if prefix == "_frame":
            body, mime = self.ctx.mirror.latest(device_id), "image/jpeg"
            if not body:
                raise ValueError("frame unavailable")
        else:
            query = parse_qs(url.query)
            raw_size = query.get("max", ["480"])[0]
            size = None if prefix == "_shot" and raw_size == "native" else max(64, min(2400, int(raw_size)))
            quality = max(10, min(100, int(query.get("quality", ["60"])[0])))
            if prefix == "_shot" and query.get("format") == ["png"]:
                body, mime = await self.ctx.screen(device_id, size, 100, fmt="png")
            else:
                body, mime = await (self.ctx.cloud_thumb(device_id, size) if prefix == "_cloudshot" else self.ctx.screen(device_id, size, quality))
        return {"body": base64.b64encode(body).decode("ascii"), "mime": mime}

    async def handle(self, message: dict) -> None:
        if "nativeResult" in message:
            fut = self.pending.get(str(message["nativeResult"]))
            if fut and not fut.done():
                if message.get("error"):
                    fut.set_exception(RuntimeError(message["error"]))
                else:
                    fut.set_result(message.get("result"))
            return
        if message.get("_host"):
            key = message.get("id")
            try:
                if message["_host"] == "resource":
                    result = await self.resource(message["url"])
                elif message["_host"] == "update":
                    result = await self.ctx.updates.check()
                    if result["state"] == "available":
                        result = await self.ctx.updates.download()
                    if result["state"] == "ready":
                        result = await self.ctx.install_update()
                    if result["state"] == "error":
                        raise RuntimeError(result["error"]["message"])
                elif message["_host"] == "state":
                    result = {"unsaved": self.ctx.unsaved, "lang": self.ctx.ui_lang}
                elif message["_host"] == "shutdown":
                    self.stopped.set()
                    result = None
                else:
                    raise ValueError("unknown host command")
                self.write({"hostResult": key, "result": result})
            except Exception as e:
                logging.exception("host command failed")
                self.write({"hostResult": key, "error": str(e)})
            return
        response = await self.ctx.dispatcher.handle(json.dumps(message))
        if response:
            payload = json.loads(response)
            self.write(payload)
        if message.get("method") == "app.hello" and self.ctx.ui_ready.is_set() and not getattr(self, "connected_saved", False):
            self.connected_saved = True
            self.spawn(self.ctx.connect_saved())

    def spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def serve(self) -> None:
        queue: asyncio.Queue[str] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def stdin_reader():
            for line in sys.stdin:
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, line)
                except RuntimeError:
                    return
            try:
                loop.call_soon_threadsafe(queue.put_nowait, "")
            except RuntimeError:
                pass

        threading.Thread(target=stdin_reader, name="electron-stdin", daemon=True).start()

        async def read():
            while line := await queue.get():
                try:
                    message = json.loads(line)
                    if not isinstance(message, dict):
                        raise ValueError("expected object")
                    self.spawn(self.handle(message))
                except (ValueError, TypeError):
                    logging.exception("invalid host message")
            self.stopped.set()
        reader = asyncio.create_task(read())
        try:
            await self.stopped.wait()
        finally:
            reader.cancel()
            for task in list(self.tasks):
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            await self.ctx.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--memory-secrets", action="store_true", help="tests only: do not access the OS keychain")
    parser.add_argument("--electron-executable", type=Path)
    parser.add_argument("--electron-pid", type=int, default=0)
    parser.add_argument("--app-version")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    from .services.diagnostics import add_file_log
    add_file_log(args.data_dir)

    async def run():
        ctx = AppContext(data_dir=args.data_dir)
        from . import __version__
        from .services.electron_updater import ElectronUpdateService
        ctx.updates = ElectronUpdateService(args.app_version or __version__, ctx._update_dir, executable=args.electron_executable,
                                            parent_pid=args.electron_pid, platform=sys.platform, argv=["--data-dir", str(args.data_dir)])
        if not args.memory_secrets:
            ctx.secrets.backend = KeyringBackend()
        await ElectronHost(ctx).serve()
    asyncio.run(run())


if __name__ == "__main__":
    main()
