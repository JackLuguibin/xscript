# 基于 AScript 4.0.10 静态证据的兼容实现

本轮以用户提供的 `ascript_analysis/airscript.apk` 为参考，在已有 XScript 上补齐可独立运行的功能。原始 APK SHA-256 为 `3a2a515f89a78d39a6c691047f2935aaf757ec115416a111417b480666a1f59c`。

这是接口与功能兼容实现，没有将原 APK 的原生库、模型、网页 bundle 或 Python 文件复制进应用。未声称完整恢复原厂服务、加密内核或全部行为。

## 浏览器脚本 IDE

安装本轮构建的 XScript APK 后，在手机打开开发者服务，从开发工具首页进入“脚本 IDE”，或访问：

```text
http://<手机地址>:9860/tools/ui/editor.html
```

也支持已观察到的 AScript 页面地址 `/website/src/editor.html`，但页面内部使用 XScript 现有 `/projects/*` 和 `/logs` 接口，不承诺兼容原厂 `/api/*` 响应格式。

功能包括工程创建、文件列表、新建/删除文件、编辑多文件、保存、保存后运行、停止、ZIP 导出和按游标读取运行日志。支持 Ctrl/Cmd+S、F6、Shift+F6 与 Tab 缩进。切换文件或工程保留当前页面内的草稿；关闭或离开页面时提示未保存内容，刷新后不恢复草稿。

保存失败阻止启动；保存期间继续输入会保留未保存标记并阻止此次启动。二进制文件只读，不能作为文本覆盖；工程入口不允许通过页面删除。

这是离线可用的文本编辑器，不依赖 CDN，没有 Monaco 语法服务、自动补全或远程文件变更冲突检测。2026-10-14 已补齐基本 DAP 断点、单步、栈和变量查看，见 `docs/DEBUGGING.md`。运行/停止与日志使用项目现有设备实现。服务访问方式和权限条件沿用现有开发工具。

代码：`android/app/src/main/assets/tools/editor{,-model}.js`、`editor.html`、`editor.css`。Android ToolsRouter 与本地 mock 均添加了 editor 页面别名。

## GP 图色流水线

可直接构造任务，或加载纯 JSON `.gp`、目录中的 `data.gp`、ZIP 内唯一的 `data.gp`：

```python
from ascript.android.screen import gp
from ascript.android.screen.gp import GPStack

result = GPStack.run_json([
    {"id": "ascript.android.screen.gp_tasks.Crop",
     "data": {"params": "0, 0, 200, 200"}},
    {"id": "ascript.android.screen.gp_tasks.Threshold",
     "data": {"params": "128"}},
    {"id": "ascript.android.screen.gp_tasks.Canny",
     "data": {"params": "blur=0, draw=Canny.DRAW_NONE, approx=0.02, detect_shape=True"}},
])
print(result.offset_x, result.offset_y, result.data)
# result = gp.run("/path/to/data.gp", cv_img=your_bgr_array)
```

`id` 取支持的 `ascript.android.screen.gp_tasks.*` 或本地 screen 任务名；参数支持原 UI 的 `data.params` 字面量格式，也支持结构化 `args`/`kwargs`。

实现包含裁剪、灰度、阈值、腐蚀/膨胀、形态学开闭、高斯模糊、缩放、旋转和 Canny/Sobel/Laplacian/Adaptive 轮廓识别，并恢复任务之间的通道转换、offset 和 data 传递。识别/缩放的具体行为沿用 XScript 的 OpenCV 后端。

轮廓 data 的 x/y/w/h/cx/cy 为当前图像局部坐标；offset_x/y 另行保存裁剪原点，不是包含任意缩放或旋转的屏幕变换。脚本点击前需要按其任务链正确处理坐标。

`ascript.android.screen.gp_tasks.CvFontLib(part_img, font_lib, confidence=0.95, rect=None, spacing=5, rgb=False)`（图片字库）：`part_img[i]`（文件路径或 BGR 数组）是字符 `font_lib[i]` 的小图，按列表顺序模板匹配，匹配到的区域会涂黑再找下一个字符，所以大图/易混字符放前面；匹配结果按中心 y 相差小于 `spacing` 分行，行内按左边缘排序。`Result.data` 为 `{"text", "words", "group"}`（无匹配为 `None`），`words` 里每项是带 `font` 的模板匹配字典；传入 `rect` 时坐标仍在输入图像坐标系。附带 `sort_and_concatenate_chars`、`group_chars_by_distance` 两个原有辅助函数，以及 XScript 扩展 `CvFontLib.recognize(part_img, font_lib, ..., image=None)`（直接返回文字，默认识别当前截图）。可用于 JSON GP 管线（`structured args`），原 UI 里的字库编辑器未移植。

不支持仅含生成 Python 的 `.gp` 包、云插件、自定义任务、OcrX 或参数中的函数调用（如 `R.img(...)`）。这些情况明确报错。加载 JSON/ZIP 不执行包内 Python。完整示例：`examples/gp_pipeline/__init__.py`。

## 视觉 AI 客户端

提供 `ascript.android.vlm.asai` 的 init/status/find/find_all/ask/ask_value/exists/wait/click，并提供 locate 别名。必须显式配置自己的兼容服务：

```python
import os
from ascript.android.vlm import asai

asai.init(
    api_key=os.environ["ASCRIPT_AI_KEY"],
    base_url=os.environ["ASCRIPT_AI_BASE_URL"],  # 例如自有服务的 https://host/v1
)
button = asai.find("蓝色的确认按钮")
if button:
    print(button["rect"], button["center_x"], button["center_y"])
print(asai.ask("当前页面的标题是什么？"))
```

服务协议为 `POST <base_url>/vision/locate` 与 `/vision/ask`，并非直接使用 OpenAI Chat Completions。请求发送 Bearer API key、JPEG data URL、上传图片宽高及 target/question 等字段。服务端需返回：

```json
{"results":[{"text":"确认","rect":[10,20,80,60],"confidence":0.95}]}
```

或者文本问答 `{"text":"页面标题"}`；类型问答为 `{"ok":true,"value":...}`。

返回 rect 必须是**上传图片像素坐标**，客户端将裁剪/缩放坐标还原到源图。coord_space 只作为服务端解释模型原始输出的提示；不能直接把归一化坐标放进返回 rect。

支持当前截图、ndarray、PIL、Android Bitmap 与图片路径输入，区域裁剪、图像 token 尺寸、置信度筛选、等待重截图、点击和类型化错误。未配置时不自动连接原厂服务。status 不输出 key，HTTP 重定向不转发凭证。

本轮实现的是客户端协议，不包含视觉模型或推理服务。完整调用示例：`examples/as_demo/vlm_custom_service.py`。

## 证据与设计选择

- 已有包清单/Android 投影证据：`ascript_analysis/analysis/rea-evidence.json`。具体 IDs 与初步分析见 `ascript_analysis/analysis/README.md`。
- 本轮 REA 对提取的 website/js/utils 作聚焦解析：parent `ev_f6e1fa409ebf7b3113250fc4e2341dae9e5d0eb90bc21760614ac12321d953db`，目录 digest `e0c95dd52155daf78ef4792ae6b99487c35e1a91b842eba328947e35d8ea49fa`。4 个 JS 文件解析成功；应用清单完整，动态语义存在 unknown。
- 本轮完整 REA 证据：`ascript_analysis/analysis/rea-reconstruction-evidence.json`。
- Web IDE 静态依据：提取的 editor/editor_editor.js:529 保存后运行，editor/editor_frame.js 的文件路由，utils/baseurl.js 的设备/代理地址构造。保留用户操作流程，改用现有 XScript 传输接口是实现设计选择。
- GP 静态依据：提取的 screen/gp_tool.py:90-113（id/data.params）、gp.py:73（通道边界）、gp.py:90（ZIP 模块），gp_tasks.py:204-385（轮廓算子），以及 gpui 的参数构造。原 GPStack.run_json 是占位；本轮 JSON 解释器属于扩展实现，不冒充原 APK 已有行为。
- VLM 静态依据：提取的 vlm/asai.py:191、236、275、358、396、417，_client.py:83、98，_frame.py:27、113、133，_errors.py:110、124。
- 提取文件与 APK 成员逐字节核对，其哈希记录在 `extracted-assets-hashes.json` 和 `python-app-hashes.json`。这些补充文件解析不是 REA Java 方法反编译证据。

## 验证与剩余缺口

- Python runtime：133 项测试，跳过 2 项，其余通过；含 10 项 GP 图像行为测试和 10 项 VLM 回环 HTTP 测试。
- Web IDE：8 项状态/并发测试与 1 项真实本地 HTTP 契约测试通过；HTTP 测试使用 mock，不执行真实 Python 或设备动作。
- Android：42 项 JVM 测试通过，debug APK 构建成功。
- 早期 Web IDE 浏览器连接超时；2026-10-14 已完成真实浏览器的断点、变量、单步及断开操作验证。
- 2026-10-14 已连接 ARM64 Android 17/API 37 模拟器，验证 DAP、合成短信查询和加速度传感器；尚未覆盖其他真机/ROM 与真实模型结果。
- 基本 DAP 调试现已补齐；HID 硬件、自带 IME、V4 密文运行、云端推理/计费/市场等模块仍未补齐，不能称为完整 AScript 复刻。

上次报告称默认 Java Runtime 不可用；本轮找到并成功使用 Android Studio 内置 JBR。后续于 2026-10-14 安装并验证 JADX MCP 0.7.1、Apktool 3.0.3 与 Frida；REA 已实际完成 Java 方法及 V4 原生库反编译。新增证据和兼容差异见 `ascript_analysis/analysis/deep-20261014/findings.md`。

## 第二轮：移植设备服务到 XScript

此前实现的 Web IDE、GP 和 VLM 已保留。本轮进一步把短信、定位、传感器与权限从空接口补为设备端实现，并提供 XScript 原生入口和 AScript 兼容入口：

```python
from xscript.android import sms, location, sensor, permission
# 或沿用 from ascript.android import sms, location
# 传感器旧入口：from ascript.android.sensor import LightSensor
# 权限旧入口：from ascript.android.system import permission
```

两套名字引用同一实现和订阅状态，不会各自注册重复监听。示例工程为 `examples/device_services/__init__.py`。

### 短信读取

支持 get_first/get_first_inbox/get_first_sent、get_recent/get_recent_inbox、get_by_address、query、1-based 闭区间 get_range 和 debug_info；保留 Sms/SmsClass 与 get_inbox_recent 别名。

先由用户授予读取权限：

```python
if permission.ensure(permission.READ_SMS):
    rows = sms.query(sms_type=sms.TYPE_INBOX, limit=10, offset=0)
```

Android 后端仅查询 `content://sms`，使用 selectionArgs 绑定 LIKE 号码包含匹配，并按 date 排序。没有发送或删除短信接口，没有上传或自动读取短信。为兼容原版，缺少权限或查询失败返回空结果；可通过 has_permission 先检查授权。READ_SMS 的实际授予还受 Android 安装来源/权限策略和设备 ROM 限制，声明权限不保证获授。

返回记录已按恢复的 Java 字段校正：id/thread_id/address/body/date/date_sent/type/read/subject/status，read 为布尔值，时间为毫秒；缺失字符串默认空串、缺失数字默认 0。负 offset 按 0，非正 limit 不限数量。权限申请时序仍与原版不同，不能声称全部行为等价。

### 定位

支持 request(call_back=None, min_time_updata=5000, min_distance_change=0)、get_last() 和 close()。回调及缓存读取返回 Location 包装对象，提供 getLatitude/getLongitude/getAltitude/getAccuracy/getSpeed/getBearing/getTime/getProvider。坐标为 Android WGS84。

后端按已有权限选择 GPS/network provider；只有粗略位置权限时不申请 GPS。每次重新订阅使用新 token、有界事件队列；close 取消监听。没有缓存时返回 None，不伪造坐标。需要保持脚本存活以接收 daemon 回调，使用完成后关闭。后台定位持续性受 Android 约束，本轮没有添加后台定位权限或绕过系统限制。

mock.start/stop/status 保留显式 NotImplementedError，不提供模拟定位或坐标转换的等价实现。

### 传感器

支持 AccelerometerSensor、GyroscopeSensor、LightSensor、ProximitySensor 的 on(delay) 装饰器与 stop()，以及 GpsSensor.on(min_time,min_distance)/stop()。三轴事件含 x/y/z，单值事件含 value；本地 Android 事件还保留 timestamp/accuracy。

每类传感器独立管理回调、注册 token 和有界队列。缺少硬件时不伪造数据，可重新注册。用户回调在锁外执行，长回调不会阻塞其他线程停止监听；异常回调不会阻止后续回调。重新注册不会把旧队列数据交给新批次。

### 权限与生命周期

新增非导出的 PermissionActivity，用系统 runtime 对话框申请已声明权限。脚本进程通过临时 app-private 广播接收主进程结果；精确定位同时申请 coarse/fine，用户仍可只授予粗略位置。

权限结果码按提取 Python 文档修正为 GRANTED=1、DENIED=0、TIMEOUT=-1、UNSUPPORTED=-2。调用者应比较符号常量，避免依赖旧占位实现的数字。Settings 类申请打开系统页面后立即返回 DENIED，调用方自行轮询 has；不在 Manifest 中声明或系统不支持的权限返回 UNSUPPORTED。未为相机、联系人、蓝牙等尚未移植能力追加授权声明。

脚本退出和每次 eval 结束（含异常）都会调用 Python 与 Android 清理钩子，注销定位/传感器监听。`:script` 被停止时进程随任务结束；可复用的 `:eval` 不保留本次订阅。

### 依据与验证边界

移植时的静态接口依据位于 `ascript_analysis/analysis/python-app/ascript/android/` 的 sms.py、location.py、sensor/__init__.py、system/permission.py。这些文件经过哈希核对；当时原 Java 方法体尚未恢复，Kotlin 后端为独立 Android 实现。后续已恢复短信 Java 方法，确认号码匹配、read 类型、subject 字段和错误行为存在兼容差异，详见 `ascript_analysis/analysis/sms-java-20261014/findings.md`。2026-10-14 已依据这些证据修正短信字段、查询与权限失败行为，并通过模拟器合成短信测试；权限申请时序仍未完全等价，详见 `docs/DEBUGGING.md`。

离线测试覆盖短信过滤分页与权限错误、定位订阅换代、传感器回调隔离/并发停止、权限状态及 eval 清理。测试不读取真实短信、不请求真实位置、不访问传感器硬件。构建和全仓测试通过仍不能替代真机权限及数据来源验证。
