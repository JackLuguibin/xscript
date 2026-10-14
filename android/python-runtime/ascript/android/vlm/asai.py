"""Natural-language vision with an explicitly selected compatible service.

No service is contacted until init() and an inference method are called. The
service must implement /vision/locate and /vision/ask; this is not an OpenAI
chat-completions adapter. Localization replies use uploaded-image pixels.
"""
import os
import math
import threading
import time

from . import _client, _frame
from ._errors import (AsaiError, NotReadyError, InvalidRequestError, AuthenticationError,
    CredentialExpiredError, InsufficientBalanceError, RateLimitError,
    ServiceUnavailableError, UpstreamError, QuotaExhaustedError, NetworkError, ProtocolError)

_lock = threading.RLock()
_client_instance = None
_coord_space = None


def init(api_key=None, base_url=None, timeout=None, coord_space=None, *, endpoint=None):
    """Configure your service. ASCRIPT_AI_KEY/ASCRIPT_AI_BASE_URL are optional defaults.

    Explicit init is always required. endpoint aliases base_url, including any
    API prefix such as /v1. coord_space is sent to the service to interpret model
    output; the service must normalize returned rects into uploaded-image pixels.
    """
    if endpoint and base_url and endpoint.rstrip("/") != base_url.rstrip("/"):
        raise ValueError("endpoint and base_url disagree")
    if coord_space not in (None, "abs", "norm1000", "ratio"):
        raise ValueError("coord_space must be abs, norm1000, ratio or None")
    client = _client.Client(api_key or os.environ.get("ASCRIPT_AI_KEY"),
        endpoint or base_url or os.environ.get("ASCRIPT_AI_BASE_URL"),
        _client.DEFAULT_TIMEOUT if timeout is None else timeout)
    global _client_instance, _coord_space
    with _lock:
        _client_instance, _coord_space = client, coord_space


def _require():
    with _lock:
        if _client_instance is None:
            raise NotReadyError("Call asai.init(api_key=..., base_url=...) before inference")
        return _client_instance, _coord_space


def status():
    with _lock:
        return dict(configured=_client_instance is not None,
                    base_url=_client_instance.base_url if _client_instance else None,
                    coord_space=_coord_space or "auto")


def find_all(target, rect=None, image=None, limit=10, confidence=0.0, image_tokens=None, hint=None):
    client, coords = _require()
    if not isinstance(target, str) or not target.strip():
        raise ValueError("target must be a nonempty string")
    if isinstance(limit, bool) or int(limit) != limit or limit < 1:
        raise ValueError("limit must be a positive integer")
    if not 0 <= confidence <= 1:
        raise ValueError("confidence must be between zero and one")
    frame = _frame.prepare(image, rect, image_tokens)
    reply = client.locate(frame, target, int(limit), coords, hint)
    hits = reply.get("results", [])
    if not isinstance(hits, list):
        raise ProtocolError("locate.results must be a list")
    results = [frame.remap(hit) for hit in hits]
    return [hit for hit in results if hit["confidence"] >= confidence][:int(limit)]


def locate(target, **kwargs):
    """Convenience alias for find_all; returns mapped hit dictionaries."""
    return find_all(target, **kwargs)


def find(target, rect=None, image=None, confidence=0.0, image_tokens=None, hint=None):
    hits = find_all(target, rect, image, 1, confidence, image_tokens, hint)
    return hits[0] if hits else None


def ask(question, rect=None, image=None, image_tokens=None, hint=None):
    client, _ = _require()
    reply = client.ask(_frame.prepare(image, rect, image_tokens), question, hint=hint)
    result = reply.get("text", "")
    if not isinstance(result, str):
        raise ProtocolError("ask.text must be a string")
    return result


_TYPES = {int: "integer", float: "number", bool: "boolean", str: "string"}


def _wire_format(value_type):
    inner, suffix = value_type, ""
    args = getattr(value_type, "__args__", ())
    if getattr(value_type, "__origin__", None) in (list, tuple) and args:
        inner, suffix = args[0], "[]"
    elif isinstance(value_type, (list, tuple)) and len(value_type) == 1:
        inner, suffix = value_type[0], "[]"
    if isinstance(inner, dict):
        if not inner or any(not isinstance(k, str) or not k or (not isinstance(v, type) or v not in _TYPES) for k, v in inner.items()):
            raise ValueError("record fields need names and int/float/bool/str types")
        return "object" + suffix, {k: _TYPES[v] for k, v in inner.items()}
    if not isinstance(inner, type) or inner not in _TYPES:
        raise ValueError("value_type must be int/float/bool/str, [T], or a named record")
    return _TYPES[inner] + suffix, None


def _validate_value(value, fmt, fields):
    if value is None:
        return
    if fmt.endswith("[]"):
        if not isinstance(value, list):
            raise ProtocolError("ask.value must be a list")
        for item in value:
            _validate_value(item, fmt[:-2], fields)
        return
    if fmt == "object":
        if not isinstance(value, dict):
            raise ProtocolError("ask.value must be a record")
        for key, field_type in fields.items():
            _validate_value(value.get(key), field_type, None)
            value.setdefault(key, None)
        return
    valid = {"integer": type(value) is int, "number": type(value) in (int, float),
             "boolean": type(value) is bool, "string": isinstance(value, str)}
    if not valid.get(fmt, False):
        raise ProtocolError("ask.value does not match requested " + fmt)


def ask_value(question, value_type=str, rect=None, image=None, image_tokens=None, hint=None):
    client, _ = _require()
    fmt, fields = _wire_format(value_type)
    reply = client.ask(_frame.prepare(image, rect, image_tokens), question, fmt, fields, hint)
    if type(reply.get("ok")) is not bool:
        raise ProtocolError("ask_value response needs a boolean ok")
    if not reply["ok"]:
        return None
    if "value" not in reply:
        raise ProtocolError("successful ask_value response is missing value")
    value = reply["value"]
    _validate_value(value, fmt, fields)
    return value


def exists(target, rect=None, image=None, confidence=0.0, hint=None):
    return find(target, rect, image, confidence, hint=hint) is not None


def wait(target, timeout=30, interval=0.0, rect=None, confidence=0.0, hint=None):
    if not math.isfinite(timeout) or not math.isfinite(interval) or timeout < 0 or interval < 0:
        raise ValueError("timeout and interval must be nonnegative")
    deadline = time.monotonic() + timeout
    while True:
        result = find(target, rect=rect, confidence=confidence, hint=hint)
        remaining = deadline - time.monotonic()
        if result or remaining <= 0:
            return result
        if interval:
            time.sleep(min(interval, remaining))


def click(target, timeout=0, rect=None, image=None, confidence=0.0, hint=None):
    hit = (wait(target, timeout, rect=rect, confidence=confidence, hint=hint)
           if timeout > 0 and image is None else find(target, rect, image, confidence, hint=hint))
    if hit is None:
        return False
    from ascript.android import action
    return bool(action.click(hit["center_x"], hit["center_y"]))
