"""bluetooth module against a fake bridge (no radio is touched)."""
import base64
import json
import threading
import unittest
from unittest.mock import patch

from ascript.android import bluetooth


def b64(b):
    return base64.b64encode(b).decode()


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.denied_once = set()
        self.notes = []
        self.lock = threading.Lock()

    def system(self, op, arg):
        self.calls.append((op, arg))
        if op in self.denied_once:
            self.denied_once.discard(op)
            return json.dumps({"error": "need permission", "code": "permission_denied"})
        if op == "bt_state":
            return json.dumps({"supported": True, "enabled": True, "ble": True})
        if op == "bt_enable":
            return "true"
        if op == "bt_scan":
            return json.dumps([{"name": "HC-05", "address": "00:11:22:33:44:55", "type": "classic", "bonded": False, "rssi": -60}])
        if op == "bt_bonded":
            return "[]"
        if op == "bt_connect":
            if arg["address"] == "bad":
                return json.dumps({"error": "invalid bluetooth address: bad", "code": "bad_args"})
            return json.dumps({"id": "c1", "address": arg["address"]})
        if op == "bt_read":
            return json.dumps({"data": b64(b"pong")})
        if op in ("bt_write", "bt_close", "ble_write", "ble_notify"):
            return '{"ok": true}'
        if op == "ble_connect":
            return json.dumps({"id": "b2", "address": arg["address"], "services": [{"uuid": "0000180d-0000-1000-8000-00805f9b34fb", "characteristics": []}]})
        if op == "ble_read":
            return json.dumps({"data": b64(b"\x01\x02")})
        if op == "ble_poll":
            with self.lock:
                out, self.notes = self.notes, []
            return json.dumps(out)
        raise AssertionError(op)


class BluetoothTest(unittest.TestCase):
    def last(self, op):
        """Arguments of the latest `op` call. Once notify() starts its pump thread, ble_poll calls interleave, so
        calls[-1] is not necessarily the call the test just made."""
        return next(arg for o, arg in reversed(self.fake.calls) if o == op)

    def setUp(self):
        self.fake = FakeBridge()
        self.ensure = patch.object(bluetooth.permission, "ensure", return_value=True)
        for p in (patch.object(bluetooth, "bridge", self.fake), self.ensure):
            p.start()
            self.addCleanup(p.stop)

    def test_state_scan_and_permission_retry(self):
        self.assertTrue(bluetooth.is_enabled())
        self.assertTrue(bluetooth.enable())
        self.fake.denied_once.add("bt_scan")
        with patch.object(bluetooth.permission, "ensure", return_value=True) as ens:
            found = bluetooth.scan(2.5, ble=True)
            self.assertEqual([c.args[0] for c in ens.call_args_list], [bluetooth._SCAN, bluetooth._CONNECT])
        self.assertEqual(found[0]["name"], "HC-05")
        self.assertEqual(self.fake.calls[-1], ("bt_scan", {"timeout_ms": 2500, "ble": True}))
        with self.assertRaises(ValueError):
            bluetooth.scan(0)

    def test_permission_refused(self):
        self.fake.denied_once.add("bt_bonded")
        with patch.object(bluetooth.permission, "ensure", return_value=False):
            with self.assertRaises(PermissionError):
                bluetooth.bonded()

    def test_scan_falls_back_to_location_before_android_12(self):
        self.fake.denied_once.add("bt_scan")
        answers = {bluetooth._SCAN: False, bluetooth._CONNECT: False, bluetooth.permission.ACCESS_FINE_LOCATION: True}
        with patch.object(bluetooth.permission, "ensure", side_effect=lambda p: answers[p]):
            self.assertEqual(len(bluetooth.scan(1)), 1)

    def test_classic_connection(self):
        with bluetooth.connect("00:11:22:33:44:55") as c:
            c.write("ping\n")
            self.assertEqual(self.fake.calls[-1], ("bt_write", {"id": "c1", "data": b64(b"ping\n")}))
            self.assertEqual(c.read(16, timeout=0.5), b"pong")
            self.assertEqual(self.fake.calls[-1][1], {"id": "c1", "max": 16, "timeout_ms": 500})
            self.assertEqual(c.read_text(), "pong")
        self.assertEqual(self.fake.calls[-1], ("bt_close", {"id": "c1"}))
        with self.assertRaises(bluetooth.BluetoothError):
            c.write(b"x")
        with self.assertRaises(ValueError):
            bluetooth.connect("bad")
        self.assertEqual(self.fake.calls[-1][1]["uuid"], "")

    def test_ble_read_write_notify(self):
        g = bluetooth.ble_connect("AA:BB:CC:DD:EE:FF", timeout=5)
        self.addCleanup(g.close)  # runs before the bridge patch is undone: the pump stops against the fake
        self.assertEqual(self.fake.calls[-1][1]["timeout_ms"], 5000)
        self.assertEqual(g.services[0]["uuid"][4:8], "180d")
        self.assertEqual(g.read("180d", "2a38"), b"\x01\x02")
        g.write("180d", "2a39", b"\x05", no_response=True)
        self.assertEqual(self.fake.calls[-1][1], {"id": "b2", "service": "180d", "char": "2a39", "data": b64(b"\x05"), "no_response": True})
        got = []
        done = threading.Event()
        g.notify("180d", "2a37", lambda data, char, service: (got.append(data), done.set()))
        with self.fake.lock:
            self.fake.notes.append({"service": "0000180d-0000-1000-8000-00805f9b34fb", "char": "00002a37-0000-1000-8000-00805f9b34fb", "data": b64(b"\x48")})
        self.assertTrue(done.wait(2))
        self.assertEqual(got, [b"\x48"])
        g.notify("180d", "2a37", None)
        self.assertFalse(self.last("ble_notify")["enable"])
        g.close()
        self.assertIn(("bt_close", {"id": "b2"}), self.fake.calls)


if __name__ == "__main__":
    unittest.main()
