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


class Decide(unittest.TestCase):
    def test_empty_or_unknown_runs_everything(self):
        self.assertEqual(ci.decide([]), {"android": True, "desktop": True})
        self.assertEqual(ci.decide(["protocol/x.md"]), {"android": True, "desktop": True})
        self.assertEqual(ci.decide(["newdir/a.py"]), {"android": True, "desktop": True})

    def test_workflow_and_scripts_run_everything(self):
        for f in (".github/workflows/ci.yml", "scripts/check_16kb.py", "scripts/mock_device.py"):
            self.assertEqual(ci.decide([f]), {"android": True, "desktop": True}, f)

    def test_desktop_only_skips_android(self):
        self.assertEqual(ci.decide(["desktop/app/x.py", "desktop/frontend/src/a.tsx"]), {"android": False, "desktop": True})

    def test_android_only_skips_desktop(self):
        self.assertEqual(ci.decide(["android/app/build.gradle.kts", "android/app/src/main/java/A.kt"]), {"android": True, "desktop": False})

    def test_python_runtime_runs_desktop_too(self):
        self.assertEqual(ci.decide(["android/python-runtime/xscript/android/action.py"]), {"android": True, "desktop": True})

    def test_docs_skip_android_but_not_desktop(self):
        self.assertEqual(ci.decide(["docs/桌面端-测试方案.md"]), {"android": False, "desktop": True})

    def test_root_docs_and_other_areas_skip_both(self):
        self.assertEqual(ci.decide(["CHANGELOG.md", "README.md"]), {"android": False, "desktop": False})
        self.assertEqual(ci.decide(["backend/xscript_server/app.py", "ide/vscode-extension/src/a.ts"]), {"android": False, "desktop": False})

    def test_ide_stubs_run_desktop(self):
        self.assertEqual(ci.decide(["ide/python-stubs/xscript/action.pyi"]), {"android": False, "desktop": True})

    def test_a_mix_runs_what_any_file_needs(self):
        self.assertEqual(ci.decide(["CHANGELOG.md", "android/app/a.kt", "desktop/app/b.py"]), {"android": True, "desktop": True})


class Cli(unittest.TestCase):
    def run_cli(self, *args: str) -> str:
        return subprocess.run([sys.executable, str(REPO / "scripts" / "ci_changes.py"), *args], capture_output=True, text=True, check=True, cwd=REPO).stdout

    def test_all(self):
        self.assertEqual(self.run_cli("--all"), "android=true\ndesktop=true\n")

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
            self.assertEqual(out.stdout, "android=false\ndesktop=true\n")
            self.assertIn("docs/桌面端-测试方案.md", out.stderr)

    def test_a_bad_revision_runs_everything(self):
        self.assertEqual(self.run_cli("0" * 40, "HEAD"), "android=true\ndesktop=true\n")


if __name__ == "__main__":
    unittest.main()
