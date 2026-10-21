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

    def test_ui_try_e2e_masks_codes_and_mirrors_the_desktop_entry(self):
        import sys
        sys.path.insert(0, str(SCRIPTS))
        import device_ui_try_e2e as m
        self.assertEqual(m.mask("码 ABCD-EF12 / WXYZ5678，进度 12%"), "码 ****-**** / ****-****，进度 12%")
        main = m.try_main("settings")
        self.assertIn("from ui_settings import show\n", main)
        self.assertIn('print("界面返回：" + json.dumps(values, ensure_ascii=False), flush=True)', main)
        # the script prints UI text only through mask(); the raw dump never reaches print()
        src = (SCRIPTS / "device_ui_try_e2e.py").read_text(encoding="utf-8")
        for line in src.splitlines():
            if "print(" in line and "mask(" not in line:
                self.assertNotRegex(line, r"nodes\(|dump|ns\b", line)

    def test_ui_dump_scripts_mask_pairing_codes(self):
        # the home screen shows the pairing code: a script that dumps the UI masks what it prints with devauth.mask
        quiet = {"device_pairing_copy_e2e.py"}  # prints only fixed strings, never dump text
        dumping = [p for p in PY if "uiautomator" in p.read_text(encoding="utf-8") and p.name not in quiet]
        self.assertGreaterEqual(len(dumping), 6)
        bad = [p.name for p in dumping if not re.search(r"devauth\.mask|from devauth import mask", p.read_text(encoding="utf-8"))]
        self.assertEqual(bad, [], "use devauth.mask on printed UI text")

    def test_guide_smoke_run_waits_for_the_previous_run(self):
        # "finished" is logged just before /status stops reporting the run: run() waits with devauth.wait_idle first
        import sys
        from unittest import mock
        sys.path.insert(0, str(SCRIPTS))
        import device_guide_smoke as m
        order = []

        def call(method, path, data=None, ctype=None):
            order.append(method + " " + path.split("?")[0])
            if path.startswith("/logs?"):
                return {"entries": [{"line": "xscript: finished xs_t"}], "next": 1}
            return {"running": True} if path.endswith("/run") else {}

        with mock.patch.object(m, "call", call), mock.patch.object(m.time, "sleep"), \
                mock.patch.object(m.devauth, "wait_idle", lambda base: order.append("wait_idle")):
            m.run("xs_t", "print(1)", quiet=True)
        self.assertLess(order.index("wait_idle"), order.index("POST /projects/xs_t/run"))
        self.assertFalse(hasattr(m, "wait_idle"), "use the shared devauth.wait_idle")

if __name__ == "__main__":
    unittest.main()
