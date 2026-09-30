# XScript

XScript is an Android Python automation app in the style of AScript. It runs Python scripts on the phone, and AScript scripts run unchanged. You write the script on a computer (or with Cursor through MCP), push it to the phone, and it runs on-device.

```
Cursor / MCP / browser  →  HTTP :9860  →  XScript app  →  accessibility / root + Python 3.10
Cloud control server    ←  WebSocket (device dials out)  ↗
```

## Features

- **Home page.** Modeled on AScript: 开发者地址, AI 编程连接, 运行模式, 悬浮窗权限, Root 权限, 图色权限, 云端控制, 小程序列表, 辅助权限管理, 开发者选项.
- **Run modes.** `auto`, `accessibility`, or `root`. Gestures, node trees, and screenshots each fall back to root when accessibility is missing. Screenshots also fall back when the accessibility frame is black.
- **Script APIs** (`xscript.android.*`):
  - `action`: gestures, keys, and text input.
  - `node`: selectors with relations.
  - `screen`: multi-point colors, masked multi-scale template matching, and ML Kit OCR.
  - `system`: apps, shell, device info, KeyValue, and R paths.
  - `ui`: dialogs, HTML windows with a JS bridge, a drawing canvas, and the floating stop button.
- **AScript compatibility** (`ascript.android.*`). Follows the ascript-tip 1.3.0 API, so `from ascript.android.screen import FindImages` works unchanged.
- **Projects.** Create, zip import/export, import from AScript (`/sdcard/airscript/model`), an on-device editor, run logs, and the floating stop button.
- **Cloud control.** The device dials out to a WebSocket relay and serves the same API through it, so it works behind NAT.
- **Cursor MCP** (`xscript-mcp`). Screenshots, UI tree, file upload, run/stop, logs, eval, and an API catalog. Eval runs in its own process, which is killed on timeout.
- **Developer tools in the browser** at `http://<ip>:<port>/tools/`, served by the app:
  - **图色工具**: freeze a screenshot, pick colors with a zoom loupe, build multi-point color strings, select regions, save template crops into a project, and test find-color / compare-color / find-image / OCR on that frame.
  - **标注工具**: add screenshots or uploads to a dataset, draw and label boxes, and export a YOLO training set (`images/`, `labels/`, `data.yaml`).
  - **投屏**: live MJPEG mirror. Clicking the image clicks the phone, dragging swipes, and there are buttons for 返回 / 主页 / 最近任务.

## Repo layout

| Path | Role |
| --- | --- |
| `android/` | Kotlin app: HTTP server, accessibility/root engines, capture, OCR, overlays, Chaquopy |
| `python-runtime/xscript/` | On-device `xscript` package |
| `python-runtime/ascript/` | AScript compatibility package |
| `python-runtime/tests/` | PC tests for the runtime (fake bridge) |
| `python-stubs/` | Generated `.pyi` stubs for PC autocomplete (`scripts/gen_stubs.py`) |
| `protocol/openapi.yaml` | Device HTTP contract |
| `mcp-server/` | Cursor MCP (`xscript-mcp`) |
| `examples/` | `settings_search`, `xs_smoke` (native API), `as_demo` (AScript API) |
| `docs/` | [Getting started](docs/GETTING_STARTED.md), [API](docs/API.md), [agent rules](docs/AGENT_RULES.md) |

## Quick start

```bash
./scripts/build_android.sh            # needs Android SDK, JDK 17+, and Python 3.10 on the build machine
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Open **XScript** on the phone and grant accessibility, the overlay (悬浮窗) permission, and root if you have it. The **开发者地址** row shows `http://<ip>:<port>/`. The port is 9860 (AScript uses 9096, so both apps can run side by side). If 9860 is taken the app uses the next free port up to 9869.

```bash
adb connect 127.0.0.1:16384            # MuMu emulator only
adb forward tcp:9860 tcp:9860          # use the port shown in the app; add -s <serial> with several devices
curl http://127.0.0.1:9860/status
```

The forward is lost whenever the emulator or adb restarts, so rerun these two adb commands. See [Connecting to the device](docs/GETTING_STARTED.md#connecting-to-the-device) for troubleshooting, and [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for the MCP setup, emulator notes (MuMu), and test commands.

## Script shape

The entry file is `__init__.py`, and the project directory is imported as a package with the project as the working directory.

```python
from xscript.android import action, node, screen

n = node.Selector().text("搜索").find(timeout=5)
if n:
    n.click()
hit = screen.find_image("res/img/ok.png", confidence=0.85)
if hit:
    action.click(*hit["result"])
```

Existing AScript projects work as-is:

```python
from ascript.android.screen import FindColors, Ocr
from ascript.android import action
p = FindColors.find("#ff4400|12,0,#ffffff")
if p:
    action.click(p.x, p.y)
```

## Security

The LAN HTTP server and the cloud relay have **no authentication**. Anyone who can reach the port can upload files and run arbitrary Python (`/eval`, `/projects/<name>/run`). Use XScript only on trusted networks, or over USB with `adb forward`. The server sends no CORS headers, so web pages open in your browser cannot read API responses. Put the cloud relay behind your own authenticated server; a token in the `wss://` URL is checked by the server, not by the app.

## Licenses

- Chaquopy 17 is MIT.
- The AScript compatibility layer and the template-matching strategy follow ascript-tip (MIT).
- ML Kit is covered by Google's terms.
- See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). XScript is not affiliated with AScript.
