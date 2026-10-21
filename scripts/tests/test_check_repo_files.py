import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_repo_files as c  # noqa: E402


class RulesTest(unittest.TestCase):
    def test_symlinks_and_dependency_folders(self):
        self.assertTrue(c.problems_for("120000", "desktop/frontend/node_modules", 60))
        self.assertTrue(c.problems_for("120000", "docs/link.md", 10))
        self.assertTrue(c.problems_for("100644", "ide/x/node_modules/a/index.js", 10))
        self.assertTrue(c.problems_for("100644", "desktop/app/.venv/bin/python", 10))
        self.assertTrue(c.problems_for("100644", "pkg/__pycache__/m.cpython-312.pyc", 10))
        self.assertTrue(c.problems_for("100644", "desktop/frontend/dist/index.html", 10))
        self.assertTrue(c.problems_for("160000", "vendor/lib", None))

    def test_compiled_and_big_files(self):
        self.assertTrue(c.problems_for("100644", "a/b.pyc", 1))
        self.assertTrue(c.problems_for("100644", "ide/vscode-extension/xscript-0.4.0.vsix", 1))
        self.assertTrue(c.problems_for("100644", "app-debug.apk", 1))
        self.assertTrue(c.problems_for("100644", "docs/huge.png", c.MAX_BYTES + 1))

    def test_normal_files_and_allowlist(self):
        self.assertEqual(c.problems_for("100644", "docs/images/a.png", 200_000), [])
        self.assertEqual(c.problems_for("100755", "scripts/build.sh", 100), [])
        self.assertEqual(c.problems_for("100644", "desktop/app/xscript_desktop/build_info.py", 100), [])  # "build" only as a folder
        self.assertEqual(c.problems_for("100644", "android/gradle/wrapper/gradle-wrapper.jar", 60_000), [])


class RepoTest(unittest.TestCase):
    def test_tracked_files_are_clean(self):
        files = c.entries(False)
        size = c.sizes([oid for _, oid, _ in files])
        found = [p for mode, oid, path in files for p in c.problems_for(mode, path, size.get(oid))]
        self.assertGreater(len(size), 100)
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
