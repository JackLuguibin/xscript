"""The single QWebChannel object (registered as "xs"): one slot in, one signal out (design §3.3).

JS side:   xs.call(JSON.stringify({id, method, params}));   xs.message.connect(json => ...)
Every request is handled on the asyncio thread; replies and pushed events come back through `message`.
"""
from __future__ import annotations

import logging

from PySide6.QtCore import QObject, Qt, Signal, Slot

from .context import AppContext
from .rpc import RpcError, event_json
from .runtime import AsyncRuntime

log = logging.getLogger("xscript_desktop.bridge")


class Bridge(QObject):
    message = Signal(str)  # JSON: response {id, ok, ...} or event {event: true, topic, data}
    _deliver = Signal(str)  # emitted from the asyncio thread; queued onto the GUI thread

    def __init__(self, ctx: AppContext, runtime: AsyncRuntime, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._ctx = ctx
        self._runtime = runtime
        self._deliver.connect(self.message, Qt.ConnectionType.QueuedConnection)
        ctx.dispatcher.set_event_sink(lambda topic, data: self._deliver.emit(event_json(topic, data)))

    @Slot(str)
    def call(self, request_json: str) -> None:
        fut = self._runtime.submit(self._ctx.dispatcher.handle(request_json))
        fut.add_done_callback(self._finished)

    def _finished(self, fut) -> None:  # runs on the asyncio thread
        try:
            resp = fut.result()
        except Exception as e:  # cancelled at shutdown, or a bug in the dispatcher itself
            log.warning("rpc future failed: %r", e)
            resp = RpcErrorResponse(e)
        if resp:
            self._deliver.emit(resp)


def RpcErrorResponse(e: BaseException) -> str:
    import json

    return json.dumps({"id": None, "ok": False, "error": RpcError("rpc.internal", repr(e)).to_dict()})
