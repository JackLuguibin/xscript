import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import flake_rate  # noqa: E402

XML = """<?xml version="1.0"?><testsuites><testsuite name="s">
<testcase classname="a" name="ok"/>
<testcase classname="a" name="bad"><failure message="x"/></testcase>
<testcase classname="a" name="err"><error message="x"/></testcase>
<testcase classname="a" name="skipped"><skipped/></testcase>
<testcase name="bare"/>
<testcase classname="a" name="dup"/><testcase classname="a" name="dup"><failure/></testcase><testcase classname="a" name="dup"/>
</testsuite></testsuites>"""

# A fake test command: writes JUnit XML where "flip" fails on odd runs, "always" fails every time.
FAKE = textwrap.dedent("""
    import os, sys
    n = int(os.environ["FLAKE_RUN"])
    flip = '<failure/>' if n % 2 else ''
    open(sys.argv[1], "w").write('<testsuite><testcase classname="t" name="steady"/>'
        '<testcase classname="t" name="flip">%s</testcase>'
        '<testcase classname="t" name="always"><failure/></testcase></testsuite>' % flip)
    sys.exit(1)
""")


class FlakeRateTest(unittest.TestCase):
    def test_parse_junit(self):
        with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False) as f:
            f.write(XML)
        try:
            got = flake_rate.parse_junit(f.name)
        finally:
            os.remove(f.name)
        self.assertEqual(got, {"a::ok": "pass", "a::bad": "fail", "a::err": "fail", "a::skipped": "skip",
                               "bare": "pass", "a::dup": "fail"})
        self.assertEqual(flake_rate.parse_junit("/nonexistent.xml"), {})

    def test_summarize_separates_flaky_from_broken(self):
        runs = [
            {"exit": 1, "seconds": 1, "tests": {"x": "pass", "y": "fail", "z": "fail", "s": "skip"}},
            {"exit": 0, "seconds": 1, "tests": {"x": "pass", "y": "pass", "z": "fail", "s": "skip"}},
            {"exit": 1, "seconds": 1, "tests": {}},  # crashed before writing XML
            {"exit": 0, "seconds": 1, "tests": {"x": "fail", "y": "pass", "z": "fail"}},
        ]
        rep = flake_rate.summarize("demo", runs)
        self.assertEqual((rep["runs"], rep["failed_runs"], rep["tests"], rep["no_xml_runs"]), (4, 2, 3, 1))
        self.assertEqual(rep["run_failure_rate"], 0.5)
        self.assertEqual([(f["test"], f["failed"], f["of"]) for f in rep["flaky"]], [("x", 1, 3), ("y", 1, 3)])
        self.assertEqual(rep["broken"], ["z"])
        md = flake_rate.markdown(rep)
        self.assertIn("| `x` | 1 / 3 | 33% |", md)
        self.assertIn("broken, not flaky", md)
        self.assertIn("1 run(s) wrote no JUnit XML", md)
        self.assertIn("No flaky tests.", flake_rate.markdown(flake_rate.summarize("ok", runs[1:2])))

    def test_end_to_end_with_a_fake_command(self):
        d = tempfile.mkdtemp()
        fake, out, summary = os.path.join(d, "fake.py"), os.path.join(d, "r.json"), os.path.join(d, "sum.md")
        Path(fake).write_text(FAKE)
        old = os.environ.get("GITHUB_STEP_SUMMARY")
        os.environ["GITHUB_STEP_SUMMARY"] = summary
        try:
            code = flake_rate.main(["--name", "fake", "--runs", "3", "--out", out, "--", sys.executable, fake, "{junit}"])
        finally:
            if old is None:
                os.environ.pop("GITHUB_STEP_SUMMARY")
            else:
                os.environ["GITHUB_STEP_SUMMARY"] = old
        self.assertEqual(code, 0, "a report, not a gate")
        rep = json.loads(Path(out).read_text())
        self.assertEqual(rep["failed_runs"], 3)
        self.assertEqual([(f["test"], f["failed"], f["of"]) for f in rep["flaky"]], [("t::flip", 2, 3)])
        self.assertEqual(rep["broken"], ["t::always"])
        self.assertIn("Flake rate: fake", Path(summary).read_text())
        self.assertEqual(flake_rate.main(["--name", "f", "--runs", "2", "--max-flaky", "0", "--",
                                          sys.executable, fake, "{junit}"]), 1)


if __name__ == "__main__":
    unittest.main()
