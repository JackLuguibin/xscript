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

    def test_run_options(self):
        self.client.upload_file("boot1", "__init__.py", "print(1)")
        self.client.upload_file("boot2", "__init__.py", "print(2)")
        self.assertFalse(self.client.project_config("boot1")["auto_run"])
        self.assertTrue(self.client.set_project_config("boot1", auto_run=True, stop_re_run=True)["stop_re_run"])
        # Only one boot project per device
        self.client.set_project_config("boot2", auto_run=True)
        self.assertFalse(self.client.project_config("boot1")["auto_run"])
        self.assertEqual(self.client.project_config("boot1")["boot_project"], "boot2")
        self.assertEqual(self.client.set_project_config("nope", auto_run=True).get("error"), "missing project")
        self.client.delete_project("boot2")
        self.assertEqual(self.client.project_config("boot1")["boot_project"], "")
        self.client.delete_project("boot1")

    def test_schedules_crud_and_run(self):
        self.client.upload_file("sched", "__init__.py", "print(1)")
        daily = self.client.add_schedule({"project": "sched", "kind": "daily", "time": "08:30", "weekdays": [1, 5]})
        self.assertEqual(daily["kind"], "daily")
        self.assertIn("time must be", self.client.add_schedule({"project": "sched", "kind": "daily", "time": "8h"})["error"])
        self.assertIn("missing project", self.client.add_schedule({"project": "nope", "kind": "interval", "every": 5})["error"])
        every = self.client.add_schedule({"project": "sched", "kind": "interval", "every": 15, "if_running": "restart"})
        self.assertEqual([s["id"] for s in self.client.list_schedules("sched")["schedules"]], [daily["id"], every["id"]])
        self.assertFalse(self.client.update_schedule(daily["id"], {"enabled": False})["enabled"])
        self.assertEqual(self.client.update_schedule("missing", {"enabled": False}).get("error"), "missing schedule")
        self.assertEqual(self.client.run_schedule(every["id"])["result"], "started")
        self.assertEqual(self.client.run_schedule(daily["id"])["result"], "skipped")
        self.client.stop_project("sched")
        self.assertTrue(self.client.delete_schedule(daily["id"])["ok"])
        self.client.delete_project("sched")
        self.assertEqual(self.client.list_schedules()["schedules"], [])

    def test_action_eval_and_status_fields(self):
        self.assertTrue(self.client.action({"type": "click", "x": 10, "y": 20})["ok"])
        self.assertTrue(self.client.eval_python("_result = 1")["ok"])
        status = self.client.status()
        for key in ("run_mode", "channel", "capture_source", "version"):
            self.assertIn(key, status)
        self.assertTrue(self.client.screen_jpeg(50))

    def test_snapshot_vision_and_crop(self):
        snap = self.client.snapshot()
        self.assertTrue(self.client.snapshot_png(snap["id"]).startswith(b"\x89PNG"))
        px = self.client.vision({"snapshot": snap["id"], "op": "pixel", "x": 0, "y": 0})
        self.assertEqual((px["ok"], px["color"]), (True, "#336699"))
        hit = self.client.vision({"snapshot": snap["id"], "op": "find_colors", "colors": "0,0,#336699"})
        self.assertEqual(hit["points"], [[0, 0]])
        # Errors come back as JSON instead of raising.
        self.assertFalse(self.client.vision({"snapshot": "nope", "op": "pixel"})["ok"])
        self.assertIn("ValueError", self.client.vision({"snapshot": snap["id"], "op": "bogus"})["error"])
        self.client.upload_file("croppy", "__init__.py", "print(1)")
        out = self.client.crop_snapshot(snap["id"], [0, 0, 1, 1], "croppy", "res/img/t.png")
        self.assertTrue(out["ok"])
        self.assertIn("res/img/t.png", [f["path"] for f in self.client.list_files("croppy")])

    def test_datasets_list_and_export(self):
        import httpx

        base = self.client.target.base_url + "/tools/datasets/btns"
        httpx.post(base).raise_for_status()
        httpx.put(base + "/classes", json={"classes": ["ok"]}).raise_for_status()
        iid = httpx.post(base + "/images", json={}).json()["id"]
        httpx.put(base + "/labels/" + iid, json={"width": 1, "height": 1, "boxes": []}).raise_for_status()
        listed = {d["name"]: d for d in self.client.list_datasets()}
        self.assertEqual((listed["btns"]["images"], listed["btns"]["labeled"]), (1, 1))
        self.assertEqual(self.client.dataset("btns")["classes"], ["ok"])
        with zipfile.ZipFile(io.BytesIO(self.client.export_dataset("btns"))) as zf:
            self.assertIn("data.yaml", zf.namelist())
            self.assertIn("images/train/%s.png" % iid, zf.namelist())


if __name__ == "__main__":
    unittest.main()
