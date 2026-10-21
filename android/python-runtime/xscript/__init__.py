"""On-device XScript runtime package."""

# The App version (android/app/build.gradle.kts versionName): this file is the copy the device runtime reports, and
# scripts/mock_device.py / backend/scripts/demo.py read it from here. `scripts/release.sh prepare` bumps it,
# `release.sh check` and scripts/tests/test_versions.py fail when it drifts from versionName.
__version__ = "0.5.0"
