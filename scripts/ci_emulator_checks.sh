#!/usr/bin/env bash
# Device checks on a throwaway CI emulator (.github/workflows/emulator-nightly.yml); also usable on a local disposable AVD:
#   ANDROID_SERIAL=emulator-5556 PKG=com.xscript.app.perf APK=app-debug.apk bash scripts/ci_emulator_checks.sh
# Installs the APK, grants what the app needs, then runs device_guide_smoke.py, device_endpoint_e2e.py (needs adb root),
# device_pairing_copy_e2e.py and the orientation section of device_float_e2e.py.
set -euo pipefail
: "${ANDROID_SERIAL:?set ANDROID_SERIAL to a disposable emulator}"
PKG=${PKG:-com.xscript.app}
APK=${APK:-android/app/build/outputs/apk/debug/app-debug.apk}
adb() { command adb -s "$ANDROID_SERIAL" "$@"; }

adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true
adb shell appops set "$PKG" SYSTEM_ALERT_WINDOW allow
adb shell settings put secure enabled_accessibility_services "$PKG/com.xscript.app.a11y.XscriptAccessibilityService"
adb shell settings put secure accessibility_enabled 1
adb shell am start -n "$PKG/com.xscript.app.LauncherActivity"
# (re)forward and wait for the device API: device_endpoint_e2e.py force-stops the app and turns networking off and on
wait_api() {
  adb forward tcp:19860 tcp:9860
  for _ in $(seq 1 60); do curl -sf http://127.0.0.1:19860/status >/dev/null && return 0; sleep 2; done
  echo "device API did not come up"; exit 1
}
wait_api

python3 scripts/device_guide_smoke.py http://127.0.0.1:19860
python3 scripts/device_endpoint_e2e.py "$PKG"
adb shell am start -n "$PKG/com.xscript.app.LauncherActivity"
wait_api
python3 scripts/device_pairing_copy_e2e.py "$PKG" http://127.0.0.1:19860
# the floating window keeps a position per orientation and re-fits after rotating
XS_PKG="$PKG" XS_ONLY=orientation python3 scripts/device_float_e2e.py "$ANDROID_SERIAL" http://127.0.0.1:19860
