# XScript Python API

Scripts run inside the XScript app (Chaquopy, Python 3.10 with numpy, opencv, pillow, requests, pyyaml). Two API families are available:

- `xscript.android.*`: the native API, documented below.
- `ascript.android.*`: a drop-in layer for AScript scripts. See [AScript compatibility](#ascript-compatibility).

Coordinates are screen pixels in the current orientation. Rects are `[left, top, right, bottom]`. PC autocomplete is in `python-stubs/`. The MCP tools `get_module_apis` / `search_api` serve the same catalog (`mcp-server/xscript_mcp/api_catalog.json`).

## Run modes

The home screen's **运行模式** (`PUT /settings {"run_mode": ...}`) picks the channel for gestures and node actions:

| Mode | Gestures | Node tree | Screenshot |
| --- | --- | --- | --- |
| `auto` (default) | accessibility, root fallback | accessibility, root fallback | accessibility, root `screencap` fallback |
| `accessibility` | accessibility only | accessibility | accessibility |
| `root` | `input` / `sendevent` via `su` | `uiautomator dump` | `screencap` |

The capture engine switches to root automatically when the accessibility screenshot is black. MuMu does this. MuMu also ships without `uiautomator`, so root mode has no node tree there.

## action

```python
from xscript.android import action

action.click(540, 1200)              # also accepts a Point / (x, y) / Node
action.long_click(540, 1200, dur=800)
action.swipe(100, 1500, 100, 500, dur=300)
action.path([(100, 100), (300, 300), (500, 100)], dur=500)
action.gesture([                      # multi-finger, strokes run in parallel
    {"points": [(300, 800), (300, 400)], "duration": 400},
    {"points": [(700, 800), (700, 400)], "duration": 400},
])
action.input("hello")                # set text on the focused / first editable field
action.Touch.down(500, 500); action.Touch.move(500, 900); action.Touch.up(500, 900)
action.Key.back(); action.Key.home(); action.Key.recents(); action.Key.notifications()
action.Key.code(66)                  # raw keyevent (root)
```

## node

```python
from xscript.android import node

n = node.Selector().text("搜索").find(timeout=5)       # Node or None
if n:
    n.click()
    n.set_text("wifi")

node.Selector().id("com.android.settings:id/search").clickable().find()
node.Selector().text_contains("网络").find_all()
node.Selector().regex().text("^Wi.?Fi$").exists()
node.Selector().text("Network").parent().child(0).find()   # relations
node.Selector().type("EditText").input("abc")              # act on the first match
node.Selector().text("加载中").wait_gone(timeout=10)
```

Filters: `text`, `text_contains`, `text_matches`, `id`, `desc`, `desc_contains`, `type`, `hint`, `package`, `class_path`, `path`, `depth`, `child_count`, `filter(fn)`. Boolean filters: `clickable`, `long_clickable`, `editable`, `enabled`, `visible`, `checkable`, `checked`, `focusable`, `focused`, `scrollable`, `selected`. Relations: `parent`, `child`, `brother`, `descendant`, `within(node)`.

`Selector(mode=0)` searches the simple tree (the same as `GET /ui-tree?mode=0`). `mode=1` searches the full tree.

`Node` fields: `path`, `id`, `text`, `desc`, `type`, `rect`, `clickable`, `editable`, `enabled`, `left`/`top`/`right`/`bottom`, `width`/`height`, and `center_x`/`center_y`.

## screen

```python
from xscript.android import screen

screen.capture()                     # PNG path on the device
img = screen.capture_cv()            # BGR numpy array (optionally a rect)
screen.capture_pil([0, 0, 540, 960])
w, h = screen.size()

screen.get_color(100, 200)           # '#rrggbb'
screen.compare_colors("100,200,#ff0000|120,200,#00ff00-101010", sim=0.9)
p = screen.find_colors("#ff0000|20,0,#00ff00", rect=[0, 0, 1080, 1200])   # Point(x, y) or None
screen.find_all_colors("#ff0000", max_num=10)

hit = screen.find_image("res/img/btn.png", confidence=0.85)
# {'result': (cx, cy), 'rect': [l, t, r, b], 'center_x': .., 'center_y': .., 'confidence': .., 'index': 0}
screen.find_all_images(["a.png", "b.png"], maxcnt=5, scale_range=[0.8, 1.2])

with_cache = screen.cache(True)      # freeze one frame for several searches
screen.cache(False)

for r in screen.ocr(rect=[0, 0, 1080, 400]):
    print(r.text, r.confidence, r.rect, r.center_x, r.center_y)   # also r["text"]
screen.ocr_find(r"^确定$")
screen.ocr_wait("登录", timeout=10)
screen.ocr_click("同意")
```

Color patterns: the first entry is absolute (`#rrggbb`) or `x,y,#rrggbb`. Later entries are `dx,dy,#rrggbb`, relative to the first. An optional `-rrggbb` sets a per-channel tolerance.

Template matching uses grayscale by default, or H+S with `rgb=True`. Transparent PNG pixels are masked out. `scale_range` searches log-spaced scales and keeps the best one. Large templates go through a coarse-to-fine pass. Templates may be paths (relative paths resolve against the project), numpy arrays, or lists of either.

OCR uses Google ML Kit (Chinese and Latin) on the device. The first call loads the model, which takes about 1 s.

## system

```python
from xscript.android import system

system.open("com.android.settings"); system.open("设置")
system.current_app()                 # {'package': .., 'activity': ..}
system.wait_for_package("com.tencent.mm", timeout=30)
system.stop_app("com.example")       # root
r = system.shell("dumpsys battery")  # ShellResult(code, out, err, ok)
system.device(); system.battery(); system.memory()
system.clipboard_set("x"); system.clipboard_get()
system.KeyValue.save("k", 1); system.KeyValue.get("k", 0)
system.R.img("btn.png")              # <project>/res/img/btn.png
system.toast("hi"); system.vibrate(200); system.speak("完成")
system.exit()
```

## ui

```python
from xscript.android import ui

ui.toast("hi")
if ui.confirm("继续?"):
    name = ui.prompt("名字", value="xs")
choice = ui.select(["A", "B", "C"])

win = ui.Window("<button onclick=\"xscript.call('go', '1')\">Go</button>", width="80vw", height="30vh")

@win.on("go")
def go(value):
    print("clicked", value)

win.show(wait=True)                  # blocks until closed; js calls xscript.close()

c = ui.Canvas(); c.show()
c.rect(100, 100, 400, 300, label="hit"); c.cross(540, 960); c.clear()
ui.show_image("/sdcard/a.png")
ui.float_show(); ui.float_hide()     # floating stop button
```

`ui.Window` HTML can call `window.xscript.call(key, value)`. AScript pages use the `window.airscript.call` alias, which also works.

The drawing canvas is a full-screen overlay that passes touches through. Android 12+ drops touches under a pass-through overlay from another app when the overlay's opacity is above 0.8. That rule also blocks injected taps from accessibility gestures and `input tap`. XScript therefore draws the canvas at 0.8 opacity. Custom overlays must follow the same limit. The symptom is `Untrusted touch due to occlusion by com.xscript.app` in logcat.

## AScript compatibility

`ascript.android.*` mirrors ascript-tip 1.3.0, the MIT-licensed API package. AScript projects run without edits: import them with **小程序列表 → 导入 → 从 AScript 导入** (`/sdcard/airscript/model`, needs root), from a zip (`PUT /projects/<name>/zip`), or with `upload_directory` over MCP.

Supported: `action` (click / swipe / slide / Touch / Key / Path / gesture / Ime / catch_click), `node.Selector` (AScript method names), `screen` (capture, bitmap helpers, Colors / FindColors / CompareColors / FindBlock / FindImages / Ocr / CodeScanner / Eraser and the GP task pipeline), `system` (Device, R, KeyValue, Clipboard, Config, shell, open, ...), `ui` (WebWindow, Dialog, Loger, FloatWindow, ImageWindow, Canvas), `media`, and `data`.

Behavior differences:

- **OCR:** `Ocr.mlkitocr_v2`, `paddleocr`, and `tess` all run ML Kit. Results are `OcrResult` objects that support attribute access (`.text`, `.rect`, `.center_x`, `.region_position`) and dict access (`r["text"]`, `r.get(...)`).
- **Template matching:** `FindImages.find` / `find_all` default to template matching with confidence 0.9. `method="smart"` and `find_sift` fall back to template matching. The results have AScript's dict shape (`result`, `rect`, `center_x`, `center_y`, `confidence`).
- **Screenshots:** `capture()` returns an android `Bitmap`, as in AScript. `capture_cv` returns BGR numpy.

Unsupported. These raise `NotImplementedError` or print a one-time warning:

- `action.Hid`
- `screen.YoLov5`
- `OcrX` / `Ocr.matrix`
- gp files from AScript's 图色工具
- `node.WebSelector`
- `Selector.on_event` and the `event` listeners
- `sms`, `plug`, `bluetooth`, `location`, `sensor`
- `system.Control` (AScript cloud control)
- `Notification.listen`
- `media.recode` / `send_email` / `AliTts`

## Developer tools (图色 / 标注 / 投屏)

Open `http://<ip>:<port>/tools/` in a desktop browser. The pages are served by the app. There is nothing to install.

**图色工具** works on a frozen snapshot, so every number refers to the same frame. Scroll to zoom and hold Space to pan.

- **Pick colors:** click the image to add points. The panel builds `x,y,#RRGGBB|...`, with an optional per-point offset such as `-#101010`. It can copy ready-made `FindColors.find(...)` or `CompareColors.compare(...)` code.
- **Select regions:** drag to select a region. Copy it as `rect`, or save it into a project as a PNG template (`res/img/...`).
- **Test:** the test buttons run multi-point find-color, compare-color (showing expected vs actual per point), find-image (using the selected region as the template), and OCR. They use the same engine as scripts, and matches are drawn over the image.

**标注工具** builds YOLO datasets on the phone. Files live in `<external files>/datasets/<name>/`.

- **Add images:** use 截图加入 for the current screen, or upload PNG / JPEG files.
- **Draw boxes:** drag to draw a box with the current class. Click a box to select it, drag it to move it, and press Delete to remove it. Keys 1–9 switch class; A and D move to the previous and next image. Changes save automatically.
- **Export:** 导出 YOLO downloads `images/{train,val}`, `labels/{train,val}` (`cls cx cy w h`, normalised) and `data.yaml`. Every fifth labelled image goes to val.

**投屏** shows a live MJPEG stream (`GET /screen/stream?fps=&scale=&quality=`, at most two viewers).

- **Control:** clicks and drags on the image become taps and swipes on the phone.
- **Frame rate:** it depends on the capture source. Root `screencap` gives about 2 fps; granting 图色权限 (MediaProjection) is much faster.

The MCP server exposes the same checks for AI coding: call `take_snapshot`, then `vision_test(snapshot_id, op, ...)`, `crop_template`, and `export_dataset`.

## Device HTTP and eval

The full contract is in `protocol/openapi.yaml`. `POST /eval` runs code in a dedicated `:eval` process with an 8 s default timeout and a 15 s maximum. One snippet runs at a time. On timeout the process is killed, so state left by earlier snippets is lost; a crash in the snippet does not affect the app. Assign the answer to `_result`:

```python
_result = __import__("xscript.android.screen", fromlist=["x"]).size()
```

Use eval for one-shot probes. Put loops in the project's `__init__.py`.

**Security:** the HTTP server and the cloud WebSocket relay have no authentication. Anyone who can reach the port can read projects and run arbitrary Python through `/eval` and `/projects/<name>/run`. Use trusted networks only, or `adb forward` over USB.
