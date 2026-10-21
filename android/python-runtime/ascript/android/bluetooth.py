"""蓝牙: scan, classic serial (RFCOMM / SPP) and BLE GATT.

    from ascript.android import bluetooth
    bluetooth.enable()                                   # asks the user when bluetooth is off
    for d in bluetooth.scan(8):                          # classic discovery; scan(8, ble=True) for BLE advertisers
        print(d["name"], d["address"], d.get("rssi"))
    c = bluetooth.connect("00:11:22:33:44:55")           # SPP by default (HC-05, ESP32 BluetoothSerial)
    c.write(b"hello\\n"); print(c.read(timeout=2))
    c.close()
    g = bluetooth.ble_connect("AA:BB:CC:DD:EE:FF")
    g.write("6e400001-b5a3-f393-e0a9-e50e24dcca9e", "6e400002-b5a3-f393-e0a9-e50e24dcca9e", b"\\x01")
    g.notify("180d", "2a37", lambda data, char, service: print(data))
    g.close()

Runtime permissions (BLUETOOTH_SCAN / BLUETOOTH_CONNECT on Android 12+, location for scans on older versions) are
requested on first use. Connections are closed automatically when the script ends.
"""

import base64
import json
import threading
import traceback

from ascript.android.system import permission
from xscript.runtime.bridge import bridge

SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb"
_SCAN = "android.permission.BLUETOOTH_SCAN"
_CONNECT = "android.permission.BLUETOOTH_CONNECT"


class BluetoothError(RuntimeError):
    pass


def _raw(op, arg):
    raw = bridge.system(op, arg)
    if not raw:
        raise BluetoothError("Android bluetooth bridge is unavailable")
    return json.loads(str(raw))


def _call(op, arg=None, perms=(_CONNECT,)):
    """Bridge call; on a missing grant, request the permissions once and retry."""
    arg = arg or {}
    r = _raw(op, arg)
    if isinstance(r, dict) and r.get("code") == "permission_denied":
        granted = all(permission.ensure(p) for p in perms)
        if not granted and _SCAN in perms:
            granted = permission.ensure(permission.ACCESS_FINE_LOCATION)  # scans before Android 12
        if granted:
            r = _raw(op, arg)
    if isinstance(r, dict) and r.get("error"):
        code = r.get("code")
        if code == "permission_denied":
            raise PermissionError(r["error"])
        if code == "bad_args":
            raise ValueError(r["error"])
        raise BluetoothError(r["error"])
    return r


def _b64(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return base64.b64encode(bytes(data)).decode("ascii")


def _bytes(s):
    return base64.b64decode(s or "")


def state():
    """{"supported": bool, "enabled": bool, "ble": bool}"""
    return _call("bt_state")


def is_enabled():
    return bool(state().get("enabled"))


def enable():
    """True when bluetooth is on; otherwise shows the system "turn on bluetooth" dialog and returns False."""
    return _call("bt_enable") is True


def bonded():
    """Paired devices: [{"name", "address", "type": classic|ble|dual|unknown, "bonded": True}]."""
    return _call("bt_bonded")


def scan(timeout=10, ble=False):
    """Scan for `timeout` seconds (classic discovery, or BLE advertisements with ble=True); returns devices with rssi."""
    t = float(timeout)
    if not t > 0:
        raise ValueError("timeout must be positive")
    return _call("bt_scan", {"timeout_ms": int(t * 1000), "ble": bool(ble)}, perms=(_SCAN, _CONNECT))


class Connection(object):
    """Classic RFCOMM socket (serial port profile by default)."""

    def __init__(self, cid, address):
        self.id = cid
        self.address = address
        self.closed = False

    def write(self, data):
        self._check()
        _call("bt_write", {"id": self.id, "data": _b64(data)})

    def read(self, size=1024, timeout=1.0):
        """Up to `size` bytes, waiting at most `timeout` seconds for the first ones; b"" when nothing arrived."""
        self._check()
        return _bytes(_call("bt_read", {"id": self.id, "max": int(size), "timeout_ms": int(float(timeout) * 1000)})["data"])

    def read_text(self, size=1024, timeout=1.0, encoding="utf-8"):
        return self.read(size, timeout).decode(encoding, "replace")

    def close(self):
        if not self.closed:
            self.closed = True
            _call("bt_close", {"id": self.id})

    def _check(self):
        if self.closed:
            raise BluetoothError("connection is closed")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def connect(address, uuid=None):
    """Open a classic RFCOMM connection (SPP unless `uuid` is given). Pairing, if needed, is handled by the system."""
    r = _call("bt_connect", {"address": str(address), "uuid": uuid or ""})
    return Connection(r["id"], r["address"])


class BleConnection(object):
    """BLE GATT client. UUIDs may be full or short ("180d")."""

    def __init__(self, info):
        self.id = info["id"]
        self.address = info["address"]
        self.services = info.get("services", [])
        self.closed = False
        self._callbacks = {}
        self._stop = None
        self._pump_thread = None

    def read(self, service, char):
        return _bytes(_call("ble_read", {"id": self.id, "service": str(service), "char": str(char)})["data"])

    def write(self, service, char, data, no_response=False):
        _call("ble_write", {"id": self.id, "service": str(service), "char": str(char), "data": _b64(data), "no_response": bool(no_response)})

    def notify(self, service, char, callback=None):
        """Subscribe to notifications/indications; callback(data: bytes, char: str, service: str) runs on a worker thread.
        callback=None unsubscribes."""
        _call("ble_notify", {"id": self.id, "service": str(service), "char": str(char), "enable": callback is not None})
        key = _norm(char)
        if callback is None:
            self._callbacks.pop(key, None)
            return
        self._callbacks[key] = callback
        if self._stop is None:
            self._stop = threading.Event()
            self._pump_thread = threading.Thread(target=self._pump, args=(self._stop,), name="ascript-ble", daemon=True)
            self._pump_thread.start()

    def _pump(self, stop):
        while not stop.is_set():
            try:
                notes = _call("ble_poll", {"id": self.id, "timeout_ms": 250})
            except Exception:
                if not stop.is_set():
                    traceback.print_exc()
                return
            for n in notes or []:
                cb = self._callbacks.get(_norm(n.get("char", "")))
                if cb is not None:
                    try:
                        cb(_bytes(n.get("data")), n.get("char"), n.get("service"))
                    except Exception:
                        traceback.print_exc()

    def close(self):
        if self._stop is not None:
            self._stop.set()
            self._stop = None
        pump, self._pump_thread = self._pump_thread, None
        if pump is not None and pump is not threading.current_thread():
            pump.join(1.0)  # let an in-flight ble_poll (<=250 ms) finish so no poll outlives close()
        if not self.closed:
            self.closed = True
            _call("bt_close", {"id": self.id})

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def _norm(uuid):
    u = str(uuid).lower().replace("0x", "")
    if len(u) in (4, 8):
        u = u.rjust(8, "0") + "-0000-1000-8000-00805f9b34fb"
    return u


def ble_connect(address, timeout=15):
    """Connect to a BLE peripheral and discover its services (see .services)."""
    return BleConnection(_call("ble_connect", {"address": str(address), "timeout_ms": int(float(timeout) * 1000)}))
