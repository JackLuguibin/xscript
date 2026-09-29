import io
import sys
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import mock_device  # noqa: E402
from xscript_mcp.client import DeviceClient, DeviceTarget  # noqa: E402


class MockDeviceTest(unittest.TestCase):
    """Keeps scripts/mock_device.py in step with DeviceClient and protocol/openapi.yaml."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = mock_device.serve("127.0.0.1", 0)
        host, port = cls.httpd.server_address[:2]
        cls.client = DeviceClient(DeviceTarget(host=host, port=port))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_zip_import_strips_top_folder_and_lists_files(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("demo/__init__.py", "print('hi')\n")
            zf.writestr("demo/res/img/a.png", b"\x89PNG")
        self.client.upload_zip("zipdemo", buf.getvalue())
        paths = sorted(f["path"] for f in self.client.list_files("zipdemo"))
        self.assertEqual(paths, ["__init__.py", "res/img/a.png"])
        self.assertEqual(self.client.read_file("zipdemo", "__init__.py")["content"], "print('hi')\n")
        self.assertEqual(self.client.read_file("zipdemo", "res/img/a.png")["encoding"], "base64")
        self.assertTrue(self.client.delete_project("zipdemo")["ok"])
        self.assertNotIn("zipdemo", self.client.list_projects())

    def test_run_conflict_and_stop(self):
        self.client.upload_file("p1", "__init__.py", "print(1)")
        self.client.upload_file("p2", "__init__.py", "print(2)")
        self.assertTrue(self.client.run_project("p1")["ok"])
        busy = self.client.run_project("p2")
        self.assertEqual(busy.get("error"), "already running")
        self.client.stop_project("p1")
        self.assertFalse(self.client.status()["running"])

    def test_action_eval_and_status_fields(self):
        self.assertTrue(self.client.action({"type": "click", "x": 10, "y": 20})["ok"])
        self.assertTrue(self.client.eval_python("_result = 1")["ok"])
        status = self.client.status()
        for key in ("run_mode", "channel", "capture_source", "version"):
            self.assertIn(key, status)
        self.assertTrue(self.client.screen_jpeg(50))


if __name__ == "__main__":
    unittest.main()
