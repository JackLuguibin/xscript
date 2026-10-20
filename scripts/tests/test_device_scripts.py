"""Static guards for the device test scripts (run by CI's self-test step)."""
import pathlib
import re
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]
PY = sorted(SCRIPTS.glob("*.py"))


class DeviceScriptsTest(unittest.TestCase):
    def test_no_bare_stop_endpoint(self):
        # the device API stops a run at POST /projects/{name}/stop; a bare /stop is a 404
        bad = [f"{p.name}:{i}" for p in PY for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
               if re.search(r"""["']POST["'],\s*["']/stop["']""", line)]
        self.assertEqual(bad, [], "scripts post to the non-existent /stop endpoint")

    def test_stop_errors_not_swallowed(self):
        # a stop call wrapped in try/except-pass hides a broken device API
        pat = re.compile(r"try:\s*\n\s*api\(\s*\"POST\",\s*\"/projects/[^\n]*/stop[^\n]*\n\s*except Exception:\s*\n\s*pass")
        bad = [p.name for p in PY if pat.search(p.read_text(encoding="utf-8"))]
        self.assertEqual(bad, [], "stop errors are swallowed")

    def test_launcher_activity_fully_qualified(self):
        # with a suffixed applicationId (e.g. com.xscript.app.perf) "pkg/.LauncherActivity" resolves to a missing class
        bad = [p.name for p in [*PY, *SCRIPTS.glob("*.sh")] if "/.LauncherActivity" in p.read_text(encoding="utf-8")]
        self.assertEqual(bad, [], "use PKG/com.xscript.app.LauncherActivity")

    def test_scheme_e2e_no_browser_links(self):
        # --no-browser sends the page's hrefs as intents: every *LINK must be found, exactly as written (a naive
        # html.unescape turns "&params" into "¶ms")
        src = (SCRIPTS / "device_scheme_e2e.py").read_text(encoding="utf-8")
        ns = {"re": re}
        exec(src[src.index('PAGE = """'):src.index("AUTO = ")], ns)
        page_labels = re.findall(r">([A-Z]+LINK)</a>", ns["PAGE"])
        self.assertEqual(sorted(ns["LINKS"]), sorted(page_labels))
        self.assertEqual(ns["LINKS"]["PARAMLINK"], 'xscript://run?name=linkdemo&params={"k":"v"}')
        self.assertIn('"--no-browser" in sys.argv', src)


if __name__ == "__main__":
    unittest.main()
