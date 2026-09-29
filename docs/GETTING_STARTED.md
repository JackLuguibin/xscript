# Getting started

## Build

Requirements:

- Android SDK
- JDK 17+ (the script defaults to Android Studio's JBR)
- **Python 3.10** on the build machine. Chaquopy needs its minor version to match the embedded 3.10.

`build_android.sh` finds `python3.10`, or installs it through `uv` if needed. You can also set `XSCRIPT_BUILD_PYTHON`.

```bash
./scripts/build_android.sh
# output: android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The APK bundles numpy 1.23.3, opencv 4.5.1.48, pillow 9.2.0, pyyaml, requests, OkHttp, and ML Kit Chinese OCR. It is about 100 MB.

## Device setup

1. Open XScript and grant notifications if asked.
2. **辅助权限管理** → turn on the XScript accessibility service.
3. **悬浮窗权限** → allow. This is needed for the floating stop button, dialogs, `ui.Window`, and the canvas.
4. **Root 权限** → grant `su` if the device has root. It enables root mode, `system.shell`, and screenshot fallback.
5. **运行模式** → `Root或激活模式` (auto) unless you need a specific channel.
6. Leave the app running. **开发者地址** shows `http://<ip>:<port>/`.

The server binds 9096. If that port is taken, for example by AScript's own server, it uses the next free port up to 9105. Always use the port shown in the app.

### Grants over adb

These are useful on emulators, or after every reinstall during development:

```bash
PKG=com.xscript.app
adb shell settings put secure enabled_accessibility_services $PKG/$PKG.a11y.XscriptAccessibilityService
adb shell settings put secure accessibility_enabled 1
adb shell cmd appops set $PKG SYSTEM_ALERT_WINDOW allow
adb shell am start -n $PKG/.MainActivity
```

The `enabled_accessibility_services` line replaces the whole list. Append to it instead if other services must stay on.

### MuMu and other emulators

- **Connecting:** `adb connect 127.0.0.1:5555` (MuMu 12 on macOS).
- **Black accessibility screenshots:** MuMu returns black frames from the accessibility screenshot API. XScript detects this and switches to root `screencap` automatically (`capture_source` in `/status`). Root must be on.
- **No `uiautomator`:** MuMu doesn't ship it, so node trees need the accessibility service even in root mode.
- **Untrusted touches (Android 12+):** taps that pass through another app's full-screen overlay above 0.8 opacity are dropped. This includes injected accessibility and `input` taps. XScript's own overlays stay within the limit. If taps stop working while a script runs, check `adb logcat | grep "Untrusted touch"`.

## Computer setup

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e mcp-server -e python-stubs
```

`python-stubs` provides autocomplete only, for both `xscript.*` and `ascript.*`.

Cursor MCP config (`~/.cursor/mcp.json` or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "xscript": {
      "command": "/absolute/path/to/xscript/.venv/bin/python",
      "args": ["-m", "xscript_mcp"],
      "env": { "XSCRIPT_DEVICE": "127.0.0.1:9096" }
    }
  }
}
```

Over USB, run `adb forward tcp:9096 tcp:9096` with the port shown in the app. Over Wi-Fi, set `XSCRIPT_DEVICE=<phone-ip>:<port>`.

## First script

```bash
export XSCRIPT_DEVICE=127.0.0.1:9096
.venv/bin/python scripts/vertical_slice.py          # upload + run examples/settings_search
.venv/bin/python scripts/vertical_slice.py --mock   # same loop against the in-repo mock device
```

The slice uploads `examples/settings_search`, runs it, and pulls logs and a screenshot. `examples/xs_smoke` exercises the native API. `examples/as_demo` exercises the AScript API.

To upload a whole project directory, including AScript projects:

```python
from xscript_mcp.client import DeviceClient, DeviceTarget
c = DeviceClient(DeviceTarget.parse("127.0.0.1:9096"))
c.upload_directory("my_proj", "path/to/my_proj")
c.run_project("my_proj")
```

## Tests

```bash
./scripts/verify.sh
```

This runs the runtime tests (with `.venv-rt` if present; it needs numpy, opencv-python, and pillow), the MCP tests, a stub freshness check, and the mock vertical slice. After changing `python-runtime/`, run `python3 scripts/gen_stubs.py`.

Android JVM unit tests (log tail reader):

```bash
./scripts/build_android.sh :app:testDebugUnitTest
```

## Security

There is no authentication on the HTTP port or the cloud relay. Anyone who can reach them can run code on the phone. See the README.
