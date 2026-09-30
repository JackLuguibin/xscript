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

The server binds 9860, away from AScript's 9096, so both apps can be installed and running at the same time. If 9860 is taken it uses the next free port up to 9869. Always use the port shown in the app.

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

- **Connecting:** `adb connect 127.0.0.1:16384` (MuMu 12 on macOS; `127.0.0.1:5555` also works). Then forward the port, see [Port forwarding](#port-forwarding).
- **Black accessibility screenshots:** MuMu returns black frames from the accessibility screenshot API. XScript detects this and switches to root `screencap` automatically (`capture_source` in `/status`). Root must be on.
- **No `uiautomator`:** MuMu doesn't ship it, so node trees need the accessibility service even in root mode.
- **Untrusted touches (Android 12+):** taps that pass through another app's full-screen overlay above 0.8 opacity are dropped. This includes injected accessibility and `input` taps. XScript's own overlays stay within the limit. If taps stop working while a script runs, check `adb logcat | grep "Untrusted touch"`.

## Computer setup

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e mcp-server -e python-stubs
```

`python-stubs` provides autocomplete only, for both `xscript.*` and `ascript.*`.

Cursor MCP config. The repo ships `.cursor/mcp.json` already pointing at the project venv:

```json
{
  "mcpServers": {
    "xscript": {
      "command": "${workspaceFolder}/.venv/bin/python",
      "args": ["-m", "xscript_mcp"],
      "env": { "XSCRIPT_DEVICE": "127.0.0.1:9860" }
    }
  }
}
```

`command` must be the `.venv` Python. A system `python3.12` has no `xscript_mcp` installed, so the MCP server exits at startup with `No module named 'xscript_mcp'`. For a global `~/.cursor/mcp.json`, use the absolute path to `.venv/bin/python` instead of `${workspaceFolder}`.

After changing `mcp.json`, turn the xscript server off and on again in Cursor's MCP settings, or restart Cursor.

## Connecting to the device

Over Wi-Fi, set `XSCRIPT_DEVICE=<phone-ip>:<port>` using the address shown in **开发者地址**. Over USB or on an emulator, forward the port with adb.

### Port forwarding

```bash
# Emulator only: attach adb to MuMu first (finding the port is covered below).
adb connect 127.0.0.1:16384

# Forward local 9860 to the app's 9860. Use -s when more than one device is listed.
adb -s 127.0.0.1:16384 forward tcp:9860 tcp:9860

# Check it.
adb forward --list
curl http://127.0.0.1:9860/status
```

`/status` returning device JSON means the forward works. Use the port shown in the app if it is not 9860.

MuMu on macOS exposes adb on more than one port and the numbers vary by version and instance. Look for the listening ports:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i mumu
```

On MuMu 12 the first instance is usually `127.0.0.1:16384`, and `127.0.0.1:5555` also works. If both show up in `adb devices`, they are the same emulator. Pick one and pass it with `-s`.

### When it stops connecting

A forward lives in the adb server, so it disappears whenever the emulator restarts, adb disconnects, or the adb server restarts. Work through these in order:

1. **`adb devices` is empty.** Run `adb connect 127.0.0.1:16384` again. If it says `offline`, run `adb disconnect 127.0.0.1:16384` first, then connect again.
2. **The device is listed but `curl` fails.** The forward is gone. Run `adb forward --list`, then the `forward` command again.
3. **Still failing.** Check that the app is running and listening:

   ```bash
   adb -s 127.0.0.1:16384 shell "ps -A | grep xscript"
   adb -s 127.0.0.1:16384 shell "ss -ltn | grep 986"
   ```

   If nothing is listening, open XScript on the device (`adb -s 127.0.0.1:16384 shell am start -n com.xscript.app/.MainActivity`).
4. **`curl` works but Cursor still cannot connect.** Check that `mcp.json` uses the `.venv` Python and `XSCRIPT_DEVICE=127.0.0.1:9860`, then toggle the MCP server. Errors show up in Cursor under **Output → MCP Logs**.

XScript listens on 9860 and AScript on 9096, so both apps can be installed at once. Forward the port for the app you want to reach. `adb forward tcp:9096 ...` reaches AScript, not XScript.

## First script

```bash
export XSCRIPT_DEVICE=127.0.0.1:9860
.venv/bin/python scripts/vertical_slice.py          # upload + run examples/settings_search
.venv/bin/python scripts/vertical_slice.py --mock   # same loop against the in-repo mock device
```

The slice uploads `examples/settings_search`, runs it, and pulls logs and a screenshot. `examples/xs_smoke` exercises the native API. `examples/as_demo` exercises the AScript API.

To upload a whole project directory, including AScript projects:

```python
from xscript_mcp.client import DeviceClient, DeviceTarget
c = DeviceClient(DeviceTarget.parse("127.0.0.1:9860"))
c.upload_directory("my_proj", "path/to/my_proj")
c.run_project("my_proj")
```

## Tests

```bash
./scripts/verify.sh
```

This runs the runtime tests (with `.venv-rt` if present; it needs numpy, opencv-python, and pillow), the MCP tests, a stub freshness check, and the mock vertical slice. After changing `python-runtime/`, run `python3 scripts/gen_stubs.py`.

Android JVM unit tests (log tail reader, datasets, snapshots):

```bash
./scripts/build_android.sh :app:testDebugUnitTest
```

## Security

There is no authentication on the HTTP port or the cloud relay. Anyone who can reach them can run code on the phone. See the README.
