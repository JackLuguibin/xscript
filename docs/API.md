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

`Selector(xpath=...)` takes an XPath 1.0 expression. Filters chained after it narrow the XPath result.

```python
node.Selector(xpath="//TextView[@text='开发者']").find()
node.Selector(xpath="//*[contains(@text,'网络') and @clickable='true']").find_all()
node.Selector(xpath="(//Button)[last()]").click()
node.Selector(xpath="//*[@text='WLAN']/following-sibling::Switch[1]").find()
node.Selector(xpath="//LinearLayout[.//Switch[@checked='true']]").find_all()
```

- Paths: `/`, `//`, `.`, `..`, `*`, and the axes `child`, `descendant(-or-self)`, `parent`, `ancestor(-or-self)`, `self`, `following-sibling`, `preceding-sibling`. Name tests match the short class name (`TextView`) or the full one.
- Predicates: `[2]`, `[last()]`, `[position()<3]`, `= != < <= > >=`, `and` / `or` / `not()`, nested paths as existence tests, `(expr)[n]` grouping, and `|` unions.
- Functions: `text()`, `contains`, `starts-with`, `ends-with`, `matches` (Python regex search), `string-length`, `normalize-space`, `concat`, `count`, `position`, `last`.
- Attributes: `text`, `resource-id` / `id`, `content-desc` / `desc`, `class` / `type`, `package`, `hint`, `bounds` (`[l,t][r,b]`), `index` (0-based among siblings), `depth`, `child-count`, and the flags (`clickable`, `checked`, `enabled`, ...) as `"true"` / `"false"`.

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

OCR engines:

- `mlkit` (default): Google ML Kit (Chinese and Latin), built in. The first call loads the model, about 1 s.
- `paddle`: PP-OCRv5 on ONNX Runtime. It reads small Chinese text better and works on emulators where ML Kit does not. The models (about 22 MB) download on first use, from ModelScope with a Hugging Face fallback, and are checked against pinned SHA-256 hashes. A full 1080×1920 screen takes about 1 s on MuMu after the first call. `paddle_v4` uses PP-OCRv4.

```python
screen.set_ocr_engine("paddle")              # default for all ocr* calls
screen.ocr(engine="paddle", confidence=0.6)  # or per call
```

Offline devices: put the files in `models.directory()/paddle/v5/` (for example with `adb push`, or `PUT /models/paddle/v5/<file>`).

## yolo (object detection)

```python
from xscript.android import yolo, models, system

model = yolo.load(system.R.res("best.onnx"))            # or models.path("best.onnx")
for d in model.detect(conf=0.5):                         # current screen; image=, rect=, classes=
    print(d.label, d.confidence, d.rect, d.center_x, d.center_y)
hit = model.find("按钮")                                  # best detection of one class
if hit:
    hit.click()
screen.detect("res/best.onnx", conf=0.5)                 # one-shot form
```

- **Models:** Ultralytics YOLOv5 / v8 / v11 detection exports in ONNX format, plus end-to-end exports ([N, 6] output: v10, `nms=True`). Class names and input size come from the model metadata that Ultralytics writes. Otherwise pass `names=` (a list, `{id: name}`, or a `data.yaml` path) and `imgsz=`.
- **From labels to a model:** export a dataset from the 标注工具, then `yolo detect train data=data.yaml model=yolo11n.pt imgsz=640`, then `yolo export model=runs/detect/train/weights/best.pt format=onnx imgsz=640`. Put `best.onnx` in the project's `res/`, or upload it with the MCP `upload_model` tool.
- **Speed:** YOLO11n at 640 takes about 135 ms per frame on MuMu (arm64, 6 cores) after the first call. `accel="nnapi"` tries Android NNAPI and falls back to CPU.
- **Custom models:** `xscript.android.onnx.load(path)` gives a raw session (`run(tensor)`, `run_argmax`, `inputs`, `outputs`, `metadata`) for any float32 ONNX model.

## pip (runtime packages)

```python
from xscript.android import pip
pip.install("schedule", "pymysql==1.1.1")
pip.list(); pip.uninstall("schedule")
```

A `requirements.txt` in the project is installed automatically before `__init__.py` runs. Only packages that are missing get installed, so only the first run needs the network.

- **Pure-Python packages:** come from PyPI wheels (`py3-none-any`), with the Tsinghua mirror as a fallback, or from `index_url=`.
- **Packages with C extensions:** come only from Chaquopy's Android index (about 140 packages, including pandas, scipy, lxml, cryptography, cffi and pycryptodome). Their shared libraries are loaded automatically.
- **Source-only packages:** cannot be built on the phone.
- **Bundled packages:** the ones in the APK (numpy, opencv, pillow, requests, pyyaml, packaging) are never replaced.
- **Location:** packages live in the app's private storage and survive app updates. HTTP: `GET /packages`, `POST /packages`. MCP: `pip_install`, `pip_list`, `pip_uninstall`.

## cloud (云控)

```python
from xscript.android import cloud, system
cloud.send({"gold": 180})                 # dashboard data for this device

@cloud.on_message
def on_msg(data):
    print(data)

system.params()                           # 云控 app_run "param"
```

See [CLOUD.md](CLOUD.md) for the command set, the wire protocol and the reference server.

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
system.reboot(delay=5)               # end this run, start the project again in 5 s
```

### Run options and schedules

Each project has two run options, also shown as switches on its screen in the app (小程序列表 → project):

- **开机自启** (`Config.set_auto_run`): starts the project after the device boots, once accessibility or root is ready (up to 60 s). Only one project per device can be the boot project, so enabling it on one project clears it on the previous one.
- **停止后重新运行** (`Config.set_stop_re_run`): starts the project again 3 s after it exits or crashes. A stop from the app, the float button, HTTP, or MCP never triggers it. After 5 exits within 10 s each, it pauses until the next manual start.

```python
from xscript.android import system

system.Config.set_auto_run(True)            # the running project; or project="name"
system.Config.set_stop_re_run(True)
system.Config.get()                         # {'project', 'auto_run', 'stop_re_run', 'boot_project'}

system.Schedule.daily("08:30", weekdays=[1, 2, 3, 4, 5])   # 1 = Monday
system.Schedule.every(30, window="08:00-23:00")            # window may cross midnight
system.Schedule.once("2026-10-01 09:00")                   # or a datetime / epoch seconds
system.Schedule.list()                                     # project="*" for all projects
system.Schedule.update(sid, enabled=False)
system.Schedule.remove(sid)
```

Schedules use device-local time.

- **Firing:** schedules fire through AlarmManager. Exact alarms on Android 12+ need the 闹钟和提醒 grant. Without it they fall back to inexact alarms, which Doze can delay by several minutes, and the project screen shows a warning row.
- **Interval grid:** interval schedules keep a fixed grid from the moment they were created, so a late alarm does not shift later runs.
- **Missed runs:** a run missed by more than 10 minutes (device off, app force-stopped) is skipped and logged.
- **One script at a time:** with `if_running="skip"` (the default), a schedule that finds another script running logs a skip. `if_running="restart"` stops the running script and starts this project.
- **Screen:** `wake=True` turns the screen on first.
- **Reboot and cleanup:** alarms are re-armed after reboot, clock changes, and app updates. Deleting a project deletes its schedules and clears its run options.

## event

```python
from xscript.android import event

@event.on_key(event.KEYCODE_VOLUME_UP)
def vol(e):
    if e.action == "down":
        print("volume up")

@event.on_notification(package="com.tencent.mm")
def wx(e):
    print(e.title, e.text, e.time)
    e.send()                             # open the notification

@event.on_touch("click")
def tap(e):
    print(e.x, e.y, e.package, e.text)

t = event.wait("toast", timeout=10)      # Event or None
event.on("a11y", lambda e: print(e.event_name, e.package))
event.off()                              # remove all handlers
event.loop()                             # or keep the script alive yourself
```

| Type | Source | Fields |
| --- | --- | --- |
| `key` | accessibility key filter | `key_code`, `action` (`down` / `up`), `repeat`, `long_press` |
| `touch` | view click / long click / scroll | `action`, `x`, `y` (view center), `rect`, `package`, `class`, `text` |
| `notification` | 通知使用权, else accessibility | `package`, `title`, `text`, `sub_text`, `big_text`, `time`, `key`, `id`, `tag`, `source`, `send()` |
| `toast` | accessibility | `package`, `text` |
| `a11y` | every accessibility event except content changes (set `mask` to change) | `event_type`, `event_name`, `package`, `class`, `text`, `desc` |

- **Filters:** keyword filters on `on()` / `wait()` match fields exactly, by membership in a list, or with a callable.
- **Threading:** handlers run one at a time on a daemon thread, so a script that only registers handlers must keep itself alive (`event.loop()` or a loop).
- **Keys:** key events are observed, never consumed. Key filtering is on only while a script listens.
- **Notifications:** full notification data needs **通知使用权** (home screen → 通知使用权). Without it, notifications come from accessibility with only the package and text.
- **Scope:** events belong to the current run and stop when it ends.

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

Supported: `action` (click / swipe / slide / Touch / Key / Path / gesture / Ime / catch_click), `node.Selector` (AScript method names, `xpath=`, `on_event`), `screen` (capture, bitmap helpers, Colors / FindColors / CompareColors / FindBlock / FindImages / Ocr / CodeScanner / Eraser and the GP task pipeline), `system` (Device, R, KeyValue, Clipboard, Config, Notification.listen, reboot, shell, open, ...), `event` (KeyEvent / TouchEvent / NotificationEvent), `ui` (WebWindow, Dialog, Loger, FloatWindow, ImageWindow, Canvas), `media`, and `data`.

Behavior differences:

- **OCR:** `Ocr.mlkitocr_v2` runs ML Kit. `paddleocr` / `paddleocr_v2` / `paddleocr_v3`, and `find` / `find_all` after `Ocr.set_engine(Ocr.MODE_PADDLE_V5)`, run PP-OCRv5. `tess` maps to ML Kit. Results are `OcrResult` objects that support attribute access (`.text`, `.rect`, `.center_x`, `.region_position`) and dict access (`r["text"]`, `r.get(...)`).
- **YOLO:** `screen.YoLov5(path=...)` and `plug.load("yolov5" | "Yolov8Ncnn" | "Yolov11Ncnn")` run the ONNX detector with AScript's result shapes. AScript ships NCNN models (`.param` / `.bin`); export the same weights to ONNX (`format=onnx`) and point `load()` at the `.onnx` file. Class names come from the model, a `data.yaml` or `classes.txt` next to it, or `nc`.
- **云控:** `cloud_control.connect_to_ws / send / close`, `system.channel` and `system.Control.send` use XScript's 云控 connection. Launch parameters are also set on `builtins` as in AScript. `R.get_card()` returns a packaged app's 卡密.
- **Template matching:** `FindImages.find` / `find_all` default to template matching with confidence 0.9. `method="smart"` and `find_sift` fall back to template matching. The results have AScript's dict shape (`result`, `rect`, `center_x`, `center_y`, `confidence`).
- **Screenshots:** `capture()` returns an android `Bitmap`, as in AScript. `capture_cv` returns BGR numpy.
- **Events:** `NotificationEvent` events carry plain data, so `event.raw` is `None`. `Selector.on_event` gets an object with `getEventType()`, `getPackageName()`, `getClassName()`, and `getText()`.
- **`system.reboot(ms)`:** restarts the project in a fresh script process. It does not reboot the device.

Unsupported. These raise `NotImplementedError` or print a one-time warning:

- `action.Hid`
- NCNN model files (use the ONNX export of the same model)
- `OcrX` / `Ocr.matrix`
- gp files from AScript's 图色工具
- `node.WebSelector`
- `sms`, `bluetooth`, `location`, `sensor`
- `plug.load` for plugins other than the built-in YOLO ones, `plug.load_apk` / `inject`
- `cloud_control.connect_to_as` (AScript's official cloud server)
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
