# XScript 技术架构

XScript 是一个运行在 Android 上的 Python 自动化 App（AScript 风格）。PC 端（浏览器、Cursor MCP、云控服务器）通过 HTTP / WebSocket 把脚本推送到手机，手机上用内嵌的 CPython 3.10 执行，并通过无障碍服务或 root 完成点击、取节点树、截图、OCR 等操作。

本文基于当前仓库源码整理（Android 端约 7k 行 Kotlin，Python 端约 9k 行）。

## 1. 总览

```mermaid
flowchart LR
    subgraph PC["PC / 远端"]
        Cursor["Cursor + xscript-mcp<br/>(Python, httpx)"]
        Browser["浏览器 / curl"]
        Cloud["云控服务器<br/>(用户自建)"]
    end

    subgraph Phone["Android 设备 (com.xscript.app)"]
        subgraph Main["主进程"]
            HTTP["DeviceHttpService<br/>NanoHTTPD :9860~9869"]
            WS["CloudClient<br/>OkHttp WebSocket"]
            Router["ApiRouter"]
            Auto["Automation<br/>(通道路由)"]
            A11y["AccessibilityEngine"]
            Root["RootEngine / RootShell"]
            Cap["CaptureEngine"]
            AIDL["AutomationService<br/>(IAutomation Binder)"]
            Eval["EvalRunner<br/>(IEval 客户端)"]
            UI["Activity 界面 / FloatControl"]
        end
        subgraph EvalP[":eval 进程"]
            ES["EvalService<br/>Chaquopy 常驻解释器"]
        end
        subgraph Script[":script 进程"]
            SS["ScriptService"]
            Py["Chaquopy CPython 3.10<br/>xscript / ascript 包"]
            Bridge["Bridge.kt"]
            Local["OcrEngine / OnnxEngine / ScriptUi / SystemApi"]
        end
    end

    Cursor -- "HTTP (adb forward / 局域网)" --> HTTP
    Browser --> HTTP
    WS -- "设备主动外连" --> Cloud
    HTTP --> Router
    WS --> Router
    Router --> Auto
    Router --> Eval
    Eval -- "IEval Binder<br/>超时则杀进程" --> ES
    ES -- "IAutomation" --> AIDL
    Router -- "startService" --> SS
    Auto --> A11y
    Auto --> Root
    Router --> Cap
    SS --> Py --> Bridge
    Bridge --> Local
    Bridge -- "Binder + Pipe" --> AIDL --> Auto
    AIDL --> Cap
```

## 2. 仓库结构

| 目录 | 语言 | 职责 |
| --- | --- | --- |
仓库分三部分，另有它们共享的接口契约和开发脚本：

| 目录 | 语言 | 职责 |
| --- | --- | --- |
| **`android/`** | | **安卓 App** |
| `android/app/` | Kotlin | App 本体：HTTP 服务、云控客户端、卡密校验、无障碍/root 引擎、截图、OCR、悬浮窗、Chaquopy 集成 |
| `android/app/src/main/assets/tools/` | HTML/JS | 设备提供的网页开发工具：脚本 IDE、图色工具、标注工具、投屏 |
| `android/python-runtime/xscript/` | Python | 设备端原生 API：`action`、`node`、`screen`、`system`、`ui`，以及 `runtime`（桥接、运行器） |
| `android/python-runtime/ascript/` | Python | AScript（ascript-tip 1.3.0）兼容层，基于 `xscript` 实现 |
| `android/python-runtime/tests/` | Python | PC 端单测（使用假的 bridge，不依赖手机） |
| `android/build.sh` | Bash | 定位 JDK / SDK / Python 3.10 后执行 Gradle |
| **`backend/`** | | **管理后台：云控、打包、授权** |
| `backend/xscript_server/` | Python | FastAPI 服务：设备连接（`/ws`）、指令下发、HTTP 转发、分组、定时任务、卡密、打包队列、用户与权限、操作日志 |
| `backend/web/` | TypeScript | React + Ant Design 控制台（Vite 构建，由服务端托管） |
| `backend/xscript_pack.py` | Python | APK 打包 CLI（后台打包任务也调用它） |
| `backend/tests/` | Python | 服务端测试（真实 uvicorn + 模拟设备 WebSocket） |
| **`ide/`** | | **编辑器端** |
| `ide/vscode-extension/` | TypeScript | VS Code / Cursor 插件：上传运行、日志、运行选中代码、截图、补全 |
| `ide/mcp-server/` | Python | Cursor MCP 服务 `xscript-mcp` |
| `ide/python-stubs/` | `.pyi` | 由 `scripts/gen_stubs.py` 生成的类型存根，供 PC 端 IDE 补全 |
| **共享** | | |
| `protocol/openapi.yaml` | YAML | 设备 HTTP 接口契约（App 实现；插件、MCP、云控转发使用） |
| `scripts/` | Bash/Python | 跨部分的开发脚本：存根生成、mock 设备、端到端冒烟、`verify.sh` |
| `examples/` | Python | 示例工程（原生 API 与 AScript API 各一套） |

依赖方向：`backend/xscript_pack.py` 调用 `android/build.sh` 并读取 `android/python-runtime` 里的 requirements 解析，后台的打包任务再调用 `xscript_pack.py`；`scripts/gen_stubs.py` 从 `android/python-runtime` 生成 `ide/python-stubs`，插件构建时再把存根拷进自身。App 不依赖 `backend/` 和 `ide/` 的代码，只通过 HTTP / WebSocket 协议交互。

## 3. 技术栈

| 层 | 选型 |
| --- | --- |
| Android | Kotlin、JDK 17、`minSdk 26` / `targetSdk 34` / `compileSdk 37`，ABI 仅 `arm64-v8a`、`x86_64` |
| 嵌入式 Python | Chaquopy 17，CPython 3.10（选 3.10 是因为 Chaquopy 的 OpenCV wheel 最高只到 3.10） |
| Python 依赖（APK 内） | `numpy 1.23.3`、`opencv-python 4.5.1.48`、`pillow 9.2.0`、`pyyaml 6.0.3`、`requests 2.32.3`、`packaging 24.2`；其它包运行时安装（5.3） |
| 端侧推理 | ONNX Runtime Android 1.22.0（YOLO、PaddleOCR PP-OCRv5，见 4.10） |
| HTTP 服务 | NanoHTTPD 2.3.1 |
| 云控 / 网络 | OkHttp 4.12.0（WebSocket） |
| OCR | Google ML Kit `text-recognition-chinese` 16.0.1（离线模型）；PaddleOCR PP-OCRv5 / v4（ONNX，首次使用时下载） |
| UI | AndroidX AppCompat + Material，界面为代码构建（`UiKit.kt`），无 Compose |
| MCP | `mcp 2.2.0`（兼容 1.x FastMCP）、`httpx 0.28.1` |
| 管理后台 | FastAPI 0.142、uvicorn、SQLAlchemy 2.1（SQLite WAL）、`cryptography`（ECDSA P-256 卡密签名、scrypt 密码）；前端 React 19、Ant Design 6、TanStack Query、Vite |

## 4. Android 端

### 4.1 进程模型

App 有三个进程，这是整个架构最核心的设计：

| 进程 | 组件 | 生命周期 |
| --- | --- | --- |
| 主进程 `com.xscript.app` | `XscriptApp`、各 Activity、`XscriptAccessibilityService`、`DeviceHttpService`（前台服务）、`AutomationService`（Binder）、`CloudClient`、`CaptureEngine`、`FloatControl` | 常驻 |
| `:script` 进程 | `ScriptService`、Chaquopy 解释器、`Bridge`、`ScriptUi`、`OcrEngine`、`SystemApi` | 每次运行一个工程，结束或停止时 `Process.killProcess` 自杀 |
| `:eval` 进程 | `EvalService`、Chaquopy 解释器 | 首次 `/eval` 时拉起并常驻；超时或崩溃时被杀，下次调用重新拉起 |

这样拆分的原因（见 `ScriptService.kt`、`IAutomation.aidl` 注释）：

- 停止脚本 = 杀进程。任意 Python 代码（死循环、阻塞的 native 调用、子线程、悬浮窗）都无法被可靠地中断，杀进程是唯一可靠手段。
- 脚本崩溃不会带走无障碍服务和 MediaProjection 截图会话，它们都留在主进程里。

`:eval` 和 `:script` 一样通过 `IAutomation` 访问主进程的自动化能力，因此 eval 里的代码与脚本里的代码行为一致。

`XscriptApp.onCreate` 通过进程名判断 `isMainProcess`，只有主进程会探测 root、启动 `AutomationService`、自动连接云控，并重新挂上下一个定时任务的闹钟。

### 4.1.1 运行监管、开机自启与定时任务

`ScriptSupervisor`（主进程）负责脚本的生命周期：

- 每次运行开始时，`:script` 进程调用 `IAutomation.attachScript(project, IEventSink)`。主进程对这个 Binder 执行 `linkToDeath`，脚本进程无论是正常退出、崩溃还是被杀，主进程都能收到通知。正常结束时脚本还会通过 `script_finished` 上报退出码，用来区分“崩溃”和“正常退出”。
- **停止后重新运行**：用户停止（界面、悬浮按钮、HTTP、MCP，都经过 `ScriptService.stop`）会打上 `userStop` 标记，不会触发重跑。其它情况下，如果工程开启了该选项，3 秒后重跑。连续 5 次在 10 秒内退出就暂停重跑，直到下一次手动启动，防止崩溃循环。`system.reboot(delay)` 也走这条路径。
- **开机自启**：`Scheduler.Receiver` 收到 `BOOT_COMPLETED` 后，先重新挂闹钟，再按需启动 `DeviceHttpService`，然后等无障碍或 root 就绪（最多 60 秒）并启动开机工程。
- **定时任务**：`Schedule`（纯数据，含下次触发时间的计算，有 JVM 单测）加 `ScheduleStore`（`filesDir/schedules.json`）。`Scheduler` 只挂一个 AlarmManager 闹钟，对应最早的下一次触发；闹钟触发后运行到期任务、推进时间、再挂下一个。有精确闹钟授权时用 `setExactAndAllowWhileIdle`，否则用 `setAndAllowWhileIdle`。时间调整、时区变化、应用更新后都会重新计算。同一时间只运行一个工程，`if_running=restart` 的任务通过 `launch(restart=true)` 先停掉当前工程，等它的进程死亡后再启动。

### 4.1.2 事件

`EventHub`（主进程）从无障碍服务（按键过滤、控件点击 / 长按 / 滚动、Toast、通知、原始事件）和 `XscriptNotificationListener`（通知使用权）收集事件，只把脚本订阅了的类型序列化成 JSON，通过 `IEventSink.onEvent`（oneway）推到 `:script` 进程。那边放进一个有界队列，Python 用 `Bridge.pollEvent` 取出，在守护线程里分发。

- 订阅为空时事件完全不做处理。
- 按键过滤（`FLAG_REQUEST_FILTER_KEY_EVENTS`）只在有脚本监听按键时打开，并且从不消费按键。
- 通知的 `contentIntent` 保存在 LRU 缓存里，供 `event.send()` 使用。

### 4.2 跨进程通信

```mermaid
sequenceDiagram
    participant Py as Python 脚本 (:script)
    participant B as Bridge.kt
    participant D as AutomationDispatcher
    participant S as AutomationService (主进程)
    participant A as Automation

    Py->>B: bridge.click(x, y, dur)
    B->>D: click()
    alt 当前在主进程
        D->>A: 直接调用
    else 在 :script 进程
        D->>S: IAutomation.click() (Binder)
        S->>A: click()
    end
    A-->>Py: bool
```

- `AutomationDispatcher` 是统一入口：主进程内直接调用 `Automation`，`:script` 进程内走 `IAutomation` Binder。Binder 连接是异步建立的，`rpc()` 最多等 3 秒。
- 大数据（节点树 JSON、截图原始帧）经 `ParcelFileDescriptor.createPipe()` 传输（`Pipes.kt`），绕开 Binder 1 MB 事务限制。
- 截图帧格式由 `FrameCodec` 定义：8 字节小端头（宽、高）+ ARGB_8888 原始像素。Python 侧用 numpy 直接解码，不走 PNG 编解码。
- `AutomationService` 的每个方法都包了一层 `safe {}`，异常时返回空值 / `false`，避免远程异常把脚本进程打挂。
- 其它跨进程状态用文件共享：
  - `RunState`：`filesDir/running-project` 记录当前运行的工程名，主进程再用进程列表校验 `:script` 是否还活着，避免崩溃后一直显示“运行中”。
  - `LogBuffer`：`filesDir/logs/runtime.jsonl`（JSON Lines）+ `seq` 序号文件。跨进程用文件锁互斥，进程内先用 JVM 锁串行化（同一进程重复 `FileChannel.lock()` 会抛异常而不是阻塞）。超过 2 MB 截断保留尾部 512 KB。`/logs?since=` 从文件尾部按 64 KB 分块反向扫描，读到调用方已有的序号就停止，所以轮询成本与新增条目数成正比，与文件大小无关；序号被重置（清除数据）时返回最新条目。

### 4.3 自动化通道（`Automation.kt`）

根据设置里的“运行模式”（`auto` / `accessibility` / `root`）选择通道：

| 能力 | 无障碍通道 | Root 通道 |
| --- | --- | --- |
| 点击 / 滑动 / 手势 | `dispatchGesture` | `input tap` / `input swipe`；多点手势退化为首笔画的 `input motionevent` 回放 |
| 节点树 | `AccessibilityNodeInfo` → `NodeDumper` | `uiautomator dump`（部分 ROM / MuMu 模拟器上不可用） |
| 节点操作 | `performAction` | 按节点中心坐标模拟点击 / 输入 / 滑动 |
| 文本输入 | `ACTION_SET_TEXT` | `input text` |
| 按键 | 全局动作；`key:<code>` 强制走 root `input keyevent` | `input keyevent` |

规则：

- `auto` 模式优先无障碍，其次 root。
- 只要无障碍开着，节点树和节点操作就一律走无障碍（更快、信息更全），即使运行模式是 root。
- `RootShell.run` 复用一个常驻 `su` shell 执行手势、按键、文本输入等只关心退出码的命令：每条命令包在 `sh -c` 里，后面追加带序号的结束标记来读取退出码；超时或 shell 退出时重建会话，失败时回退到一次性的 `su -c`。需要输出或二进制数据的命令（`screencap`、`uiautomator dump`、`dumpsys`、`system.shell`）仍然用 `exec` / `execRaw` 单独起进程。在 MuMu 模拟器上实测，每次 `su` 启动约 250 ms，`/action` 按键请求由此从约 250 ms 降到约 8 ms。
- root 状态缓存，否定结果每 30 秒后台重新探测一次。

节点路径（`path`）是真实树中的索引路径，即使 mode 0 精简输出时剪掉了兄弟节点，也能据此重新定位节点。

### 4.4 截图（`CaptureEngine.kt`）

来源按优先级降级：

1. MediaProjection（系统录屏，需要一次授权，最快）。屏幕静止时不会产生新帧，所以缓存最后一帧。
2. 无障碍截图（API 30+），系统限流约 3 fps，代码里做了 340 ms 节流。
3. Root `screencap`（不带 `-p`，直接读原始 RGBA，省去 PNG 编码）。

有一个针对模拟器的兜底：MuMu、雷电等模拟器的无障碍截图可能是全黑的。引擎用 12×12 采样网格检测纯黑帧，如果 root 截图正常，就在 10 分钟内不再信任无障碍截图。

### 4.5 对外 API（`ApiRouter.kt`）

`ApiRouter` 与传输层无关，被 HTTP 服务和云控 WebSocket 共用，因此两种入口暴露的是完全相同的接口（契约见 `protocol/openapi.yaml`）：

| 分类 | 接口 |
| --- | --- |
| 设备 | `GET /status`、`GET /screen`（png / jpg）、`GET /ui-tree?mode=`、`POST /action`、`GET/PUT /settings` |
| 工程 | `GET /projects`、`POST/DELETE /projects/{name}`、`GET/PUT /projects/{name}/files`（列表含 `dirs`；`create:true` 只新建不覆盖）、`POST /projects/{name}/dir`、`POST /projects/{name}/move`（重命名/移动）、`GET/DELETE /projects/{name}/file`、`GET/PUT /projects/{name}/zip`、`POST /projects/{name}/run`、`POST /projects/{name}/stop`、`GET/PUT /projects/{name}/config`（开机自启 / 停止后重新运行） |
| 定时任务 | `GET/POST /schedules`、`GET/PUT/DELETE /schedules/{id}`、`POST /schedules/{id}/run` |
| AScript 迁移 | `GET /ascript/projects`、`POST /ascript/import`（从 `/sdcard/airscript/model` 导入） |
| 调试 | `GET/DELETE /logs`、`POST /eval` |
| 开发工具 | `GET /tools/`（网页）、`/tools/snapshots`、`POST /tools/vision`、`/tools/datasets/...`、`GET /screen/stream`（投屏） |

异常统一映射：`NoSuchElementException` → 404，`IllegalArgumentException` → 400，`IllegalStateException` → 409，其它 → 500。工程存储（`ProjectStore`）按这个约定抛异常：名称或路径非法、删除入口 → 400，工程或文件不存在 → 404，重名、文件夹非空 → 409；所有路径先规范化，再按真实路径确认没有越出工程目录。

`Reply` 可以携带内存字节，也可以携带文件（`Reply.file`）。zip 导出先写临时文件，`?raw=1` 读取工程文件时直接返回原文件，HTTP 层都以流的方式发送。

**HTTP 服务**（`DeviceHttpServer` / `DeviceHttpService`）：

- 作为前台服务运行（`dataSync | mediaProjection`），监听 `0.0.0.0`，默认端口 9860，被占用时依次尝试到 9869。刻意避开 AScript 的 9096 及其备用端口，两个 App 可以同时安装、同时运行，`adb forward` 也不会转到错误的 App。
- **无鉴权**：任何能访问端口的人都可以调用全部接口。
- **无 CORS 头**：不发送 `Access-Control-Allow-*`，其他网站的页面无法读取接口响应。设备自带的开发工具页面（`/tools/`）与接口同源，不受影响。
- **请求体**：上限 200 MB，先校验 `Content-Length`。4 MB 以内放内存，更大的写入 `cacheDir/http-spool` 临时文件，交给路由时以流读取，请求结束后删除。仍然不用 NanoHTTPD 的 `parseBody`，避免破坏二进制上传。
- 请求头 `X-XScript-Client` 用于 `ClientTracker` 在首页展示已连接客户端。

**云控**（`CloudClient`）：设备主动外连 `ws://` / `wss://`，能穿透 NAT。一条连接上有两套指令（完整协议见 `docs/CLOUD.md`）：

- **HTTP 转发**：`{"type":"request"}` / `{"type":"response"}`，body 为 base64，交给同一个 `ApiRouter`，所以云控能调用全部 HTTP 接口。
- **AScript 指令集**：带 `path` 的帧（`app_run`、`app_stop`、`device_info`、`screen_shot`、`device_action`、`app_list`、`message`），回执带 `code` / `msg` / `device_id`，并回显 `seq` 关联号。`app_run` 的 `param` 经 `ScriptService` 传给脚本（`system.params()`，并写进 `builtins`），`card` 用于顺便激活卡密。

设备在 `hello` 和 `status` 帧里上报 `device_id`（`ANDROID_ID`）、分组和包名；运行开始、结束时推一次状态，另外每 60 秒一次。脚本的 `cloud.send()` 经 `IAutomation.control` 到主进程发出 `{"type":"data"}`；服务端的 `message` 经 `EventHub` 以 `cloud` 事件推给脚本。请求由 2 线程的线程池处理，25 秒 ping 保活，断线后 5 秒重连。鉴权完全交给服务端（URL 里带 token）。

服务端是管理后台 `backend/xscript_server`（见 6.4）：设备表按 `device_id@包名` 区分同一台手机上的多个 App，支持分组（设备上报 + 后台覆盖）、按设备 / 分组 / 包名批量下发、脚本数据回显、服务端定时任务，以及卡密激活接口。设备用后台签发的设备密钥连接 `/ws`。

### 4.6 开发工具（`tools/`：脚本 IDE、图色、标注、投屏）

对应 AScript 网页端的脚本 IDE、图色工具、YOLO 标注工具和投屏。页面放在 `assets/tools/`（原生 HTML/JS，无构建步骤），由设备的 HTTP 服务直接提供，浏览器打开 `http://<ip>:<端口>/tools/` 即可使用。

| 组件 | 职责 |
| --- | --- |
| `ToolsRouter` | 处理 `/tools/*`：静态页面、快照、裁剪模板、图色测试、数据集 |
| `SnapshotStore` | 把当前屏幕冻结为 PNG（`filesDir/tools/snapshots`，保留最近 20 张），取色、裁剪、测试都基于同一帧，数值前后一致 |
| `vision.py`（`:eval` 进程） | `POST /tools/vision` 经 `IEval.vision` 在 `:eval` 进程执行 pixel / 找色 / 比色 / 找图 / OCR，复用脚本使用的 `xscript.android.image`，所以工具里测出来的结果与脚本运行时一致；超时同样杀进程 |
| `DatasetStore` | 标注数据集（外部存储 `datasets/<name>/`：`meta.json`、`images/`、`labels/<id>.json`，框以像素存储）；导出 Ultralytics 格式 zip（`images/`、`labels/` 的 train/val 划分 + `data.yaml`） |
| 脚本 IDE（`editor*.js`） | `editor-model.js`：工程/文件状态、草稿与保存、目录树构建与键盘导航（纯函数，Node 可测）；`editor.js`：页面与目录树渲染；`editor-syntax.js`：本地 Python 词法高亮（盖在 `<textarea>` 下面的着色层）；`editor-debug.js`：DAP 客户端。全部原生 JS，无第三方依赖 |
| `ScreenStream` | 投屏：生产线程截图、缩放、JPEG 编码后写入管道，HTTP 以 chunked `multipart/x-mixed-replace` 推给浏览器；客户端断开时写入失败，线程退出；最多 2 路 |

投屏页的点击和拖动按画面比例映射回屏幕像素，再调用 `/action`，因此走的是和脚本相同的自动化通道（无障碍或 root）。帧率取决于截图来源：MuMu 上 root `screencap` 约 2.5 fps，授予图色权限（MediaProjection）后更快。

MCP 也提供了对应工具（`take_snapshot`、`vision_test`、`crop_template`、`list_datasets`、`export_dataset`），AI 可以先在冻结的截图上调好颜色、相似度和区域，再写进脚本。

### 4.7 工程存储（`ProjectStore.kt`）

- 工程目录：`<外部 files 目录>/projects/<name>/`，入口为 `__init__.py`，资源约定放在 `res/img/`。
- 目录名同时是 Python 包名，所以必须是合法标识符（允许中文，与 AScript 一致）。
- 相对路径做了规范化，拒绝 `..` 和空段，防止路径穿越。
- 支持 zip 导入 / 导出和 AScript 工程导入。
- zip 导入逐条目流式解压到 `import-tmp/` 暂存目录，确认包含 `__init__.py` 后才删除旧工程并移动文件（同一文件系统内是 rename），所以坏的 zip 不会破坏已有工程，大文件也不会整块读进内存。

### 4.8 脚本侧原生能力

这些组件运行在 Python 所在进程，由 `Bridge.kt` 以静态方法暴露给 Python：

- `OcrEngine`：ML Kit 中文 + 拉丁离线识别，返回行 / 元素及坐标。ML Kit 的初始化 Provider 只覆盖主进程，所以非主进程会手动初始化。
- `ScriptUi`：toast、阻塞式对话框、悬浮 WebView 窗口（注入 `xscript` / `airscript` 两个 JS 接口）、绘图画布。Python 通过 `ui_poll` 轮询窗口事件，没有 Java→Python 回调，线程模型简单。
- `SystemApi`：打开应用、设备 / 电量 / 内存信息、剪贴板、KeyValue 存储、shell（默认 root）、音量、亮度、TTS、振动等，以 `op` + JSON 参数分发。

### 4.8.1 端侧推理（`OnnxEngine`）

`OnnxEngine`（`ml/`）在脚本所在进程（`:script` / `:eval`）里持有 ONNX Runtime 会话，张量不跨 Binder。它只负责搬运张量：Python 传入 float32 原始字节和形状，拿回“u32 头长度 + JSON 头 + 各输出字节”。模型相关的前后处理全部在 Python（numpy / cv2）里完成，PC 上用 `onnxruntime` 包跑同一套代码，所以 YOLO 解码和 PaddleOCR 后处理都能在 PC 上对着真实模型做单测。

- 大输出可以在设备端先做 argmax（`reduce="argmax"`）。PP-OCR 识别模型每行输出约 18k 个类别，逐元素搬到 Python 要几秒；在 Kotlin 里归约后只回传每个时间步的类别和概率，整屏识别从约 4.4 s 降到约 1.1 s（MuMu）。
- 模型文件放在外部存储 `models/`（`ModelStore`，HTTP `GET/PUT/DELETE /models/...`）。PaddleOCR 模型首次使用时从 ModelScope 下载（Hugging Face 备用），按固定的 SHA-256 校验后原子替换；校验结果按大小和修改时间缓存，避免每次运行都重新计算 16 MB 文件的哈希。
- `accel="nnapi"` 先尝试 NNAPI，失败时回退 CPU。

### 4.9 界面

`LauncherActivity` 是桌面入口：XScript 本身进入 `MainActivity`，打包出来的 App 进入 `PackActivity`（见 4.10）。`MainActivity` 是仿 AScript 的首页（开发者地址、AI 编程连接、运行模式、各项权限、云控、小程序列表等），另有工程列表、工程详情、简易编辑器、日志页。`FloatControl` 是运行时的悬浮停止按钮，放在主进程，这样脚本进程被杀后按钮也能正常收起。

### 4.10 APK 打包与卡密

打包不是另写一个壳，而是用同一份 Gradle 工程加一个参数：`xscript_pack.py` 写出 `pack.properties`，以 `-Pxscript.pack=...` 调用构建。`build.gradle.kts` 据此：

- 改 `applicationId`、版本号、ABI，以及桌面名称和图标（`manifestPlaceholders`）；
- 把工程复制进 `assets/pack/<工程名>/`，生成名称和图标资源；
- 写入 `BuildConfig`（`PACKAGED`、`PACK_PROJECT`、卡密公钥和服务器、云控地址、是否保留局域网接口）；
- 可选：配置 release 签名；构建时就把 `requirements.txt` 装进 APK。

构建输出在 `build-pack/<包名>/`，和开发版互不干扰。运行时：

- `PackInstaller` 在首次启动和版本号变化时把工程从 assets 复制到工程目录，之后复用全部现有机制（运行器、定时任务、开机自启、云控）。
- `DeviceHttpService` 照常运行（它还持有 MediaProjection 截图会话），但默认不开局域网端口。

卡密（`license/`）：

- **令牌格式**：`base64url(payload).base64url(ECDSA P-256 签名)`，payload 里有卡号、设备 ID（或 `*`）、包名（或 `*`）、到期时间。App 只内置公钥，验签在本地完成。
- **激活**：输入短卡密时向授权服务器请求令牌，服务器在首次激活时绑定设备；输入长令牌则离线校验。
- **复核**：有服务器时每 6 小时复核一次，被停用的卡密在复核后失效，网络不通则保留当前授权。
- **拦截点**：`ScriptService.run` 是所有启动路径（界面、HTTP、云控、定时任务、开机）的汇合点，校验放在这里，未授权时拒绝启动并写日志。
- **时钟保护**：记录见过的最晚时间，防止通过回拨系统时钟延长授权。

`LicenseToken`（纯 JVM）的 JVM 单测直接验证 Python 签发的令牌，保证两边格式一致。

## 5. Python 运行时

### 5.1 分层

```mermaid
flowchart TB
    User["用户脚本 __init__.py"]
    AS["ascript.android.*<br/>(AScript 兼容层)"]
    XS["xscript.android.*<br/>action / node / screen / system / ui"]
    Core["纯 Python 核心<br/>tree.py (选择器引擎)<br/>image.py (找色 / 模板匹配 / OCR 封装)"]
    BR["xscript.runtime.bridge"]
    J["_JavaBridge → com.xscript.app.runtime.Bridge"]
    M["_MissingJava (PC 端空实现)"]

    User --> AS
    User --> XS
    AS --> XS
    AS --> Core
    XS --> Core
    XS --> BR
    Core --> BR
    BR --> J
    BR -. "PC 上导入 Java 失败时" .-> M
```

- `bridge.py` 是 Python 与 Java 之间唯一的接触面。导入 Java 类失败（即在 PC 上）时自动换成 `_MissingJava`，所有调用返回“不可用”的值，单测再对它打 monkeypatch。
- `tree.py` 是纯 Python 的节点查询引擎：对 dump 出来的树建立父子 / 兄弟索引，按“过滤 → 关系（parent / child / brother）→ 过滤 …”的流水线求值。`node.Selector` 每次查找都重新 dump 一次整棵树，在 Python 侧匹配。
- `xpath.py` 是在同一棵索引树上运行的 XPath 1.0 子集，由分词器、递归下降解析器和求值器组成，解析结果会缓存。它支持轴、谓词、函数、分组和并集，属性名沿用 uiautomator 的叫法。
- `event.py` 负责事件订阅与分发，见 4.1.2。
- `image.py`（约 900 行）是图色核心，`xscript.android.screen` 和 `ascript.android.screen` 共用：原始帧 → numpy BGR、多点找色、带 alpha 掩码的多尺度模板匹配（OpenCV，含降采样粗筛 + 局部精修）、OCR 结果封装。
- `ascript/` 按 ascript-tip 1.3.0 的 API 形状实现，已有 AScript 工程无需修改即可运行。暂不支持的接口通过 `_compat.warn_once` 提示。

### 5.2 运行流程

```mermaid
sequenceDiagram
    participant C as 客户端
    participant R as ApiRouter (主进程)
    participant S as ScriptService (:script)
    participant P as runner.py

    C->>R: POST /projects/demo/run
    R->>R: 检查工程存在、当前无运行中的工程
    R->>S: startService(ACTION_RUN)
    S->>S: 启动 Python，绑定 AutomationService
    S->>P: run_project(dir)
    P->>P: 重定向 stdout/stderr → LogBuffer<br/>sys.path 加入工程目录及父目录，chdir<br/>清理同名模块缓存
    P->>P: import demo（执行 __init__.py）
    P->>P: 等待脚本创建的非守护线程
    P-->>S: 返回退出码
    S->>S: RunState 清空，隐藏悬浮窗，killProcess
```

- 同一时间只运行一个工程，重复运行返回 409。
- 停止：`POST /stop` 或悬浮按钮 → `ScriptService` 收到 `ACTION_STOP` → 杀进程。这属于用户停止，不会触发“停止后重新运行”。
- 进程结束后 `ScriptSupervisor` 通过 Binder 死亡通知决定下一步：启动排队中的工程、按选项重跑，或者什么都不做（见 4.1.1）。
- `_wait_for_threads` 模拟 CPython 退出时 join 非守护线程的行为。在 Chaquopy 下解释器的“主线程”是 Android UI Looper，永远不会结束，所以显式跳过它和 `_DummyThread`。

### 5.3 运行时安装 pip 包（`xscript.android.pip`）

Chaquopy 默认只在构建时安装包。这里没有在手机上运行 pip：pip 依赖 `sys.executable`、子进程和编译工具链，在 Chaquopy 里都不可靠。所以自己实现了一个只装 wheel 的安装器：

- **包来源**：先查 Chaquopy 的 Android 索引（`android_<api>_<abi>` 标签的原生 wheel），再查 PyPI 的 JSON simple API（只取 `py3-none-any` 纯 Python wheel）。
- **依赖解析**：用 `packaging` 按 Android / Python 3.10 的环境求值依赖标记，深度优先解析。
- **跳过已有的包**：已安装且满足要求的不再安装；APK 自带的包永远不替换，否则编译进 APK 的 numpy 等版本会和新包不一致。
- **安装方式**：wheel 先解压到临时目录再改名进 `files/pip/site-packages`，卸载按 RECORD 删除。原生 wheel 的共享库（`chaquopy/lib/*.so`）合并到同一目录。
- **加载**：`sitepkgs.activate()` 在每个脚本 / eval 进程启动时把这个目录追加到 `sys.path` 末尾（自带包优先），并按依赖顺序 `dlopen` 其中的共享库，这和 Chaquopy 对 APK 内原生包的处理一致。
- **并发**：安装用文件锁互斥，`:script` 和 `:eval` 同时安装也不会互相破坏。
- **requirements.txt**：`runner` 在导入工程前检查，只安装缺失的包，所以只有第一次运行需要联网。

实测（MuMu）：`schedule`、`pymysql`、`cffi`（含 `chaquopy-libffi`）约 8 秒；`pandas` 连同依赖由 requirements.txt 自动安装后正常导入和计算。

### 5.4 `/eval`

`/eval` 面向 MCP 的短小探测（看一下节点、测一个颜色），约定把结果赋给 `_result`，超时时间限制在 200 ms～15 s 之间，长逻辑应放进工程里运行。

- 主进程的 `EvalRunner` 只是客户端：它绑定 `:eval` 进程里的 `EvalService`，通过 `IEval.run(code)` 执行，自己在线程池里等待结果。
- 超时后通过 `IEval.pid()` 拿到进程号并 `killProcess`，死循环和阻塞的 native 调用都会随进程一起结束。下次调用重新拉起进程（冷启动约 0.7～1.2 s，热调用约 10 ms）。
- 代码崩溃（例如 `os._exit`）会表现为 `DeadObjectException`，返回 `ok=false`，下次调用自动重连。
- 同一时间只执行一个 eval，因为超时杀进程会连带杀掉并发的其他 eval。
- MCP 侧拒绝 `while True` 的检查只是给 AI 的提示，真正的保证来自设备端杀进程。

## 6. PC 端工具链

### 6.1 MCP 服务（`ide/mcp-server/`）

`xscript-mcp` 是一个 stdio MCP 服务，`DeviceClient` 用 httpx 调用设备 HTTP API，目标地址由环境变量 `XSCRIPT_DEVICE` 或 `connect_device` 工具设置。提供的工具：

- 设备：`connect_device`、`get_device_status`、`screen_capture`（返回 MCP Image）、`dump_ui_tree`、`device_action`
- 工程：`list_projects`、`list_project_files`、`read_project_file`、`upload_file`、`upload_directory`（本地打 zip 后上传，跳过 `.git`、`__pycache__` 等）、`delete_project`、`run_project`、`stop_project`、`get_run_log`
- 运行选项与定时任务：`project_run_options`、`list_schedules`、`add_schedule`、`update_schedule`、`delete_schedule`、`run_schedule_now`
- 调试：`eval_python`（拒绝包含 `while True` 的代码）
- 模型与包：`list_models`、`upload_model`、`pip_install`、`pip_list`、`pip_uninstall`；`vision_test` 支持 `op="yolo"` 和 `engine="paddle"`
- 文档：`get_module_apis`、`search_api`，查询本地 `api_catalog.json`

`docs/AGENT_RULES.md` 是给 AI 编程时用的约束说明。

### 6.2 VS Code 插件（`ide/vscode-extension/`）

TypeScript 插件，用 Node 自带的 `fetch` 调设备 HTTP API，请求头 `X-XScript-Client: vscode`（首页“AI 编程连接”据此显示客户端）。工程根目录是从当前文件向上找到的最外层带 `__init__.py` 的目录。上传用 `PUT /projects/{name}/files` 批量接口（跳过规则与 MCP 的 `zip_directory` 相同），运行后轮询 `/logs` 写入 Output 面板，脚本退出后停止轮询。`client.ts` 和 `project.ts` 不依赖 `vscode` 模块，单测用 `node --test` 跑在 `scripts/mock_device.py` 上。构建时 `scripts/copy-stubs.js` 把 `ide/python-stubs` 拷进插件，`XScript: Enable API Autocomplete` 把它加到 `python.analysis.extraPaths`。

### 6.3 管理后台（`backend/xscript_server/` + `backend/web/`）

单进程 FastAPI 服务，前端是 React + Ant Design 的单页应用，构建产物由服务端直接托管（`/` 之外的非 API 路径回退到 `index.html`）。

| 模块 | 职责 |
| --- | --- |
| `hub.py` | 在线连接表（内存）、按 `all` / `group:` / `app:` / 设备 id 选目标、AScript 指令（按 `seq` 配对回执）、HTTP 转发（按 `id` 配对）、定时任务调度（每 15 秒检查，先在数据库里认领再执行，避免重复） |
| `routes/devices.py` | 设备列表（数据库里的历史设备 + 内存里的在线状态）、编辑、指令、转发、设备密钥、`/ws` |
| `cards.py`、`licensing.py` | 卡密状态机（未使用 → 已激活 → 过期 / 解绑 / 停用）、激活时用条件更新防止两台设备同时抢一张卡、ECDSA 签名与验签（与 `LicenseToken.kt` 同一格式） |
| `packer.py` | 打包队列：一次一个 Gradle 构建，安全解压工程 zip，子进程调用 `xscript_pack.py`，日志写文件供前端轮询，支持取消（终止进程组）；重启时把中断的任务标为失败、重新排队未开始的任务 |
| `deps.py`、`security.py` | 会话 Cookie / Bearer 令牌（只存 SHA-256）、角色检查、CSRF 请求头、scrypt 密码、登录限流 |
| `audit.py` | 操作日志和少量键值设置 |

数据全部在一个数据目录里：SQLite（WAL）、卡密私钥、打包产物。设备在线状态只在内存里，重启后设备会自动重连。阻塞的数据库操作放在线程池里执行，不阻塞 WebSocket 事件循环。

### 6.4 存根与校验

- `scripts/gen_stubs.py`：用 `ast` 从 `android/python-runtime/` 生成 `.pyi`，保留签名、docstring 和常量，去掉函数体和私有成员；`--check` 用于检查存根是否过期。
- `scripts/mock_device.py`：按 `openapi.yaml` 实现的进程内 HTTP mock。
- `scripts/vertical_slice.py`：端到端走一遍 status → tree → upload → run → logs → screenshot，可以对 mock 或真机运行。
- `scripts/verify.sh`：运行时单测（`.venv-rt`，含 numpy / opencv）→ 后台单测 → MCP 单测（`.venv`）→ 存根检查 → 插件编译和单测（装过 `node_modules` 时）→ mock 端到端 → 检查 APK 是否存在。
- `android/build.sh`：定位 JDK、Android SDK 和 Python 3.10（可借助 `uv python find 3.10`），然后执行 Gradle 构建。Chaquopy 要求构建机 Python 的次版本号与内嵌解释器一致。

## 7. 关键设计取舍

| 设计 | 收益 | 代价 |
| --- | --- | --- |
| 脚本独立进程，停止即杀进程 | 停止可靠；脚本崩溃不影响无障碍和截图 | 每次运行都要冷启动 Python 并重新加载 numpy / cv2；跨进程调用有 Binder 开销 |
| eval 独立常驻进程，超时即杀 | eval 的死循环 / 崩溃不影响主进程；热调用快 | 多一个进程的常驻内存；超时后 eval 里的模块状态丢失 |
| 无鉴权 + 无 CORS | PC 端无需任何配置即可连接；浏览器网页无法读取接口响应 | 同一网络内任何设备都能上传文件、执行任意 Python |
| `ApiRouter` 与传输层解耦 | 局域网 HTTP 与云控接口完全一致 | 云控的 body 走 base64，大文件（截图、zip）体积增加约 33% |
| Python 侧做节点匹配 | 选择器逻辑可以在 PC 上单测，Java 侧只负责 dump | 每次 `find` 都要序列化并传输整棵树，复杂页面开销较大 |
| 原始 RGBA 帧 + Pipe | 截图不做 PNG 编解码，避开 Binder 限制 | 单帧体积大（1080×2400 约 10 MB），每次截图都要完整拷贝 |
| 通道自动降级（无障碍 → root） | 适配无 root / 无无障碍 / 模拟器等多种环境 | 多点手势在 root 下只能近似回放；常驻 `su` 会话串行执行命令 |
| 用文件做跨进程状态（RunState / LogBuffer） | 实现简单，进程被杀后状态仍然存在 | 每条日志都要打开文件、加锁、读写 seq 文件 |
| 推理引擎只搬张量，前后处理在 Python | YOLO / PaddleOCR 逻辑能在 PC 上对着真实模型测试；换模型结构只改 Python | 每次推理要拷贝输入张量；大输出需要设备端归约（argmax） |
| 运行时 pip 自己实现、只装 wheel | 不依赖 pip 的子进程和编译环境，行为可测；APK 自带包不会被替换 | 只有源码包的项目装不了；依赖解析是简化版（取满足条件的最新版本，不回溯） |
| 打包复用同一份 Gradle 工程 | 打包出的 App 与开发版运行时完全一致，功能改进自动带上 | 每次打包都是一次完整的 Android 构建，需要 SDK 和 Python 3.10 |
| 卡密用非对称签名 + 本地验签 | 离线可用，App 里没有能签发授权的秘密 | 本地校验可被改包绕过；停用依赖联网复核 |

## 8. 风险与后续方向

以下问题已经处理：CORS、eval 隔离与超时、大请求 / 大文件的内存占用、root 命令延迟、日志轮询成本、OCR 识别输出的传输开销（见第 4、5 节）。仍然存在的风险与可做的改进：

1. **局域网接口无鉴权**。同一网络内任何能访问端口的设备都可以上传文件、执行任意 Python（`/eval`、`/projects/<name>/run`）。只在可信网络中使用，或者通过 USB + `adb forward` 连接。打包出来的 App 默认不开这个端口。
2. **云控依赖服务端鉴权**。设备侧只负责外连，安全性取决于服务端的 token 和 TLS。云控的大文件会整块读进内存再 base64（体积增加约 33%），可以考虑分片传输。
3. **卡密是客户端校验**。能拦住普通的复制和分享，拦不住修改 APK 的人。价值高的逻辑应放在服务端。私钥泄露后所有令牌都可以伪造，只能换密钥重新打包。
4. **APK 体积**。ONNX Runtime 每个 ABI 约 18–22 MB。开发版带 arm64 和 x86_64 两个 ABI，约 155 MB；打包时用 `--abis arm64-v8a` 约 77 MB。
5. **运行时 pip 的覆盖面**。只能安装纯 Python wheel 和 Chaquopy 索引里的原生包（约 140 个），只有源码包的项目无法在手机上构建。
6. **依赖版本偏旧**。`opencv-python 4.5.1.48`、`numpy 1.23.3` 受 Chaquopy / Python 3.10 的 wheel 约束，升级 Python 版本前需要先确认 Chaquopy 对 OpenCV 的支持情况。
7. **投屏帧率受截图来源限制**。root `screencap` 每帧约 400 ms；未授予 MediaProjection 时投屏只有 2～3 fps。可以考虑 `screenrecord` H.264 流或 scrcpy 协议。
8. **截图和节点树的传输开销**。每帧原始 RGBA 约 8～10 MB，`Selector.find` 每次都要 dump 整棵树。可以做帧缓存 / 区域截图下推，或者把简单的选择器下推到 Java 侧过滤。YOLO / PaddleOCR 每次调用也要完整截一帧。
9. **日志写入**。每条日志都要打开文件、加锁、读写 seq 文件，高频 `print` 时开销明显。可以在 Python 侧按时间窗口批量写入。
