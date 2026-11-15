"""scripts/ci_changes.py: which heavy CI jobs a pull request may skip. Run: python -m unittest scripts/tests/test_ci_changes.py"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("ci_changes", REPO / "scripts" / "ci_changes.py")
ci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci)  # type: ignore[union-attr]


def heavy(files):
    """android/desktop only (the postgres area has its own tests)."""
    d = ci.decide(files)
    return {"android": d["android"], "desktop": d["desktop"]}


class Decide(unittest.TestCase):
    def test_empty_or_unknown_runs_everything(self):
        self.assertEqual(heavy([]), {"android": True, "desktop": True})
        self.assertEqual(heavy(["protocol/x.md"]), {"android": True, "desktop": True})
        self.assertEqual(heavy(["newdir/a.py"]), {"android": True, "desktop": True})

    def test_workflow_and_scripts_run_everything(self):
        for f in (".github/workflows/ci.yml", "scripts/check_16kb.py", "scripts/mock_device.py"):
            self.assertEqual(heavy([f]), {"android": True, "desktop": True}, f)

    def test_desktop_only_skips_android(self):
        self.assertEqual(heavy(["desktop/app/x.py", "desktop/frontend/src/a.tsx"]), {"android": False, "desktop": True})

    def test_android_only_skips_desktop(self):
        self.assertEqual(heavy(["android/app/build.gradle.kts", "android/app/src/main/java/A.kt"]), {"android": True, "desktop": False})

    def test_pycharm_plugin_only_skips_heavy_jobs(self):
        d = ci.decide(["ide/pycharm-plugin/build.gradle.kts", "ide/pycharm-plugin/src/main/kotlin/A.kt"])
        self.assertEqual({k: d[k] for k in ("android", "desktop", "postgres", "runtime", "python")},
                         {"android": False, "desktop": False, "postgres": False, "runtime": False, "python": False})

    def test_python_runtime_runs_desktop_too(self):
        self.assertEqual(heavy(["android/python-runtime/xscript/android/action.py"]), {"android": True, "desktop": True})

    def test_docs_skip_android_but_not_desktop(self):
        self.assertEqual(heavy(["docs/桌面端-测试方案.md"]), {"android": False, "desktop": True})

    def test_root_docs_and_other_areas_skip_both(self):
        self.assertEqual(heavy(["CHANGELOG.md", "README.md"]), {"android": False, "desktop": False})
        self.assertEqual(heavy(["backend/xscript_server/app.py", "ide/vscode-extension/src/a.ts"]), {"android": False, "desktop": False})

    def test_ide_stubs_run_desktop(self):
        self.assertEqual(heavy(["ide/python-stubs/xscript/action.pyi"]), {"android": False, "desktop": True})

    def test_a_mix_runs_what_any_file_needs(self):
        self.assertEqual(heavy(["CHANGELOG.md", "android/app/a.kt", "desktop/app/b.py"]), {"android": True, "desktop": True})


class Postgres(unittest.TestCase):
    def test_backend_python_runs_it(self):
        self.assertTrue(ci.decide(["backend/xscript_server/db.py"])["postgres"])
        self.assertTrue(ci.decide(["backend/tests/test_server.py", "README.md"])["postgres"])
        self.assertTrue(ci.decide(["backend/pyproject.toml"])["postgres"])

    def test_workflow_scripts_and_unknown_run_it(self):
        for f in (".github/workflows/ci.yml", "scripts/ci_changes.py", "newdir/a.py"):
            self.assertTrue(ci.decide([f])["postgres"], f)
        self.assertTrue(ci.decide([])["postgres"])

    def test_console_docs_and_clients_skip_it(self):
        files = ["backend/web/src/App.tsx", "backend/README.md", "docs/部署.md", "android/app/a.kt",
                 "desktop/app/b.py", "ide/mcp-server/x.py", "CHANGELOG.md"]
        self.assertFalse(ci.decide(files)["postgres"])


class RuntimeAndPython(unittest.TestCase):
    """The always-on Python jobs: the runtime tests (phone library pins) and backend + MCP + generated files."""

    def pick(self, files):
        d = ci.decide(files)
        return {"runtime": d["runtime"], "python": d["python"]}

    def test_runtime_code_runs_both(self):
        # the runtime is the source of the stubs, the completion index and the node specs
        self.assertEqual(self.pick(["android/python-runtime/xscript/android/screen.py"]), {"runtime": True, "python": True})

    def test_phone_pins_run_the_runtime_job(self):
        self.assertTrue(self.pick(["android/app/build.gradle.kts"])["runtime"])

    def test_kotlin_ui_and_docs_skip_both(self):
        files = ["android/app/src/main/java/com/xscript/app/MainActivity.kt", "android/app/src/main/res/values/strings.xml",
                 "android/app/src/test/java/A.kt", "docs/路线图.md", "README.md", "CHANGELOG.md"]
        self.assertEqual(self.pick(files), {"runtime": False, "python": False})

    def test_desktop_and_console_and_vscode_skip_both(self):
        files = ["desktop/app/xscript_desktop/window.py", "desktop/frontend/src/App.tsx", "backend/web/src/App.tsx",
                 "ide/vscode-extension/src/extension.ts"]
        self.assertEqual(self.pick(files), {"runtime": False, "python": False})

    def test_backend_and_mcp_run_python_only(self):
        self.assertEqual(self.pick(["backend/xscript_server/db.py"]), {"runtime": False, "python": True})
        self.assertEqual(self.pick(["ide/mcp-server/xscript_mcp/client.py"]), {"runtime": False, "python": True})

    def test_python_job_inputs_outside_backend_run_it(self):
        for f in ("android/app/src/main/assets/tools/editor-api.js", "desktop/nodes/generated/screen.json", "ide/python-stubs/xscript/android/screen.pyi",
                  "protocol/openapi.yaml", "scripts/mock_device.py"):
            self.assertTrue(self.pick([f])["python"], f)

    def test_workflow_scripts_and_unknown_run_both(self):
        for f in (".github/workflows/ci.yml", "scripts/ci_changes.py", "newdir/a.py"):
            self.assertEqual(self.pick([f]), {"runtime": True, "python": True}, f)
        self.assertEqual(self.pick([]), {"runtime": True, "python": True})


class ClientAreas(unittest.TestCase):
    def enabled(self, files):
        return {job for job in ci.JOB_INPUTS if ci.decide(files)[job]}

    def test_each_client_owns_its_changes(self):
        for path, area in [("desktop/frontend/src/App.tsx", None), ("backend/web/package-lock.json", "console"),
                           ("ide/vscode-extension/src/client.ts", "vscode"),
                           ("ide/pycharm-plugin/build.gradle.kts", "pycharm")]:
            self.assertEqual(self.enabled([path]), {area} if area else set(), path)

    def test_shared_tools_and_stubs_reach_all_consumers(self):
        for path in [ci.WEB_TOOLS + "editor-parse.js", "ide/python-stubs/xscript/action.pyi"]:
            self.assertEqual(self.enabled([path]), {"web_ide", "vscode", "pycharm"})
        self.assertEqual(self.enabled(["android/python-runtime/xscript/action.py"]), {"web_ide"})

    def test_template_sync_checker_reads_pycharm_resources(self):
        self.assertEqual(self.enabled(["ide/pycharm-plugin/src/main/resources/templates.json"]), {"vscode", "pycharm"})

    def test_docs_and_server_do_not_build_clients(self):
        self.assertEqual(self.enabled(["README.md", "docs/部署.md"]), set())
        self.assertEqual(self.enabled(["backend/xscript_server/db.py"]), {"web_ide"})

    def test_unknown_shared_inputs_fail_open(self):
        for path in ["scripts/mock_device.py", ".github/workflows/ci.yml", "new-root/file", "protocol/permission-fix.json"]:
            self.assertTrue(all(ci.decide([path]).values()), path)
        self.assertTrue(all(ci.decide([]).values()))

    def test_node_test_only_runs_web_ide_and_mixed_changes_are_not_lost(self):
        path = "scripts/tests/editor-http.test.cjs"
        self.assertEqual({k for k, v in ci.decide([path]).items() if v}, {"web_ide"})
        self.assertTrue(ci.decide([path, "android/app/src/main/java/A.kt"])["android"])



class Cli(unittest.TestCase):
    def run_cli(self, *args: str) -> str:
        return subprocess.run([sys.executable, str(REPO / "scripts" / "ci_changes.py"), *args], capture_output=True, text=True, check=True, cwd=REPO).stdout

    def test_all(self):
        self.assertEqual(self.run_cli("--all"), "".join(k + "=true\n" for k in ci.ALL))

    def test_reads_a_real_diff_with_a_chinese_path(self):
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}

            def git(*a: str) -> str:
                return subprocess.run(["git", *a], cwd=d, env=env, capture_output=True, text=True, check=True).stdout.strip()

            git("init", "-q")
            Path(d, "README.md").write_text("x")
            git("add", "-A")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            Path(d, "docs").mkdir()
            Path(d, "docs", "桌面端-测试方案.md").write_text("y")
            git("add", "-A")
            git("commit", "-qm", "docs")
            out = subprocess.run([sys.executable, str(REPO / "scripts" / "ci_changes.py"), base, "HEAD"], cwd=d,
                                 capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout, "android=false\ndesktop=true\npostgres=false\nruntime=false\npython=false\nweb_ide=false\nvscode=false\npycharm=false\nconsole=false\n")
            self.assertIn("docs/桌面端-测试方案.md", out.stderr)

    def test_rename_keeps_deleted_area_in_scope(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
            def git(*args):
                return subprocess.run(["git", *args], cwd=d, env=env, capture_output=True, text=True, check=True).stdout.strip()
            git("init", "-q")
            old = Path(d, "backend", "old.py")
            old.parent.mkdir()
            old.write_text("x = 1")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            Path(d, "docs").mkdir()
            old.rename(Path(d, "docs", "new.py"))
            git("add", "-A")
            git("commit", "-qm", "move")
            out = subprocess.run([sys.executable, str(REPO / "scripts/ci_changes.py"), base, "HEAD"],
                                 cwd=d, capture_output=True, text=True, check=True)
            self.assertIn("backend/old.py", out.stderr)
            self.assertIn("docs/new.py", out.stderr)
            self.assertIn("postgres=true", out.stdout)

    def test_a_bad_revision_runs_everything(self):
        self.assertEqual(self.run_cli("0" * 40, "HEAD"), "".join(k + "=true\n" for k in ci.ALL))


if __name__ == "__main__":
    unittest.main()
