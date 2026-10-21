"""scripts/devauth.py: the pairing code for the device scripts (XSCRIPT_TOKEN, else adb, else nothing)."""
import http.server
import json
import os
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import devauth  # noqa: E402


def serve(status):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(status).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


class WaitIdleTest(unittest.TestCase):
    def test_waits_until_not_running_then_times_out_when_stuck(self):
        status = {"running": True}
        srv, base = serve(status)
        try:
            devauth._cache.pop(base, None)
            threading.Timer(0.3, lambda: status.update(running=False)).start()
            devauth.wait_idle(base, timeout=5, poll=0.05)
            self.assertFalse(status["running"])
            status["running"] = True
            with self.assertRaises(AssertionError):
                devauth.wait_idle(base, timeout=0.2, poll=0.05)
        finally:
            srv.shutdown()


class MaskTest(unittest.TestCase):
    def test_masks_pairing_codes_only(self):
        self.assertEqual(devauth.mask("配对码 AB2C-9XYZ ok"), "配对码 ****-**** ok")
        self.assertEqual(devauth.mask("code=AB2C9XYZ"), "code=****-****")
        self.assertEqual(devauth.mask({"t": "Q7K2-M4PD"}), "{'t': '****-****'}")
        kept = "127.0.0.1:9860 PASS 在手机上试运行 abcd-efgh"
        self.assertEqual(devauth.mask(kept), kept)


class DevAuthTest(unittest.TestCase):
    def setUp(self):
        devauth._cache.clear()
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop("XSCRIPT_TOKEN", None)
        os.environ.pop("ANDROID_SERIAL", None)

    def tearDown(self):
        self.env.stop()

    def test_env_token_wins_without_asking_the_device(self):
        os.environ["XSCRIPT_TOKEN"] = "ABCD-EFGH"
        with mock.patch.object(devauth, "_status", side_effect=AssertionError("must not be called")):
            self.assertEqual(devauth.headers("http://127.0.0.1:1", {"Content-Type": "application/json"}),
                             {"Content-Type": "application/json", "Authorization": "Bearer ABCD-EFGH"})

    def test_pairing_off_needs_nothing(self):
        srv, base = serve({"name": "d", "pairing": False, "paired": False, "app_id": "com.xscript.app"})
        try:
            with mock.patch.object(devauth, "_from_adb", side_effect=AssertionError("must not be called")):
                self.assertEqual(devauth.headers(base), {})
        finally:
            srv.shutdown()

    def test_required_pairing_reads_the_code_over_adb_for_the_reported_app(self):
        srv, base = serve({"name": "d", "pairing": True, "paired": False, "app_id": "com.xscript.app.perf"})
        try:
            with mock.patch.object(devauth, "_from_adb", return_value="WXYZ2345") as adb:
                self.assertEqual(devauth.headers(base, serial="emulator-5554"), {"Authorization": "Bearer WXYZ2345"})
                self.assertEqual(devauth.token(base), "WXYZ2345")  # cached: adb asked once
            adb.assert_called_once_with("com.xscript.app.perf", "emulator-5554")
        finally:
            srv.shutdown()

    def test_android_serial_is_used_when_no_serial_is_given(self):
        os.environ["ANDROID_SERIAL"] = "emulator-5556"
        srv, base = serve({"pairing": True, "paired": False, "app_id": "com.xscript.app"})
        try:
            with mock.patch.object(devauth, "_from_adb", return_value="") as adb, mock.patch("builtins.print") as out:
                self.assertEqual(devauth.headers(base), {})
            adb.assert_called_once_with("com.xscript.app", "emulator-5556")
            self.assertIn("XSCRIPT_TOKEN", out.call_args[0][0])  # tells the user what to do, never prints a code
        finally:
            srv.shutdown()

    def test_unreachable_device_gives_no_header(self):
        self.assertEqual(devauth.headers("http://127.0.0.1:1"), {})

    def test_bad_app_id_or_missing_adb_gives_no_code(self):
        with mock.patch.object(devauth, "_adb", return_value=None):
            self.assertEqual(devauth._from_adb("com.xscript.app", None), "")
        self.assertEqual(devauth._from_adb("", None), "")


if __name__ == "__main__":
    unittest.main()
