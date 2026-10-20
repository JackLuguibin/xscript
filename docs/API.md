# XScript Python API

脚本运行在 XScript 应用内（Chaquopy，Python 3.10，内置 numpy、opencv、pillow、requests、pyyaml）。提供两套 API：

- `xscript.android.*`：原生 API，见下文。
- `ascript.android.*`：AScript 脚本的直接替换层。见 [AScript 兼容](#ascript-兼容)。

坐标为当前屏幕方向下的像素。矩形为 `[left, top, right, bottom]`。PC 端自动补全位于 `ide/python-stubs/`。MCP 工具 `get_module_apis` / `search_api` 提供同一份 API 目录（`ide/mcp-server/xscript_mcp/api_catalog.json`）。

## 运行模式

首页的 **运行模式**（`PUT /settings {"run_mode": ...}`）决定手势和节点操作使用的通道：

| 模式 | 手势 | 节点树 | 截图 |
| --- | --- | --- | --- |
| `auto`（默认） | 无障碍，回退到 root | 无障碍，回退到 root | 无障碍，回退到 root `screencap` |
| `accessibility` | 仅无障碍 | 无障碍 | 无障碍 |
| `root` | 通过 `su` 执行 `input` / `sendevent` | `uiautomator dump` | `screencap` |

无障碍截图为黑屏时，截图引擎会自动切换到 root。MuMu 就是这种情况。MuMu 也没有自带 `uiautomator`，所以在 MuMu 上 root 模式没有节点树。

## action

```python
from xscript.android import action

action.click(540, 1200)              # 也接受 Point / (x, y) / Node
action.long_click(540, 1200, dur=800)
action.swipe(100, 1500, 100, 500, dur=300)
action.path([(100, 100), (300, 300), (500, 100)], dur=500)
action.gesture([                      # 多指手势，各笔画并行执行
    {"points": [(300, 800), (300, 400)], "duration": 400},
    {"points": [(700, 800), (700, 400)], "duration": 400},
])
action.input("hello")                # 向获得焦点的输入框（或第一个可编辑输入框）设置文本
action.Touch.down(500, 500); action.Touch.move(500, 900); action.Touch.up(500, 900)
action.Key.back(); action.Key.home(); action.Key.recents(); action.Key.notifications()
action.Key.code(66)                  # 原始 keyevent（root）
```

## node

```python
from xscript.android import node

n = node.Selector().text("搜索").find(timeout=5)       # Node 或 None
if n:
    n.click()
    n.set_text("wifi")

node.Selector().id("com.android.settings:id/search").clickable().find()
node.Selector().text_contains("网络").find_all()
node.Selector().regex().text("^Wi.?Fi$").exists()
node.Selector().text("Network").parent().child(0).find()   # 节点关系
node.Selector().type("EditText").input("abc")              # 作用于第一个匹配项
node.Selector().text("加载中").wait_gone(timeout=10)
```

过滤条件：`text`、`text_contains`、`text_matches`、`id`、`desc`、`desc_contains`、`type`、`hint`、`package`、`class_path`、`path`、`depth`、`child_count`、`filter(fn)`。布尔过滤条件：`clickable`、`long_clickable`、`editable`、`enabled`、`visible`、`checkable`、`checked`、`focusable`、`focused`、`scrollable`、`selected`。节点关系：`parent`、`child`、`brother`、`descendant`、`within(node)`。

带 `timeout` 的 `find`/`find_all`/`exists`/`wait_gone` 默认每 0.25 秒重查一次，可用 `interval=` 调整（如 `wait_gone(timeout=10, interval=1)`）；到点前最后一次等待会截短，不会超过 `timeout`。

`Selector(mode=0)` 在精简树中搜索（与 `GET /ui-tree?mode=0` 相同）。`mode=1` 在完整树中搜索。

`Selector(xpath=...)` 接受 XPath 1.0 表达式。之后链式调用的过滤条件会进一步缩小 XPath 的结果。

```python
node.Selector(xpath="//TextView[@text='开发者']").find()
node.Selector(xpath="//*[contains(@text,'网络') and @clickable='true']").find_all()
node.Selector(xpath="(//Button)[last()]").click()
node.Selector(xpath="//*[@text='WLAN']/following-sibling::Switch[1]").find()
node.Selector(xpath="//LinearLayout[.//Switch[@checked='true']]").find_all()
```

- 路径：`/`、`//`、`.`、`..`、`*`，以及轴 `child`、`descendant(-or-self)`、`parent`、`ancestor(-or-self)`、`self`、`following-sibling`、`preceding-sibling`。名称测试可匹配短类名（`TextView`）或完整类名。
- 谓词：`[2]`、`[last()]`、`[position()<3]`、`= != < <= > >=`、`and` / `or` / `not()`、作为存在性测试的嵌套路径、`(expr)[n]` 分组，以及 `|` 并集。
- 函数：`text()`、`contains`、`starts-with`、`ends-with`、`matches`（Python 正则 search）、`string-length`、`normalize-space`、`concat`、`count`、`position`、`last`。
- 属性：`text`、`resource-id` / `id`、`content-desc` / `desc`、`class` / `type`、`package`、`hint`、`bounds`（`[l,t][r,b]`）、`index`（在兄弟节点中的序号，从 0 开始）、`depth`、`child-count`，以及各标志位（`clickable`、`checked`、`enabled` 等），取值为 `"true"` / `"false"`。

`Node` 字段：`path`、`id`、`text`、`desc`、`type`、`rect`、`clickable`、`editable`、`enabled`、`left`/`top`/`right`/`bottom`、`width`/`height`，以及 `center_x`/`center_y`。

## screen

```python
from xscript.android import screen

screen.capture()                     # 设备上的 PNG 路径
img = screen.capture_cv()            # BGR numpy 数组（可传入 rect）
screen.capture_pil([0, 0, 540, 960])
w, h = screen.size()

screen.get_color(100, 200)           # '#rrggbb'
screen.compare_colors("100,200,#ff0000|120,200,#00ff00-101010", sim=0.9)
p = screen.find_colors("#ff0000|20,0,#00ff00", rect=[0, 0, 1080, 1200])   # Point(x, y) 或 None
screen.find_all_colors("#ff0000", max_num=10)

hit = screen.find_image("res/img/btn.png", confidence=0.85)
# {'result': (cx, cy), 'rect': [l, t, r, b], 'center_x': .., 'center_y': .., 'confidence': .., 'index': 0}
screen.find_all_images(["a.png", "b.png"], maxcnt=5, scale_range=[0.8, 1.2])

with_cache = screen.cache(True)      # 冻结一帧，供多次查找使用
screen.cache(False)

for r in screen.ocr(rect=[0, 0, 1080, 400]):
    print(r.text, r.confidence, r.rect, r.center_x, r.center_y)   # 也可用 r["text"]
screen.ocr_find(r"^确定$")
screen.ocr_wait("登录", timeout=10)                # 默认每 0.3 秒识别一次，interval= 可调
screen.ocr_click("同意")
```

颜色模式：第一项为绝对颜色（`#rrggbb`）或 `x,y,#rrggbb`。后续各项为 `dx,dy,#rrggbb`，相对于第一项。可选的 `-rrggbb` 设置每个通道的容差。

模板匹配默认使用灰度，`rgb=True` 时使用 H+S。透明 PNG 像素会被屏蔽。`scale_range` 在按对数间隔取值的缩放比例上搜索，并保留最佳结果。大模板会经过由粗到精的匹配流程。模板可以是路径（相对路径基于项目解析）、numpy 数组，或二者组成的列表。

OCR 引擎：

- `mlkit`（默认）：Google ML Kit（中文和拉丁文），内置。首次调用会加载模型，约 1 秒。
- `paddle`：基于 ONNX Runtime 的 PP-OCRv5。识别小号中文更准，并且能在 ML Kit 无法工作的模拟器上运行。模型（约 22 MB）在首次使用时下载，来源为 ModelScope，Hugging Face 作为备用，并会校验固定的 SHA-256 哈希值。首次调用之后，在 MuMu 上识别整个 1080×1920 屏幕约需 1 秒。`paddle_v4` 使用 PP-OCRv4。

```python
screen.set_ocr_engine("paddle")              # 所有 ocr* 调用的默认引擎
screen.ocr(engine="paddle", confidence=0.6)  # 或按次指定
```

离线设备：把文件放到 `models.directory()/paddle/v5/`（例如用 `adb push`，或 `PUT /models/paddle/v5/<file>`）。

## yolo（目标检测）

```python
from xscript.android import yolo, models, system

model = yolo.load(system.R.res("best.onnx"))            # 或 models.path("best.onnx")
for d in model.detect(conf=0.5):                         # 当前屏幕；可传 image=、rect=、classes=
    print(d.label, d.confidence, d.rect, d.center_x, d.center_y)
hit = model.find("按钮")                                  # 某一类别中最佳的检测结果
if hit:
    hit.click()
screen.detect("res/best.onnx", conf=0.5)                 # 一次性调用形式
```

- **模型：** Ultralytics YOLOv5 / v8 / v11 检测模型的 ONNX 格式导出，以及端到端导出（[N, 6] 输出：v10、`nms=True`）。类别名称和输入尺寸取自 Ultralytics 写入的模型元数据。否则需传入 `names=`（列表、`{id: name}` 或 `data.yaml` 路径）和 `imgsz=`。
- **从标注到模型：** 在标注工具中导出数据集，然后执行 `yolo detect train data=data.yaml model=yolo11n.pt imgsz=640`，再执行 `yolo export model=runs/detect/train/weights/best.pt format=onnx imgsz=640`。把 `best.onnx` 放到项目的 `res/` 中，或用 MCP 的 `upload_model` 工具上传。
- **速度：** 首次调用之后，YOLO11n 在 640 输入尺寸下于 MuMu（arm64，6 核）上每帧约 135 ms。`accel="nnapi"` 会尝试使用 Android NNAPI，失败时回退到 CPU。
- **自定义模型：** `xscript.android.onnx.load(path)` 返回原始会话（`run(tensor)`、`run_argmax`、`inputs`、`outputs`、`metadata`），适用于任意 float32 ONNX 模型。

## pip（运行时安装包）

```python
from xscript.android import pip
pip.install("schedule", "pymysql==1.1.1")
pip.list(); pip.uninstall("schedule")
```

项目中的 `requirements.txt` 会在 `__init__.py` 运行前自动安装。只安装缺失的包，所以只有首次运行需要联网。

- **纯 Python 包：** 来自 PyPI 的 wheel（`py3-none-any`），清华镜像作为备用，也可通过 `index_url=` 指定。
- **含 C 扩展的包：** 只能来自 Chaquopy 的 Android 索引（约 140 个包，包括 pandas、scipy、lxml、cryptography、cffi 和 pycryptodome）。其共享库会自动加载。
- **仅提供源码的包：** 无法在手机上构建。
- **内置包：** APK 自带的包（numpy、opencv、pillow、requests、pyyaml、packaging）永远不会被替换。
- **存放位置：** 包存放在应用私有存储中，应用更新后仍会保留。HTTP：`GET /packages`、`POST /packages`。MCP：`pip_install`、`pip_list`、`pip_uninstall`。

## cloud（云控）

```python
from xscript.android import cloud, system
cloud.send({"gold": 180})                 # 本设备的看板数据

@cloud.on_message
def on_msg(data):
    print(data)

system.params()                           # 云控 app_run "param"
```

命令集、通信协议和参考服务端见 [CLOUD.md](CLOUD.md)。

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
system.reboot(delay=5)               # 结束本次运行，5 秒后重新启动项目
```

### 运行选项与定时任务

每个项目有两个运行选项，也以开关形式显示在应用内的项目页面上（小程序列表 → 项目）：

- **开机自启**（`Config.set_auto_run`）：设备开机后，待无障碍或 root 就绪（最多 60 秒）即启动该项目。每台设备只能有一个开机项目，所以在一个项目上开启会清除上一个项目的该设置。
- **停止后重新运行**（`Config.set_stop_re_run`）：项目退出或崩溃 3 秒后重新启动。从应用、悬浮按钮、HTTP 或 MCP 发起的停止不会触发它。连续 5 次均在 10 秒内退出后，会暂停重新运行，直到下次手动启动。

```python
from xscript.android import system

system.Config.set_auto_run(True)            # 当前运行的项目；或 project="name"
system.Config.set_stop_re_run(True)
system.Config.get()                         # {'project', 'auto_run', 'stop_re_run', 'boot_project'}

system.Schedule.daily("08:30", weekdays=[1, 2, 3, 4, 5])   # 1 = 周一
system.Schedule.every(30, window="08:00-23:00")            # window 可跨越午夜
system.Schedule.once("2026-10-01 09:00")                   # 或 datetime / 时间戳秒数
system.Schedule.list()                                     # project="*" 表示所有项目
system.Schedule.update(sid, enabled=False)
system.Schedule.remove(sid)
```

定时任务使用设备本地时间。

- **触发：** 定时任务通过 AlarmManager 触发。Android 12+ 上的精确闹钟需要授予 闹钟和提醒 权限。未授权时回退到非精确闹钟，Doze 可能将其延迟数分钟，项目页面会显示一行警告。
- **间隔网格：** 间隔型定时任务从创建时刻起保持固定的时间网格，因此某次闹钟延迟不会让后续运行往后推。
- **错过的运行：** 错过超过 10 分钟的运行（设备关机、应用被强行停止）会被跳过并记录日志。
- **同一时间只运行一个脚本：** 使用 `if_running="skip"`（默认）时，定时任务发现有其他脚本正在运行，会记录一次跳过。`if_running="restart"` 会停止正在运行的脚本并启动本项目。
- **屏幕：** `wake=True` 会先点亮屏幕。
- **重启与清理：** 设备重启、时间变更和应用更新后，闹钟会重新设置。删除项目会删除其定时任务并清除其运行选项。

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
    e.send()                             # 打开该通知

@event.on_touch("click")
def tap(e):
    print(e.x, e.y, e.package, e.text)

t = event.wait("toast", timeout=10)      # Event 或 None
event.on("a11y", lambda e: print(e.event_name, e.package))
event.off()                              # 移除所有处理函数
event.loop()                             # 或自行保持脚本存活
```

| 类型 | 来源 | 字段 |
| --- | --- | --- |
| `key` | 无障碍按键过滤 | `key_code`、`action`（`down` / `up`）、`repeat`、`long_press` |
| `touch` | 视图点击 / 长按 / 滚动 | `action`、`x`、`y`（视图中心）、`rect`、`package`、`class`、`text` |
| `notification` | 通知使用权，否则为无障碍 | `package`、`title`、`text`、`sub_text`、`big_text`、`time`、`key`、`id`、`tag`、`source`、`send()` |
| `toast` | 无障碍 | `package`、`text` |
| `a11y` | 除内容变化外的所有无障碍事件（设置 `mask` 可更改） | `event_type`、`event_name`、`package`、`class`、`text`、`desc` |

- **过滤：** `on()` / `wait()` 上的关键字过滤条件可按字段精确匹配、按是否在列表中匹配，或用可调用对象匹配。
- **线程：** 处理函数在一个守护线程上逐个执行，因此只注册处理函数的脚本必须自行保持存活（`event.loop()` 或循环）。
- **按键：** 按键事件只被观察，不会被消费。只有在脚本监听时才开启按键过滤。
- **通知：** 完整的通知数据需要 **通知使用权**（首页 → 通知使用权）。未授权时，通知来自无障碍，只包含包名和文本。
- **作用范围：** 事件属于本次运行，运行结束时停止。

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

win.show(wait=True)                  # 阻塞直到关闭；js 中调用 xscript.close()

c = ui.Canvas(); c.show()
c.rect(100, 100, 400, 300, label="hit"); c.cross(540, 960); c.clear()
ui.show_image("/sdcard/a.png")
ui.float_show(); ui.float_hide()     # 悬浮窗：本次运行里强制显示 / 隐藏（设置“关闭”或应用在前台时也显示）
ui.float_show(x=-1, y=-1, dim=0.8)   # 位置与透明度同 AScript FloatWindow.show：-1 右 / 下边缘，0 左 / 上边缘，0–1 屏幕比例，正数像素；始终贴边
ui.float_add_menu("rec", "/sdcard/rec.png", on_click, remove_system=False)  # 悬浮窗面板里加一个圆形按钮（同 AScript FloatWindow.add_menu），点击在脚本里另开线程调 on_click()（带一个参数时传 menu_id）；同 id 再加就替换，脚本结束清除
```

`ui.Window` 的 HTML 可以调用 `window.xscript.call(key, value)`。AScript 页面使用别名 `window.airscript.call`，同样可用。

绘图画布是全屏覆盖层，触摸会穿透它。在 Android 12+ 上，若其他应用的可穿透覆盖层不透明度高于 0.8，其下方的触摸会被丢弃。该规则同样会拦截无障碍手势和 `input tap` 注入的点击。因此 XScript 以 0.8 的不透明度绘制画布。自定义覆盖层也必须遵守同样的限制。出现该问题时，logcat 中会有 `Untrusted touch due to occlusion by com.xscript.app`。

## AScript 兼容

`ascript.android.*` 对应 ascript-tip 1.3.0，即 MIT 许可的 API 包。AScript 项目无需修改即可运行：通过 **小程序列表 → 导入 → 从 AScript 导入** 导入（`/sdcard/airscript/model`，需要 root），或从 zip 导入（`PUT /projects/<name>/zip`），或通过 MCP 的 `upload_directory` 导入。

已支持：`action`（click / swipe / slide / Touch / Key / Path / gesture / Ime / catch_click）、`node.Selector`（AScript 方法名、`xpath=`、`on_event`）、`node.WebSelector` / `WebNode`（WebWindow 网页控件）、`screen`（capture、bitmap 辅助函数、Colors / FindColors / CompareColors / FindBlock / FindImages / Ocr / CodeScanner / Eraser 以及 GP 任务流水线）、`system`（Device、R、KeyValue、Clipboard、Config、Notification.listen、reboot、shell、open 等）、`event`（KeyEvent / TouchEvent / NotificationEvent）、`ui`（WebWindow、Dialog、Loger、FloatWindow、ImageWindow、Canvas）、`media` 和 `data`。

行为差异：

- **OCR：** `Ocr.mlkitocr_v2` 使用 ML Kit。`paddleocr` / `paddleocr_v2` / `paddleocr_v3`，以及在 `Ocr.set_engine(Ocr.MODE_PADDLE_V5)` 之后调用的 `find` / `find_all`，使用 PP-OCRv5。`tess` 映射到 ML Kit。结果为 `OcrResult` 对象，支持属性访问（`.text`、`.rect`、`.center_x`、`.region_position`）和字典访问（`r["text"]`、`r.get(...)`）。
- **点阵字库：** `Ocr.matrix(font_lib, rect=None, region=0.9, image=None)` 返回识别出的文字（无则 `None`），`Ocr.matrix_detail(...)` 返回 `{"text", "chars": [{text, rect, center_x, center_y, confidence}], "lines"}`；`OcrX(font_lib, rect, region)` 是同样功能的 GP 任务，`OcrX.find_all(...)` 返回逐字列表。识别时先按字库的「墨色」规则二值化（颜色 `"RRGGBB-DDDDDD"`，或灰度阈值），再逐字模板匹配（底层是 `CvFontLib`），`region` 是相似度。字库是 XScript 的 JSON 文件（习惯放 `res/font.t`），用 `MatrixFont` 制作：

  ```python
  from ascript.android.screen import MatrixFont, Ocr, capture
  from ascript.android.system import R

  font = MatrixFont(colors=["FAC828-282828"])      # 字的颜色 ± 偏差；或 MatrixFont(threshold=128, invert=False)
  img = capture()
  font.add("1", img, rect=[100, 500, 112, 520])    # 框住单个字，自动裁到字的笔画
  font.add("2", img, rect=[116, 500, 128, 520])
  font.save(R.res("font.t"))
  print(Ocr.matrix(R.res("font.t"), rect=[90, 490, 340, 530]))
  ```

  AScript 图色助手生成的 `font.t` 是未公开的二进制格式，读不了，会报错并提示用 `MatrixFont` 重做。
- **网页控件（`WebSelector` / `WebNode`）：** 在已 `show()` 的 `WebWindow` 里按 `tag` / `text` / `value` / `attr` 查找 DOM 元素，`child` / `brother` / `parent` 按 AScript 的序号规则取关系元素（`1` 第一个、`-1` 倒数第一个、`1.3` 第 1 到 3 个、`brother(0.1)` / `(-0.1)` 下一个 / 上一个），`click()` / `long_click()` / `input(val)` 作用在找到的元素上。字符串精确匹配，`"/正则/"` 按 JS 正则匹配；`text` 只保留最内层的匹配元素（父元素的文本包含子元素，不重复返回）。`input` 用原生 setter 赋值并触发 `input` / `change`，React / Vue 表单也能收到。`WebNode` 有 `tag_name`、`text`、`value`、`attributes`、`bounds`（相对网页窗口的设备像素）。查询在页面里通过 JS 桥执行，只作用于脚本自己的 WebWindow，不能操作其他 App 里的网页（那些请用无障碍 `Selector`）。

  ```python
  from ascript.android.node import WebSelector
  from ascript.android.ui import WebWindow
  from ascript.android.system import R

  w = WebWindow(R.ui("login.html")); w.show()
  WebSelector(w).attr("id", "user").input("tom").find()
  WebSelector(w).tag("button").text("/登录/").click().find()
  items = WebSelector(w).attr("id", "list").child().find_all()
  ```
- **YOLO：** `screen.YoLov5(path=...)` 和 `plug.load("yolov5" | "Yolov8Ncnn" | "Yolov11Ncnn")` 运行 ONNX 检测器，并返回 AScript 的结果结构。AScript 自带的是 NCNN 模型（`.param` / `.bin`）；请把同一份权重导出为 ONNX（`format=onnx`），再让 `load()` 指向 `.onnx` 文件。类别名称取自模型、同目录下的 `data.yaml` 或 `classes.txt`，或 `nc`。
- **云控：** `cloud_control.connect_to_ws / send / close`、`system.channel` 和 `system.Control.send` 使用 XScript 的云控连接。启动参数也会像 AScript 一样设置到 `builtins` 上。`R.get_card()` 返回打包应用的卡密。
- **模板匹配：** `FindImages.find` / `find_all` 默认使用置信度为 0.9 的模板匹配。`method="smart"` 和 `find_sift` 会回退为模板匹配。结果采用 AScript 的字典结构（`result`、`rect`、`center_x`、`center_y`、`confidence`）。
- **截图：** `capture()` 与 AScript 一样返回 android `Bitmap`。`capture_cv` 返回 BGR numpy 数组。
- **事件：** `NotificationEvent` 事件携带的是纯数据，因此 `event.raw` 为 `None`。`Selector.on_event` 收到的对象提供 `getEventType()`、`getPackageName()`、`getClassName()` 和 `getText()`。
- **`system.reboot(ms)`：** 在新的脚本进程中重启项目，不会重启设备。
- **`sms`、`sensor`、`location`：** 短信（只读）、传感器、定位订阅与最近位置；`location.mock.start(lon, lat, accuracy=5.0, interval=1000, coord_type="bd09")` / `stop()` / `status()` 做系统模拟定位（需在开发者选项里把应用设为「模拟位置信息应用」，有 Root 时自动授予；bd09/gcj02 自动转 WGS84，另有 `location.to_wgs84()` 等转换函数）。
- **`media.recode(path, time=None)`：** 麦克风录音到文件（.m4a/.aac/.mp4、.amr/.3gp、.ogg/.opus）；`time` 毫秒，省略则后台录制、`media.stop_recode()` 结束；需要录音权限，只能在前台录。**`media.send_email(to, subject, body, cc=None)`：** 打开邮件 App 并预填草稿。
- **`bluetooth`：** `scan(timeout, ble=False)`、`bonded()`、经典蓝牙 `connect(address)`（默认 SPP）读写、BLE `ble_connect(address)` 的 `read/write/notify`；首次使用时申请蓝牙权限。
- **`plug.load_apk(path)` / `load_apk_dir(dir)`：** 用 DexClassLoader 加载应用自己存储里的 .apk/.jar/.dex，`load_class(name).new(...)`、`call`、`call_static`、`get/set` 反射调用。
  插件用到的库（Kotlin 标准库、AndroidX 等）请打包在插件自己的 dex 里。正式版 APK 经过 R8 精简，宿主里的这些库只保留了 XScript 自己用到的类和方法，插件不能依赖它们。

不支持以下功能，调用时会抛出 `NotImplementedError` 或打印一次性警告：

- `action.Hid`
- NCNN 模型文件（请使用同一模型的 ONNX 导出）
- AScript 图色助手生成的二进制点阵字库（`font.t`）：`Ocr.matrix` / `OcrX` 已支持，但字库要用 `MatrixFont` 重新制作（见上文 AScript 兼容的「点阵字库」）
- AScript 图色工具生成的 gp 文件
- 内置 YOLO 插件以外的 `plug.load` 插件，`plug.inject` / `load_module_dynamically`
- `cloud_control.connect_to_as`（AScript 官方云服务）
- `media.AliTts`（请用 `media.talk()`）

## 开发者工具（脚本 IDE / 图色 / 标注 / 投屏）

在电脑浏览器中打开 `http://<ip>:<port>/tools/`。页面由应用直接提供，无需安装任何东西。脚本 IDE 的用法见[使用手册](使用手册.md#脚本-ide)，它用到的工程与文件接口见下文“工程与文件”。

**图色工具** 基于冻结的快照工作，所以所有数值都对应同一帧。滚动滚轮缩放，按住空格键平移。

- **取色：** 点击图片添加取色点。面板会生成 `x,y,#RRGGBB|...`，每个点可带可选的偏色值，例如 `-#101010`。可复制现成的 `FindColors.find(...)` 或 `CompareColors.compare(...)` 代码。
- **框选区域：** 拖动以框选区域。可复制为 `rect`，或以 PNG 模板保存到项目中（`res/img/...`）。
- **测试：** 测试按钮可运行多点找色、比色（逐点显示期望值与实际值）、找图（以选中区域为模板）和 OCR。它们使用与脚本相同的引擎，匹配结果会绘制在图片上。

**标注工具** 在手机上构建 YOLO 数据集。文件位于 `<external files>/datasets/<name>/`。

- **添加图片：** 用 截图加入 添加当前屏幕，或上传 PNG / JPEG 文件。
- **画框：** 拖动即可用当前类别画框。点击框可选中，拖动可移动，按 Delete 删除。按键 1–9 切换类别；A 和 D 切换到上一张和下一张图片。修改会自动保存。
- **导出：** 导出 YOLO 会下载 `images/{train,val}`、`labels/{train,val}`（`cls cx cy w h`，已归一化）和 `data.yaml`。已标注图片中每第 5 张划入 val。

**投屏** 显示实时 MJPEG 视频流（`GET /screen/stream?fps=&scale=&quality=`，最多两个观看者）。

- **控制：** 在画面上的点击和拖动会转换为手机上的点击和滑动。
- **帧率：** 取决于截图来源。root `screencap` 约 2 fps；授予图色权限（MediaProjection）后会快得多。

MCP 服务端为 AI 编程提供同样的检查能力：先调用 `take_snapshot`，再调用 `vision_test(snapshot_id, op, ...)`、`crop_template` 和 `export_dataset`。

## 设备 HTTP 与 eval

完整接口约定见 `protocol/openapi.yaml`。`POST /eval` 在独立的 `:eval` 进程中运行代码，默认超时 8 秒，最长 15 秒。同一时间只运行一个代码片段。超时会杀掉该进程，因此之前片段留下的状态会丢失；片段崩溃不会影响应用。把结果赋值给 `_result`：

```python
_result = __import__("xscript.android.screen", fromlist=["x"]).size()
```

eval 用于一次性探测。循环请放在项目的 `__init__.py` 中。

### 工程与文件（网页 IDE 使用）

| 接口 | 说明 | 错误 |
|---|---|---|
| `POST /projects/<name>` | 新建工程（带模板 `__init__.py` 入口）。工程名须以字母或下划线开头，只含字母（含中文）、数字、下划线 | 400 名称非法；409 已存在 |
| `GET /projects/<name>/files` | 文件列表 `files`，以及文件夹列表 `dirs`（含空文件夹） | |
| `PUT /projects/<name>/files` | 写入文件（覆盖）。带 `"create": true` 时只新建、不覆盖；中间文件夹自动创建 | 400 路径非法；404 工程不存在（仅 create）；409 已存在（仅 create） |
| `POST /projects/<name>/move` | 重命名/移动文件或文件夹 `{"from": "a.py", "to": "lib/a.py"}`；原子重命名，缺少的上级文件夹自动创建，不覆盖 | 400 路径非法、与原路径相同、移动入口、文件夹移入自身；404 工程或原路径不存在；409 目标已存在 |
| `POST /projects/<name>/dir` | 新建文件夹 `{"path": "lib/sub"}` | 400 路径非法；404 工程不存在；409 已存在 |
| `DELETE /projects/<name>/file?path=` | 删除一个文件或一个**空**文件夹。不能删除入口 `__init__.py` / `__init__.pyc` | 400 入口或路径非法；404 不存在；409 文件夹非空 |

路径一律相对于工程目录，使用 `/` 分隔；拒绝 `..`、`.`、空段和绝对路径，设备端还会再做一次规范化路径检查，确保不会越出工程目录。错误响应为 `{"error": "..."}`。

**行为变化（v0.2.1 之后）**：以前重复 `POST /projects/<name>` 返回 200，现在返回 409；以前删除不存在的文件返回 200 + `{"ok": false}`，现在返回 404；以前 `DELETE /file` 会递归删除整个文件夹，现在只删单个文件或空文件夹；以前可以删除 `__init__.py`，现在返回 400。依赖旧行为的外部脚本需要调整。不带 `create` 的 `PUT /files` 仍然覆盖写入，和以前一样。

**安全：** HTTP 服务和云控 WebSocket 中继没有身份验证。任何能访问该端口的人都可以读取项目，并通过 `/eval` 和 `/projects/<name>/run` 运行任意 Python 代码。请只在可信网络中使用，或通过 USB 使用 `adb forward`。
