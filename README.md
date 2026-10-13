# XScript

XScript 是一款仿照 AScript 的 Android Python 自动化 App：在手机上运行 Python 脚本，AScript 的脚本不用改就能跑。在电脑上写脚本（VS Code / Cursor，或者通过 MCP 让 Cursor 的 AI 来写），推送到手机，在手机上运行。

```
ide/      VS Code 插件 / MCP / 浏览器  →  HTTP :9860  →  android/ XScript App  →  无障碍 / Root + Python 3.10 + ONNX Runtime
backend/  管理后台（FastAPI + React）   ←  WebSocket（设备主动连接） ↗
          云控 · 卡密 · APK 打包 · 小程序 · 用户 · 操作日志
```

## 功能

- **首页**：仿照 AScript，包括开发者地址、AI 编程连接、运行模式、悬浮窗权限、Root 权限、图色权限、云端控制、小程序列表、辅助权限管理、开发者选项。
- **运行模式**：`auto`、`accessibility`（无障碍）或 `root`。手势、控件树和截图在没有无障碍权限时都会退回 Root；无障碍截到黑屏时截图也会退回 Root。
- **脚本 API**（`xscript.android.*`）：
  - `action`：手势、按键和文字输入。
  - `node`：带层级关系的控件选择器，以及 XPath 1.0 查询（`contains()`、轴、`[last()]`、并集）。
  - `screen`：多点找色、带遮罩的多尺度找图、ML Kit OCR。
  - `system`：应用、shell、设备信息、KeyValue、R 路径。
  - `ui`：对话框、带 JS 桥的 HTML 窗口、画布、悬浮停止按钮。
  - `event`：监听实体按键、控件点击、通知（可 `send()`）、Toast 和原始无障碍事件。
- **无人值守运行**：开机自启、停止后重新运行（脚本退出或崩溃后重启，带防崩溃循环保护）、定时任务（每天 / 每隔 N 分钟 / 一次）。可以在工程页面、脚本里（`system.Config`、`system.Schedule`）、通过 HTTP 或 MCP 设置。
- **设备端 AI 识别**：YOLO v5 / v8 / v11 目标检测（`xscript.android.yolo`）和 PaddleOCR PP-OCRv5（`screen.ocr(engine="paddle")`）运行在 ONNX Runtime 上。在标注工具里标注截图，用 Ultralytics 训练，导出 ONNX 后在手机上运行。AScript 的 `YoLov5`、`plug.load("Yolov8Ncnn")` 和 `Ocr.paddleocr` 都映射到这两个引擎。
- **运行时 pip**：工程里放 `requirements.txt`，第一次运行前自动安装，不用重新打包 APK。纯 Python 包来自 PyPI；带 C 扩展的包（pandas、scipy、lxml、cryptography 等）来自 Chaquopy 的 Android 索引。
- **AScript 兼容**（`ascript.android.*`）：按 ascript-tip 1.3.0 的 API 实现，`from ascript.android.screen import FindImages` 这类代码不用改。与 AScript 的逐项对照见 [docs/功能对照.md](docs/功能对照.md)。
- **工程管理**：新建、zip 导入导出、从 AScript 导入（`/sdcard/airscript/model`）、手机端编辑器、运行日志、悬浮停止按钮。
- **云控**：设备主动连接 WebSocket 服务器，所以在 NAT 后面也能用。
  - 支持 AScript 的指令集：带参数的 `app_run`、`app_stop`、`device_info`、`screen_shot`、`device_action`。
  - 设备的全部 HTTP 接口都可以通过同一条连接转发。
  - 脚本可以上报数据、接收消息（`cloud.send` / `on_message`、`cloud_control`、`system.channel`）。
  - 管理后台（`backend/`，FastAPI + React / Ant Design）提供带角色的账号、按渠道发放的设备密钥、分组、批量指令、远程操控和屏幕墙、运行日志和崩溃上报、服务端定时任务、告警通知、备份和操作日志。见 [backend/README.md](backend/README.md) 和 [docs/CLOUD.md](docs/CLOUD.md)。
- **小程序发布**：在管理后台上传工程版本、发布和回滚，一键下发到云控设备；打包的 App 可以开启热更新自动跟随发布版本。
- **APK 打包和卡密**：管理后台在后台队列里把工程 zip 或小程序版本打包成 APK（也可以直接运行 `backend/xscript_pack.py`）。每个 App 有自己的包名、名称、图标，可选正式签名、代码保护（只打包字节码）和热更新。打包的 App 可以要求卡密授权：卡密是绑定设备的 ECDSA 签名令牌。卡密在管理后台按批次生成、在线激活，可以停用、解绑、延期、导出，也可以签发离线授权码。打包好的 APK 可以生成带二维码的下载链接分发给用户。见 [docs/PACKAGING.md](docs/PACKAGING.md)。
- **VS Code / Cursor 插件**（`ide/vscode-extension`）：F6 保存、上传并运行当前工程，同时跟随日志；Shift+F6 停止。还能在设备上运行选中的代码、打开截图和网页工具，并自带 API 补全存根。见 [ide/README.md](ide/README.md)。
- **Cursor MCP**（`xscript-mcp`）：截图、控件树、上传文件、运行 / 停止、日志、eval、运行选项、定时任务和 API 目录。eval 在独立进程里执行，超时会被杀掉。
- **浏览器开发工具**：App 内置，地址 `http://<ip>:<port>/tools/`。
  - **图色工具**：冻结一张截图，用放大镜取色，生成多点找色字符串，框选区域，把找图模板裁剪保存到工程里，并在这一帧上测试找色 / 比色 / 找图 / OCR。
  - **标注工具**：把截图或上传的图片加入数据集，画框标注，导出 YOLO 训练集（`images/`、`labels/`、`data.yaml`）。
  - **投屏**：实时 MJPEG 画面。点击画面就是点击手机，拖动就是滑动，另有 返回 / 主页 / 最近任务 按钮。

## 仓库结构

仓库分三部分，另外加上它们共用的接口契约和开发脚本。

| 部分 | 路径 | 内容 |
| --- | --- | --- |
| **Android App** | [`android/`](android/README.md) | `app/` Kotlin App（HTTP 服务、云控客户端、卡密校验、无障碍 / Root 引擎、截图、OCR、悬浮窗、网页工具、热更新），`python-runtime/` 设备端的 `xscript` 和 `ascript` 包及其电脑端测试，`build.sh` |
| **管理后台（云控 / 打包 / 授权）** | [`backend/`](backend/README.md) | `xscript_server/` FastAPI 服务，`web/` React + Ant Design 控制台，`xscript_pack.py` APK 打包命令行，`tests/` |
| **IDE 工具** | [`ide/`](ide/README.md) | `vscode-extension/` VS Code / Cursor 插件，`mcp-server/` Cursor MCP（`xscript-mcp`），`python-stubs/` 生成的 `.pyi` 补全存根 |
| 共用 | `protocol/openapi.yaml` | 设备 HTTP 接口契约：App 实现，IDE 工具和云控转发使用 |
| 共用 | `scripts/` | `verify.sh`（运行全部测试）、`gen_stubs.py`、`mock_device.py`、`vertical_slice.py` |
| 共用 | `examples/` | `settings_search`、`xs_smoke`（原生 API）、`as_demo`（AScript API） |
| 共用 | `docs/` | [使用手册（各系统入口）](docs/使用手册.md)、[功能对照（与 AScript）](docs/功能对照.md)、[路线图](docs/路线图.md)、[商业化设计](docs/商业化设计.md)、[入门](docs/GETTING_STARTED.md)、[脚本 API](docs/API.md)、[云控](docs/CLOUD.md)、[打包与卡密](docs/PACKAGING.md)、[AI 编程规则](docs/AGENT_RULES.md)、[技术架构](docs/ARCHITECTURE.md) |

## 快速开始

```bash
./android/build.sh            # needs Android SDK, JDK 17+, and Python 3.10 on the build machine
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

在手机上打开 **XScript**，授予无障碍、悬浮窗权限，有 Root 的话也授予 Root。**开发者地址** 一行显示 `http://<ip>:<port>/`。端口是 9860（AScript 用 9096，两个 App 可以同时运行）；9860 被占用时会依次尝试到 9869。

```bash
adb connect 127.0.0.1:16384            # MuMu emulator only
adb forward tcp:9860 tcp:9860          # use the port shown in the app; add -s <serial> with several devices
curl http://127.0.0.1:9860/status
```

模拟器或 adb 重启后端口转发会失效，需要重新执行这两条 adb 命令。连接问题的排查见 [连接设备](docs/GETTING_STARTED.md)，MCP 配置、模拟器说明（MuMu）和测试命令见 [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)。

## 脚本结构

入口文件是 `__init__.py`。工程目录作为一个包被导入，工作目录就是工程目录。

```python
from xscript.android import action, node, screen

n = node.Selector().text("搜索").find(timeout=5)
if n:
    n.click()
hit = screen.find_image("res/img/ok.png", confidence=0.85)
if hit:
    action.click(*hit["result"])
```

现有的 AScript 工程可以直接运行：

```python
from ascript.android.screen import FindColors, Ocr
from ascript.android import action
p = FindColors.find("#ff4400|12,0,#ffffff")
if p:
    action.click(p.x, p.y)
```

## 安全

局域网 HTTP 服务**没有鉴权**。任何能访问这个端口的人都可以上传文件、执行任意 Python（`/eval`、`/projects/<name>/run`）。只在可信网络里使用 XScript，或者通过 USB 加 `adb forward` 使用。服务不发送 CORS 头，所以浏览器里打开的网页读不到接口返回的内容。打包的 App 默认关闭局域网服务，除非打包时加了 `--dev-server`。

云控连接只由服务端鉴权，用管理后台发放的设备密钥。在公网使用时，管理后台前面要加 TLS（`wss://`、HTTPS）。拿到设备密钥的人就能控制用这个密钥连接的设备；停用密钥会立即断开这些设备。管理后台本身有带角色的账号、哈希存储的会话和 API 令牌、CSRF 防护和操作日志（见 [backend/README.md](backend/README.md)）。

卡密校验在 App 内进行，能防止普通复制，但防不住修改 APK 的人。

## 许可

- Chaquopy 17 采用 MIT 许可。
- AScript 兼容层和找图策略参考了 ascript-tip（MIT）。
- ML Kit 遵循 Google 的条款。
- 详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。XScript 与 AScript 没有关联。
