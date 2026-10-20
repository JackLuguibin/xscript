import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))

import mock_device  # noqa: E402
from xscript_mcp.client import DeviceClient, DeviceError, DeviceTarget, auth_headers  # noqa: E402


class PairingTest(unittest.TestCase):
    """A paired device (the phone's default) refuses requests without the pairing code."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = mock_device.serve("127.0.0.1", 0, token="ABCDEFGH")
        cls.host, cls.port = cls.httpd.server_address[:2]
        cls.base = "http://%s:%d" % (cls.host, cls.port)
        cls.http = httpx.Client(trust_env=False)

    @classmethod
    def tearDownClass(cls):
        cls.http.close()
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def client(self, token):
        return DeviceClient(DeviceTarget(host=self.host, port=self.port), token=token)

    def test_unpaired_eval_is_refused_with_a_hint(self):
        with self.assertRaises(DeviceError) as e:
            self.client("").eval_python("1+1")
        self.assertEqual(e.exception.status_code, 401)
        self.assertIn("XSCRIPT_TOKEN", e.exception.detail)
        with self.assertRaises(DeviceError):
            self.client("WRONG123").list_projects()

    def test_status_is_public_but_reduced(self):
        st = self.client("").status()
        self.assertEqual(st["model"], "XScript Mock")
        self.assertEqual((st["pairing"], st["paired"]), (True, False))
        self.assertNotIn("running", st)
        full = self.client("abcd-efgh").status()
        self.assertTrue(full["paired"])
        self.assertIn("running", full)

    def test_paired_client_works(self):
        c = self.client("abcd-efgh")
        self.assertIsInstance(c.list_projects(), list)

    def test_token_from_environment(self):
        with mock.patch.dict(os.environ, {"XSCRIPT_TOKEN": "ABCD-EFGH"}):
            c = DeviceClient(DeviceTarget(host=self.host, port=self.port))
        self.assertIsInstance(c.list_projects(), list)
        c.set_target(self.host, self.port, token="")
        with self.assertRaises(DeviceError):
            c.list_projects()

    def test_auth_headers(self):
        self.assertEqual(auth_headers("abcd-efgh")["Authorization"], "Bearer ABCDEFGH")
        self.assertNotIn("Authorization", auth_headers(""))

    def test_browser_csrf_is_refused(self):
        # A web page can send text/plain cross-site without a preflight; the device refuses both.
        r = self.http.post(self.base + "/eval", content='{"code": "1"}', headers={"Content-Type": "text/plain", "Origin": "http://evil.example"})
        self.assertEqual(r.status_code, 403)
        r = self.http.post(self.base + "/eval", content='{"code": "1"}', headers={"Content-Type": "text/plain", "Authorization": "Bearer ABCDEFGH"})
        self.assertEqual(r.status_code, 415)

    def test_pair_endpoint_sets_cookie(self):
        r = self.http.post(self.base + "/pair", json={"code": "nope"})
        self.assertEqual(r.status_code, 401)
        r = self.http.post(self.base + "/pair", json={"code": "abcd-efgh"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("xs_pair=ABCDEFGH", r.headers["set-cookie"])
        self.assertIn("SameSite=Strict", r.headers["set-cookie"])
        r2 = self.http.get(self.base + "/projects", headers={"Cookie": "xs_pair=ABCDEFGH"})
        self.assertEqual(r2.status_code, 200)


if __name__ == "__main__":
    unittest.main()
