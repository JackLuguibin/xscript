"""代码保护: compile_tree turns a project into importable bytecode only."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xscript_server import protect  # noqa: E402

PY310 = protect.find_python()


@unittest.skipIf(not PY310, "python3.10 not available")
class ProtectTest(unittest.TestCase):
    def test_compile_and_import(self):
        tmp = Path(tempfile.mkdtemp())
        proj = tmp / "demo"
        (proj / "lib").mkdir(parents=True)
        (proj / "__init__.py").write_text("from demo.lib import helper\nprint('ok', helper.VALUE)\n")
        (proj / "lib" / "__init__.py").write_text("")
        (proj / "lib" / "helper.py").write_text("VALUE = 42\n")
        self.assertEqual(protect.compile_tree(proj), 3)
        self.assertFalse(list(proj.rglob("*.py")))
        self.assertTrue(protect.has_entry(proj))
        out = subprocess.run([PY310, "-c", "import demo"], cwd=tmp, capture_output=True, text=True,
                             env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual(out.stdout.strip(), "ok 42", out.stderr)

    def test_syntax_error_is_reported(self):
        proj = Path(tempfile.mkdtemp()) / "bad"
        proj.mkdir()
        (proj / "__init__.py").write_text("def broken(:\n")
        with self.assertRaises(RuntimeError) as ctx:
            protect.compile_tree(proj)
        self.assertIn("编译失败", str(ctx.exception))

    def test_wrong_interpreter_rejected(self):
        if sys.version_info[:2] == protect.TARGET:
            self.skipTest("test interpreter is 3.10")
        with self.assertRaises(RuntimeError):
            protect.compile_tree(tempfile.mkdtemp(), python=sys.executable)


if __name__ == "__main__":
    unittest.main()
