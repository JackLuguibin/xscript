"""AScript 云控 (`cloud_control`) on XScript's cloud connection (xscript.android.cloud).

    from ascript.android import cloud_control
    cloud_control.connect_to_ws("ws://192.168.31.90:3000")
    cloud_control.send({"gold": 180, "water": 200})
    cloud_control.close()

`connect_to_as` targets AScript's official server, which XScript cannot use; point
`connect_to_ws` at your own server (see docs/CLOUD.md and scripts/xscript_cloud.py).
"""

from ascript._compat import unsupported
from xscript.android import cloud as _cloud


def connect_to_as(user_dev=None, *args, **kwargs):
    unsupported("cloud_control.connect_to_as (AScript's official cloud); use connect_to_ws with your own server")


def connect_to_ws(ws_path, group=None):
    return _cloud.connect(ws_path, group=group)


def send(data):
    return _cloud.send(data)


def close():
    _cloud.close()


def channel(fun):
    """Same as system.channel(fun): fun(msg) for each server message."""
    return _cloud.on_message(fun)
