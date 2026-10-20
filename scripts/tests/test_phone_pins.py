"""The CI runtime job installs the phone's library versions (android/app/build.gradle.kts) wherever PyPI has a
CPython 3.10 Linux wheel, so the runtime tests exercise what ships. This keeps the two lists from drifting.
Run: python -m unittest scripts/tests/test_phone_pins.py"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Phone version -> CI version, where PyPI has no cp310 wheel for the phone's version. Keep the same minor release.
NO_WHEEL = {"opencv-python": ("opencv-python-headless", "4.5.4.60")}  # 4.5.1.48 has wheels up to cp39 only
# Test-only libraries the APK does not bundle (installed by scripts at runtime on the phone).
CI_ONLY = {"onnxruntime", "coverage"}


def phone_pins() -> dict[str, str]:
    text = (REPO / "android" / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    return {m[0].lower(): m[1] for m in re.findall(r'install\("([A-Za-z0-9_.\-]+)==([^"]+)"\)', text)}


def ci_pins() -> dict[str, str]:
    text = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    m = re.search(r"# phone-pins\n\s+run: python -m pip install (.+)\n", text)
    assert m, "ci.yml: the runtime job's install step must follow a '# phone-pins' comment"
    return {k.lower(): v for k, v in (p.split("==", 1) for p in m.group(1).split())}


class PhonePins(unittest.TestCase):
    def test_phone_pins_are_found(self):
        self.assertTrue({"numpy", "pillow", "requests", "pyyaml", "packaging", "opencv-python"} <= phone_pins().keys(), phone_pins())

    def test_ci_installs_the_phone_versions(self):
        phone, ci = phone_pins(), ci_pins()
        for name, version in phone.items():
            if name in NO_WHEEL:
                sub, sub_version = NO_WHEEL[name]
                self.assertEqual(ci.get(sub), sub_version, name)
                self.assertEqual(sub_version.split(".")[:2], version.split(".")[:2], "%s: keep the phone's minor release" % name)
            else:
                self.assertEqual(ci.get(name), version, "%s: CI must pin the phone's %s" % (name, version))

    def test_ci_installs_nothing_unexplained(self):
        phone, ci = phone_pins(), ci_pins()
        allowed = set(phone) | {s for s, _ in NO_WHEEL.values()} | CI_ONLY
        self.assertEqual(set(ci) - allowed, set())


if __name__ == "__main__":
    unittest.main()
