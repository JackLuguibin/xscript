import os
import tempfile
import unittest

from xscript.runtime import runner


def _project(files):
    d = tempfile.mkdtemp()
    for rel, text in files.items():
        path = os.path.join(d, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return d


class UsesOcrTest(unittest.TestCase):
    def test_detects_mlkit_calls(self):
        for src in ("from xscript.android import image\nimage.ocr()\n",
                    "from xscript.android.image import ocr_find\nocr_find('ok')\n",
                    "x = ocr (rect=[0, 0, 10, 10])\n"):
            self.assertTrue(runner._uses_ocr(_project({"__init__.py": src})), src)

    def test_ignores_projects_without_ocr(self):
        for src in ("print('hi')\n", "from xscript.android import paddle\npaddle.ocr()\n",
                    "# no ocr here\nprocrastinate = 1\n"):
            self.assertFalse(runner._uses_ocr(_project({"__init__.py": src})), src)

    def test_scans_subpackages_and_skips_hidden_and_cache(self):
        self.assertTrue(runner._uses_ocr(_project({"__init__.py": "", "lib/util.py": "image.ocr()\n"})))
        self.assertFalse(runner._uses_ocr(_project({"__init__.py": "", ".git/x.py": "ocr()\n",
                                                    "__pycache__/y.py": "ocr()\n"})))

    def test_file_limit(self):
        files = {"m%03d.py" % i: "ocr()\n" for i in range(5)}
        self.assertTrue(runner._uses_ocr(_project(files), max_files=3))
        self.assertFalse(runner._uses_ocr(_project(files), max_files=0))

    def test_warm_calls_bridge_only_when_needed(self):
        calls = []
        orig = getattr(runner.bridge, "ocr_warmup", None)
        runner.bridge.ocr_warmup = lambda: calls.append(1)
        try:
            runner._warm_ocr(_project({"__init__.py": "print(1)\n"}))
            self.assertEqual(calls, [])
            runner._warm_ocr(_project({"__init__.py": "image.ocr()\n"}))
            self.assertEqual(calls, [1])
        finally:
            if orig is None:
                del runner.bridge.ocr_warmup
            else:
                runner.bridge.ocr_warmup = orig

    def test_warm_never_raises(self):
        orig = getattr(runner.bridge, "ocr_warmup", None)

        def boom():
            raise RuntimeError("x")
        runner.bridge.ocr_warmup = boom
        try:
            runner._warm_ocr(_project({"__init__.py": "ocr()\n"}))
        finally:
            if orig is None:
                del runner.bridge.ocr_warmup
            else:
                runner.bridge.ocr_warmup = orig


if __name__ == "__main__":
    unittest.main()
