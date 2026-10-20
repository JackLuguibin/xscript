"""GP gaps: R.img/R.res paths in data.params and project 图色插件 declared in build.as.

Nothing from a .gp file is executed: params only evaluate literals, task constants and R path
helpers, and ".module.Class" ids import the running project's own modules, only when declared."""
import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import cv2
import numpy as np

from ascript.android.screen import gp
from xscript.runtime import runner

PREFIX = "ascript.android.screen.gp_tasks."


class ProjectGpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.name = "gpproj_%d" % id(self)
        self.root = Path(self.tmp.name) / self.name
        (self.root / "res" / "img").mkdir(parents=True)
        (self.root / "__init__.py").write_text(textwrap.dedent('''
            from ascript.android.screen.gp import GPTask, Result
            class Top(GPTask):
                name = "top"
                def run(self, img, ox=0, oy=0, data=None):
                    return Result(img, ox, oy, "top")
            NotATask = 5
        '''))
        (self.root / "user.py").write_text(textwrap.dedent('''
            from ascript.android.screen.gp import GPTask, Result
            IMPORTED = True
            class MyPlug(GPTask):
                name = "插件"
                ui_path = "res/ui/plug"
                def __init__(self, factor=1, label=""):
                    self.factor, self.label = factor, label
                def run(self, img, ox=0, oy=0, data=None):
                    return Result(img[:10, :10], ox + 5, oy + 7, {"prev": data, "factor": self.factor, "label": self.label})
        '''))
        (self.root / "secret.py").write_text("RAN = True\nclass Hidden:\n    def run(self, *a):\n        pass\n")
        (self.root / "build.as").write_text(json.dumps({"name": "demo", "gp": [
            {"id": ".user.MyPlug", "des": "我的插件"}, {"id": ".Top", "des": "根"}, ".NotATask", ".missing.Thing"]},
            ensure_ascii=False))
        sys.path.insert(0, self.tmp.name)
        saved = dict(runner._context)
        runner._context.update(project_dir=str(self.root), name=self.name)

        def restore():
            runner._context.clear()
            runner._context.update(saved)
            sys.path.remove(self.tmp.name)
            for key in [k for k in sys.modules if k == self.name or k.startswith(self.name + ".")]:
                sys.modules.pop(key)
        self.addCleanup(restore)
        self.image = np.zeros((40, 60, 3), np.uint8)

    def test_declared_project_tasks_chain_with_builtins(self):
        jobs = [{"id": PREFIX + "Crop", "data": {"params": "10, 5, 50, 35"}},
                {"id": ".Top"},
                {"id": ".user.MyPlug", "data": {"params": "factor=-2, label=R.res('a.txt')"}}]
        res = gp.GPStack.run_json(jobs, self.image)
        self.assertEqual((res.offset_x, res.offset_y), (15, 12))
        self.assertEqual(res.data, {"prev": "top", "factor": -2, "label": str(self.root / "res" / "a.txt")})
        self.assertEqual(res.image.shape[:2], (10, 10))

    def test_undeclared_or_invalid_ids_never_import(self):
        for task_id, error in ((".secret.Hidden", NotImplementedError), ("..user.MyPlug", ValueError),
                               (".user.MyPlug.extra", NotImplementedError), (".user-x.Y", ValueError),
                               (".NotATask", NotImplementedError), (".missing.Thing", NotImplementedError)):
            with self.subTest(task_id=task_id), self.assertRaises(error):
                gp.GPStack.run_json([{"id": task_id}], self.image)
        self.assertNotIn(self.name + ".secret", sys.modules)

    def test_no_running_project_or_no_build_as(self):
        runner._context.update(project_dir="", name="")
        with self.assertRaises(NotImplementedError):
            gp.GPStack.run_json([{"id": ".user.MyPlug"}], self.image)
        runner._context.update(project_dir=str(self.root), name=self.name)
        (self.root / "build.as").write_text("{not json")
        with self.assertRaises(NotImplementedError):
            gp.GPStack.run_json([{"id": ".user.MyPlug"}], self.image)

    def test_gp_file_in_project_uses_project_task(self):
        path = self.root / "res" / "flow.gp"
        path.write_text(json.dumps([{"id": ".user.MyPlug", "data": {"params": "3"}}]))
        self.assertEqual(gp.run(path, self.image).data["factor"], 3)

    def test_r_paths_feed_cvfontlib(self):
        """AScript's GP UI exports template paths as R.img(...): the font images load from res/img."""
        img = np.full((40, 120, 3), 255, np.uint8)
        glyph_a = np.zeros((14, 10, 3), np.uint8); glyph_a[2:12, 2:4] = 255; glyph_a[2:4, 2:8] = 255
        glyph_b = np.zeros((14, 10, 3), np.uint8); glyph_b[2:12, 6:8] = 255; glyph_b[10:12, 1:8] = 255
        for x, g in ((10, glyph_a), (30, glyph_b), (50, glyph_a)):
            img[12:26, x:x + 10] = g
        cv2.imwrite(str(self.root / "res" / "img" / "a.png"), glyph_a)
        cv2.imwrite(str(self.root / "res" / "img" / "b.png"), glyph_b)
        params = "[R.img('a.png'), R.img('b.png')], ['A', 'B'], confidence=0.9"
        res = gp.GPStack.run_json([{"id": PREFIX + "CvFontLib", "data": {"params": params}}], img)
        self.assertEqual(res.data["text"], "ABA")
        args, _ = gp._arguments("R.img('x', 'y.png'), R.sd('a'), R.root(), R.ui('p')", gp.GPTask)
        self.assertEqual(args, [[str(self.root / "res" / "img" / "x"), str(self.root / "res" / "img" / "y.png")],
                                "/sdcard/a", str(self.root), str(self.root / "res" / "ui" / "p")])

    def test_params_reject_everything_executable(self):
        for params in ("R.rel(__file__, 'a')", "R.img(name)", "R.img(1)", "R.img('a', sep='/')",
                       "[__import__('os')]", "{'a': open('x')}", "R.img('a').upper()", "lambda: 1",
                       "f'{1}'", "*[1]", "R['img']", "getattr(R, 'img')('a')", "(1).__class__",
                       "[" * 400 + "]" * 400):
            with self.subTest(params=params[:30]), self.assertRaises(ValueError):
                gp._arguments(params, gp.GPTask)

    def test_literals_still_parse(self):
        args, kwargs = gp._arguments("1, -2.5, 'x', [1, (2, 3)], {'k': None}, True, a=+3", gp.GPTask)
        self.assertEqual(args, [1, -2.5, "x", [1, (2, 3)], {"k": None}, True])
        self.assertEqual(kwargs, {"a": 3})


if __name__ == "__main__":
    unittest.main()
