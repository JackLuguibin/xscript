"""云控 from scripts: report data, receive server messages, connect / disconnect.

    from xscript.android import cloud
    cloud.connect("wss://example.com/device?token=...", group="farm-1")
    cloud.send({"gold": 180, "water": 200})        # shown on the dashboard, per device

    @cloud.on_message
    def handle(msg):                               # server "message" frames / custom commands
        print("from server:", msg)

    cloud.status()   # {"state": "connected", "device_id": ..., "group": ..., "url": ...}

The connection belongs to the app (it keeps running between scripts and reconnects on its
own). See docs/CLOUD.md for the wire protocol and the reference server.
"""

import json

from xscript.android import event as _event
from xscript.runtime.bridge import bridge


def _control(op, arg=""):
    raw = bridge.control(op, arg)
    if raw and raw.startswith("{") and '"error"' in raw:
        err = json.loads(raw).get("error")
        if err:
            raise RuntimeError(err)
    return raw


def status():
    raw = _control("cloud_status")
    return json.loads(raw) if raw else {"state": "off"}


def connected():
    return status().get("state") == "connected"


def connect(url, group=None):
    """Connect the app to a 云控 server (ws:// or wss://). The URL is saved for reconnects."""
    arg = {"url": str(url)}
    if group is not None:
        arg["group"] = str(group)
    raw = _control("cloud_connect", arg)
    return json.loads(raw) if raw else {}


def close():
    """Disconnect and forget the server URL."""
    _control("cloud_close")


def send(data):
    """Send a dict / list / str to the server (`{"type": "data"}` frame). False when offline."""
    if not isinstance(data, (dict, list, str, int, float, bool)) and data is not None:
        raise TypeError("send() takes JSON-serialisable data")
    return _control("cloud_send", json.dumps(data, ensure_ascii=False)) == "true"


def on_message(fn=None):
    """Register `fn(data)` for server messages. Works as a decorator. Returns a token for off()."""
    if fn is None:
        return on_message

    def handler(e):
        fn(e.get("data"))

    handler.__wrapped__ = fn
    return _event.on(_event.CLOUD, handler)


def off(token=None):
    _event.off(token, event_type=None if token is not None else _event.CLOUD)


def wait_message(timeout=None):
    """Block until the next server message; returns its data or None on timeout."""
    e = _event.wait(_event.CLOUD, timeout)
    return None if e is None else e.get("data")
