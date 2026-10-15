"""Project runner: exit codes, log streaming, launch params, module reload, threads."""

import builtins
import os
import shutil
import sys
import tempfile
import textwrap
import unittest

from xscript.runtime import bridge as bridge_mod
from xscript.runtime import runner


class LogBridge(bridge_mod._MissingJava):
    def __init__(self):
        self.lines = []

    def append_log(self, stream, line):
        self.lines.append((stream, line))

    def system(self, *a, **k):
        return "{}"


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.log = LogBridge()
        self.saved = (runner.bridge, sys.stdout, sys.stderr, list(sys.path), os.getcwd(), dict(runner._context))
        runner.bridge = self.log
        self.addCleanup(self.restore)

    def restore(self):
        runner.bridge, sys.stdout, sys.stderr, path, cwd, ctx = self.saved
        sys.path[:] = path
        os.chdir(cwd)
        runner._context.clear()
        runner._context.update(ctx)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def project(self, name, code, **files):
        d = os.path.join(self.tmp, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "__init__.py"), "w", encoding="utf-8") as f:
            f.write(textwrap.dedent(code))
        for rel, text in files.items():
            p = os.path.join(d, rel.replace("__", "/") if "/" in rel else rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(textwrap.dedent(text))
        return d

    def out(self, stream="stdout"):
        return "".join(line for s, line in self.log.lines if s == stream)

    def test_success_logs_and_context(self):
        d = self.project("rp_ok", """
            from xscript.runtime import runner
            print("hello", runner.project_name())
            print("dir ok" if runner.project_dir().endswith("rp_ok") else "dir bad")
        """)
        self.assertEqual(runner.run_project(d), 0)
        text = self.out()
        self.assertIn("xscript: starting rp_ok\n", text)
        self.assertIn("hello rp_ok\n", text)
        self.assertIn("dir ok\n", text)
        self.assertIn("xscript: finished rp_ok\n", text)
        self.assertEqual(os.path.realpath(os.getcwd()), os.path.realpath(d))

    def test_exit_codes_follow_cpython(self):
        cases = [("raise SystemExit(3)", 3), ("raise SystemExit(0)", 0), ("raise SystemExit()", 0),
                 ("import sys; sys.exit(None)", 0), ("raise SystemExit('fatal: no config')", 1),
                 ("raise KeyboardInterrupt", 130), ("1/0", 1), ("raise RuntimeError('boom')", 1)]
        for i, (code, expected) in enumerate(cases):
            self.log.lines.clear()
            d = self.project("rp_exit%d" % i, code + "\n")
            self.assertEqual(runner.run_project(d), expected, code)
        # A string exit message is shown, like CPython prints it to stderr.
        self.log.lines.clear()
        runner.run_project(self.project("rp_msg", "raise SystemExit('fatal: no config')\n"))
        self.assertIn("fatal: no config", self.out("stderr") + self.out())

    def test_exception_traceback_goes_to_stderr(self):
        d = self.project("rp_err", "def f():\n    raise ValueError('bad value 42')\nf()\n")
        self.assertEqual(runner.run_project(d), 1)
        err = self.out("stderr")
        self.assertIn("Traceback", err)
        self.assertIn("ValueError: bad value 42", err)
        self.assertNotIn("xscript: finished", self.out())

    def test_missing_entry(self):
        d = os.path.join(self.tmp, "rp_empty")
        os.makedirs(d)
        with self.assertRaises(RuntimeError):
            runner.run_project(d)

    def test_rerun_picks_up_edits_and_subpackages(self):
        d = self.project("rp_edit", "from rp_edit import lib\nprint('v', lib.V)\n", **{"lib.py": "V = 1\n"})
        runner.run_project(d)
        with open(os.path.join(d, "lib.py"), "w") as f:
            f.write("V = 2\n")
        # Make sure the new source is not hidden by a cached .pyc with the same mtime.
        shutil.rmtree(os.path.join(d, "__pycache__"), ignore_errors=True)
        self.log.lines.clear()
        runner.run_project(d)
        self.assertIn("v 2\n", self.out())

    def test_absolute_imports_of_project_subpackages(self):
        d = self.project("rp_abs", "from framework.actor import NAME\nprint(NAME)\n",
                         **{"framework/__init__.py": "", "framework/actor.py": "NAME = 'actor'\n"})
        self.assertEqual(runner.run_project(d), 0)
        self.assertIn("actor\n", self.out())

    def test_launch_params(self):
        d = self.project("rp_params", """
            import builtins
            from xscript.runtime import runner
            print("p", runner.params())
            print("g", getattr(builtins, "gold", None))
            print("print is builtin", callable(print) and print is builtins.print)
        """)
        try:
            self.assertEqual(runner.run_project(d, '{"gold": 5, "print": 1, "not-ident": 2}'), 0)
            text = self.out()
            self.assertIn("p {'gold': 5, 'print': 1, 'not-ident': 2}\n", text)
            self.assertIn("g 5\n", text)
            self.assertIn("print is builtin True\n", text, "params never shadow real builtins")
            for bad in ("not json", "[1, 2]", ""):
                runner._apply_params(bad)
                self.assertEqual(runner.params(), {}, bad)
        finally:
            if hasattr(builtins, "gold"):
                del builtins.gold

    def test_waits_for_non_daemon_threads(self):
        d = self.project("rp_thread", """
            import threading, time
            def work():
                time.sleep(0.2)
                print("worker done")
            threading.Thread(target=work, name="w1").start()
            print("main done")
        """)
        self.assertEqual(runner.run_project(d), 0)
        text = self.out()
        self.assertIn("xscript: waiting for thread w1\n", text)
        self.assertLess(text.index("worker done"), text.index("xscript: finished"))


class StreamTest(unittest.TestCase):
    def setUp(self):
        self.log = LogBridge()
        self.saved = runner.bridge
        runner.bridge = self.log
        self.addCleanup(lambda: setattr(runner, "bridge", self.saved))

    def test_line_buffering_flush_and_long_lines(self):
        s = runner._Stream("stdout")
        self.assertEqual(s.write("a"), 1)
        s.write("b\nc")
        self.assertEqual(self.log.lines, [("stdout", "ab\n")])
        s.write("\n\n")
        self.assertEqual(self.log.lines[1:], [("stdout", "c\n"), ("stdout", "\n")])
        s.write("tail")
        s.flush()
        self.assertEqual(self.log.lines[-1], ("stdout", "tail\n"))
        s.flush()
        self.assertEqual(len(self.log.lines), 4, "empty flush writes nothing")
        self.log.lines.clear()
        s.write("x" * 5000)  # no newline: emitted once the buffer passes 4 KiB
        self.assertEqual(self.log.lines, [("stdout", "x" * 5000 + "\n")])
        self.assertEqual(s.write(""), 0)
        self.assertEqual(s.write(None), 0)
        self.assertFalse(s.isatty())

    def test_print_through_stream_with_unicode(self):
        s = runner._Stream("stderr")
        print("中文", 1, sep="|", file=s)
        self.assertEqual(self.log.lines, [("stderr", "中文|1\n")])


if __name__ == "__main__":
    unittest.main()
