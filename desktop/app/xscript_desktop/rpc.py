"""JSON-RPC style dispatcher behind the QWebChannel bridge (docs/桌面端设计.md §3.3).

Pure Python (no Qt) so it can be unit-tested without a display.

Wire format
    request   {"id": <int|str>, "method": "device.list", "params": {...}}
    response  {"id": <same>, "ok": true,  "result": ...}
              {"id": <same>, "ok": false, "error": {"code", "message", "retryable", "details"}}
    event     {"event": true, "topic": "device.state", "data": ...}     (pushed, no id)
    cancel    {"method": "cancel", "params": {"id": <request id>}}      (no response)
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
from typing import Any, Awaitable, Callable

log = logging.getLogger("xscript_desktop.rpc")

MAX_REQUEST_BYTES = 4 * 1024 * 1024  # the bridge carries small JSON only; bulk data uses xsapp:// (design §3.1)

Handler = Callable[[dict[str, Any]], Any]
EventSink = Callable[[str, Any], None]


class RpcError(Exception):
    """An error that is reported to the frontend as {code, message, retryable, details}."""

    def __init__(self, code: str, message: str, *, retryable: bool = False, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable, "details": self.details}


class Dispatcher:
    def __init__(self) -> None:
        self._methods: dict[str, Handler] = {}
        self._tasks: dict[Any, asyncio.Task] = {}
        self._sink: EventSink | None = None

    # ---- registration -------------------------------------------------------------------------------------------

    def method(self, name: str) -> Callable[[Handler], Handler]:
        def deco(fn: Handler) -> Handler:
            if name in self._methods:
                raise ValueError("duplicate rpc method: " + name)
            self._methods[name] = fn
            return fn

        return deco

    def register(self, name: str, fn: Handler) -> None:
        self.method(name)(fn)

    @property
    def methods(self) -> list[str]:
        return sorted(self._methods)

    # ---- events ---------------------------------------------------------------------------------------------------

    def set_event_sink(self, sink: EventSink | None) -> None:
        self._sink = sink

    def emit(self, topic: str, data: Any = None) -> None:
        if self._sink is not None:
            try:
                self._sink(topic, data)
            except Exception:  # an event must never break the producer
                log.exception("event sink failed for %s", topic)

    # ---- request handling ---------------------------------------------------------------------------------------------

    async def handle(self, raw: str) -> str | None:
        """Process one request. Returns the response JSON, or None for cancel/notifications."""
        if len(raw.encode("utf-8", "replace")) > MAX_REQUEST_BYTES:
            return _err(None, RpcError("rpc.too_large", "request exceeds %d bytes" % MAX_REQUEST_BYTES))
        try:
            req = json.loads(raw)
        except ValueError as e:
            return _err(None, RpcError("rpc.parse", "invalid JSON: %s" % e))
        if not isinstance(req, dict):
            return _err(None, RpcError("rpc.invalid", "request must be an object"))
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params")
        if params is None:
            params = {}
        if not isinstance(method, str) or not isinstance(params, dict):
            return _err(rid, RpcError("rpc.invalid", "method must be a string and params an object"))
        if method == "cancel":
            target = params.get("id")
            task = self._tasks.get(target)
            if task is not None and not task.done():
                task.cancel()
            return None
        fn = self._methods.get(method)
        if fn is None:
            return _err(rid, RpcError("rpc.method_not_found", "unknown method: " + method))
        task = asyncio.ensure_future(self._call(fn, params))
        if rid is not None:
            self._tasks[rid] = task
        try:
            result = await task
            return _ok(rid, result)
        except asyncio.CancelledError:
            if task.cancelled():  # cancelled through the `cancel` method (not by shutting the loop down)
                return _err(rid, RpcError("rpc.cancelled", "cancelled"))
            raise
        except RpcError as e:
            return _err(rid, e)
        except Exception as e:  # programming error: do not leak a traceback to the page, but log it
            log.exception("rpc %s failed", method)
            return _err(rid, RpcError("rpc.internal", "%s: %s" % (type(e).__name__, e)))
        finally:
            if rid is not None:
                self._tasks.pop(rid, None)

    @staticmethod
    async def _call(fn: Handler, params: dict[str, Any]) -> Any:
        out = fn(params)
        if inspect.isawaitable(out):
            out = await out
        return out


def _ok(rid: Any, result: Any) -> str:
    return json.dumps({"id": rid, "ok": True, "result": result}, ensure_ascii=False, default=_default)


def _err(rid: Any, e: RpcError) -> str:
    return json.dumps({"id": rid, "ok": False, "error": e.to_dict()}, ensure_ascii=False, default=_default)


def event_json(topic: str, data: Any) -> str:
    return json.dumps({"event": True, "topic": topic, "data": data}, ensure_ascii=False, default=_default)


def _default(o: Any) -> Any:
    if hasattr(o, "to_dict"):
        return o.to_dict()
    raise TypeError("not JSON serializable: %r" % type(o))


def param(params: dict[str, Any], key: str, kind: type | tuple[type, ...], *, default: Any = ..., label: str | None = None) -> Any:
    """Fetch a typed parameter; raise a structured error instead of a KeyError/TypeError."""
    if key not in params or params[key] is None:
        if default is ...:
            raise RpcError("rpc.bad_params", "missing parameter: %s" % (label or key))
        return default
    v = params[key]
    if kind is int and isinstance(v, bool) or not isinstance(v, kind):
        raise RpcError("rpc.bad_params", "parameter %s has the wrong type" % (label or key))
    return v
