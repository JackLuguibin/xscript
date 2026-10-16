"""Legacy Python GP packages and cloud GP plugin resolution."""
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

import numpy as np

from ascript.android.screen import gp

LEGACY = """
from ascript.android.screen.gp import GPStack, Result
from ascript.android.screen.gp_tasks import Threshold
from .helper import VALUE
def gp(cv_img=None):
    stack = GPStack(cv_img)
    stack.add(Threshold(128, inv=True))
    res = stack.run()
    return Result(res.image, 0, 0, VALUE)
"""


class Double(gp.GPTask):
    def run(self, cv_image, offset_x=0, offset_y=0, data=None):
        return gp.Result(cv_image, offset_x + 1, offset_y, (data or 0) + 2)


class LegacyPackageTest(unittest.TestCase):
    def setUp(self):
        self.image = np.zeros((20, 20, 3), dtype=np.uint8)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = patch.object(gp, "_cache_root", lambda: Path(self.tmp.name) / "cache")
        p.start()
        self.addCleanup(p.stop)

    def _zip(self, name, members):
        path = Path(self.tmp.name) / name
        with zipfile.ZipFile(path, "w") as archive:
            for member, content in members.items():
                archive.writestr(member, content)
        return path

    def test_zip_python_package_runs_gp_entry(self):
        path = self._zip("demo1.gp", {"as_gp_demo1/__init__.py": LEGACY,
                                      "as_gp_demo1/helper.py": "VALUE = 'ok'"})
        res = gp.run(path, self.image)
        self.assertEqual(res.data, "ok")
        self.assertEqual(int(res.image[0, 0]), 255)
        self.assertIn("as_gp_demo1", sys.modules)
        self.assertIs(gp.run(path, self.image).data, "ok")

    def test_directory_package_and_opt_out(self):
        pkg = Path(self.tmp.name) / "demo2" / "as_gp_demo2"
        pkg.mkdir(parents=True)
        (pkg / "__init__.py").write_text(LEGACY)
        (pkg / "helper.py").write_text("VALUE = 7")
        self.assertEqual(gp.run(pkg.parent, self.image).data, 7)
        with self.assertRaises(ValueError):
            gp.run(pkg.parent, self.image, allow_python=False)
        path = self._zip("demo3.gp", {"__init__.py": "raise RuntimeError('no')"})
        with self.assertRaises(ValueError):
            gp.run(path, self.image, allow_python=False)

    def test_path_traversal_and_missing_entry_rejected(self):
        for members in ({"../evil/__init__.py": "def gp(i): pass"}, {"as_gp_x/__init__.py": "pass"}):
            with self.subTest(members=members), self.assertRaises(ValueError):
                gp.run(self._zip("x.gp", members), self.image)
        self.assertFalse((Path(self.tmp.name) / "evil").exists())


class CloudTaskTest(unittest.TestCase):
    def setUp(self):
        self.image = np.zeros((10, 10, 3), dtype=np.uint8)

    def test_registered_cloud_task(self):
        gp.register_task("cloudpkg.Double", Double)
        self.addCleanup(gp.unregister_task, "cloudpkg.Double")
        jobs = [{"id": "cloudpkg.Double", "type": "云端插件", "nv": "yolov8:1.0", "data": {"params": ""}},
                {"id": "cloudpkg.Double", "type": "x", "args": []}]
        res = gp.GPStack.run_json(jobs, self.image)
        self.assertEqual((res.offset_x, res.data), (2, 4))

    def test_cloud_task_imported_after_plugin_load(self):
        mod = types.ModuleType("gp_cloud_fake")
        mod.Double = Double
        with patch.dict(sys.modules, {"gp_cloud_fake": mod}):
            res = gp.GPStack.run_json([{"id": "gp_cloud_fake.Double", "type": "云端", "nv": "yolov8"}], self.image)
        self.assertEqual(res.data, 2)

    def test_unknown_cloud_plugin_or_task(self):
        for job in ({"id": "a.B", "type": "云端", "nv": "nosuchplugin:1"},
                    {"id": "no_such_mod_xyz.B", "type": "云端", "nv": "yolov8"},
                    {"id": "a.B", "type": "云端"}):
            with self.subTest(job=job), self.assertRaises(NotImplementedError):
                gp.GPStack.run_json([job], self.image)


if __name__ == "__main__":
    unittest.main()
