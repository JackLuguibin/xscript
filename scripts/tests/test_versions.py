"""The version a device reports must be the App version: runtime __version__, the mock device and the demo backend
all follow android/app/build.gradle.kts versionName. Fails on drift (run by CI's self-test step)."""
import pathlib
import re
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


def app_version_name():
    s = (ROOT / "android/app/build.gradle.kts").read_text(encoding="utf-8")
    m = re.search(r'versionName = if \(packed\) packProp\("version_name", "[^"]*"\) else "([^"]*)"', s)
    assert m, "versionName not found in build.gradle.kts"
    return m.group(1)


class VersionsTest(unittest.TestCase):
    def test_runtime_version_is_app_version(self):
        s = (ROOT / "android/python-runtime/xscript/__init__.py").read_text(encoding="utf-8")
        self.assertEqual(re.search(r'^__version__ = "([^"]+)"', s, re.M).group(1), app_version_name())

    def test_ide_stub_version_is_app_version(self):
        s = (ROOT / "ide/python-stubs/xscript/__init__.pyi").read_text(encoding="utf-8")
        self.assertEqual(re.search(r"^__version__ = '([^']+)'", s, re.M).group(1), app_version_name())

    def test_mock_device_reports_app_version(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            import mock_device
        finally:
            sys.path.pop(0)
        self.assertEqual(mock_device.APP_VERSION, app_version_name())
        self.assertNotIn('"version": "', (ROOT / "scripts/mock_device.py").read_text(encoding="utf-8"),
                         "mock_device must not hard-code a device version")

    def test_demo_has_no_hardcoded_device_version(self):
        s = (ROOT / "backend/scripts/demo.py").read_text(encoding="utf-8")
        self.assertIn('"version": APP_VERSION', s)
        self.assertIsNone(re.search(r'"version": "\d+\.\d+\.\d+"', s))

    def test_release_check_agrees(self):
        r = subprocess.run(["bash", "scripts/release.sh", "check"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
