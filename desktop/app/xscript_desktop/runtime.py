"""A dedicated asyncio thread for the service layer (design §3.1 point 4: no qasync)."""
from __future__ import annotations

import asyncio
import concurrent.futures
import threading
from typing import Any, Awaitable, Callable


class AsyncRuntime:
    def __init__(self, name: str = "xscript-asyncio") -> None:
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self._closed = False

    def start(self) -> "AsyncRuntime":
        self._thread.start()
        self._ready.wait(5)
        return self

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.call_soon(self._ready.set)
        self._loop.run_forever()
        # drain: cancel what is left, then close
        pending = asyncio.all_tasks(self._loop)
        for t in pending:
            t.cancel()
        if pending:
            self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        self._loop.run_until_complete(self._loop.shutdown_asyncgens())
        self._loop.close()

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        return self._loop

    def submit(self, coro: Awaitable[Any]) -> "concurrent.futures.Future[Any]":
        return asyncio.run_coroutine_threadsafe(coro, self._loop)  # type: ignore[arg-type]

    def call_soon(self, fn: Callable[..., Any], *args: Any) -> None:
        self._loop.call_soon_threadsafe(fn, *args)

    def run(self, coro: Awaitable[Any], timeout: float | None = None) -> Any:
        """Run a coroutine on the service loop and block the calling (non-loop) thread for the result."""
        return self.submit(coro).result(timeout)

    def stop(self, timeout: float = 5.0) -> None:
        if self._closed:
            return
        self._closed = True
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout)
