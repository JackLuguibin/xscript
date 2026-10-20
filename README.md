# XScript

[English](README.en.md) | 简体中文

[![CI](https://github.com/JackLuguibin/xscript/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JackLuguibin/xscript/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/JackLuguibin/xscript)](https://github.com/JackLuguibin/xscript/releases/latest) [![License: MIT](https://img.shields.io/github/license/JackLuguibin/xscript)](LICENSE)

**面向 Android 的 Python 自动化开发平台。**

XScript 将设备端 Python 运行时、自动化 API、浏览器开发工具和可自托管的管理后台组合在一起。你可以在电脑上编写脚本，将工程上传到手机或模拟器，执行控件操作、图像识别和设备任务，并通过日志与断点调试定位问题。

项目提供原生 `xscript.android.*` API，以及覆盖部分 AScript 公共接口的 `ascript.android.*` 兼容层。XScript 是独立项目，与 AScript 无隶属关系。

[使用说明](#使用说明) · [可靠性、安全与性能](#可靠性安全与性能) · [快速开始](#快速开始) · [脚本示例](#脚本示例) · [开发与测试](#开发与测试) · [文档](#文档) · [贡献](#贡献)

## 主要功能

- **Android 自动化**：无障碍与 Root 操作通道，支持点击、滑动、多点手势、按键、文字输入、控件选择器和 XPath 查询。
- **图像与视觉识别**：截图、取色、找色、模板匹配、OCR、图片字库与点阵字库（`Ocr.matrix`）、AI 识屏（`screen.ai_find` / `ai_ask`，接任意 OpenAI 兼容视觉模型）、OpenCV 图像处理、GP 图色流水线（含工程自带图色插件），以及基于 ONNX Runtime 的 YOLO 和 PaddleOCR 推理。
- **脚本开发与调试**：浏览器多文件编辑、保存运行、日志、断点（桌面端支持条件断点、命中次数、日志点和监视表达式）、单步、调用栈和变量查看；提供 VS Code / Cursor 扩展、MCP 服务和 Python 类型存根。
- **设备服务**：权限申请、短信只读查询、定位、传感器、事件监听、通知、剪贴板、KeyValue 存储和 HTML/悬浮界面。
- **工程与运行管理**：工程导入导出、运行时安装 Python 依赖、开机运行、定时任务、异常重启控制，以及链接启动（`xscript://`，兼容 AScript 的 `ascript://run?local=…`）。
- **自托管管理后台**：设备分组、批量任务、远程操作、屏幕墙、日志、告警、账号角色和操作审计。
- **应用分发**：脚本版本发布与回滚、独立 APK 打包、签名更新和激活码授权管理。

视觉 AI 客户端支持显式配置自有推理服务；项目不包含视觉大模型服务。YOLO 模型由使用者提供，具体模型与第三方依赖的授权见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 可靠性、安全与性能

**脚本运行更稳**

- 模板匹配的 `confidence` 填 0 或负数不会再让脚本卡死，会自动限制在 0.01–1 之间。
- 等待类接口可以调整轮询间隔：`screen.ocr_wait`、`Selector.find / find_all / exists / wait_gone` 和 `event.loop` 都支持 `interval=`，默认值不变。最后一次等待会在到点前截短，不会超过 `timeout`；计时用单调时钟，系统改时间不影响等待。

**密钥不外泄**

- App 连接云控时把设备密钥放进 `Authorization: Bearer` 请求头，不再拼在地址里，所以服务端和反向代理的访问日志里看不到密钥。旧式 `?token=` 仍然可用，日志里显示为 `token=***`。
- 设备上的云控状态、上报给服务端的设备信息和 `GET /settings` 里的云控地址，都把密钥显示为 `token=***`。
- 已登录的账号修改密码或开关两步验证时，错误次数同样受限：同一账号失败 5 次后锁定 5 分钟，换会话也一样。
- 公共接口的限流在并发请求下准确生效；伪造签名的授权令牌会按 IP 限流。

**后台能撑更多设备**

- 设备状态帧和 `cloud.send()` 数据不再逐条写库，而是每 15 秒合并写一次。控制台看到的在线状态和数据仍然是实时的。
- 概览页的统计更省：卡密用一次查询统计完，崩溃记录在数据库里筛选，页面每 15 秒刷新。分组列表只读需要的字段，运行日志按设备建了索引，导出运行日志改为流式输出，内存占用不随行数增长。
- 定时任务最多 4 个并发执行，慢任务不再拖住同一轮的其他任务。
- 登录校验和接口共用同一个数据库会话，系统设置缓存 5 秒。
- 在线设备超过 SQLite 的参数上限（3 万余台）时，按在线状态筛选和按分组下发仍然可用。

**界面更省资源**

- 网页控制台切到后台标签页后，屏幕墙、日志跟随和打包日志暂停轮询，切回来从断点继续。
- 桌面端屏幕墙等每台设备的上一张截图返回后才请求下一张，失败时退避，窗口隐藏时暂停。
- 桌面端窗口很窄时，局域网连接一行自动换行，不再出现横向滚动条。

**开发与 CI**

- Web 控制台有 vitest + Testing Library 单元测试，CI 和 `scripts/verify.sh` 都会运行；几个大页面拆分成独立组件。
- `verify.sh` 也会检查桌面端；桌面端排版测试使用固定的测试字体，结果不随机器上安装的字体变化。开发需要 Node 22+。
- CI 缓存 npm / pip 依赖；Dependabot 每周提交 GitHub Actions、npm 和 pip 依赖的更新 PR。

完整变化见[更新记录](CHANGELOG.md)。

## 使用说明

不想自己构建时，直接用发布好的安装包，只需要一台 Android 8.0+ 手机或模拟器和一台电脑。

**1. 安装 App**：从 [GitHub Release v0.3.0](https://github.com/JackLuguibin/xscript/releases/tag/v0.3.0) 下载 `xscript-v0.3.0-release.apk`，`adb install` 或拷到手机上点开安装。v0.2.1–v0.2.3 正式版可直接覆盖升级；装过 Debug 版的设备要先卸载（会清除应用数据）。

**2. 授权**：首次打开先允许 **通知**（否则开发服务不会启动），再按需开启 **辅助权限管理**（无障碍，点击和控件操作要用）、**悬浮窗权限**、**图色权限**（截图）。

**3. 在手机上管理和运行小程序**：

| 首页 | 小程序列表 | 小程序详情 |
| :---: | :---: | :---: |
| <img src="docs/images/phone-home.png" width="220" alt="首页：开发者地址、当前小程序和各项权限状态"> | <img src="docs/images/phone-projects.png" width="220" alt="小程序列表：新建、导入"> | <img src="docs/images/phone-project.png" width="220" alt="小程序详情：运行、日志、开机自启、定时任务、文件"> |
| 开发者地址、权限状态，一键运行上次的小程序 | **新建** / **导入**，点进某个小程序 | **运行** / **日志**、开机自启、停止后重新运行、定时任务 |
| **查看代码** | **运行日志** | **定时任务** |
| <img src="docs/images/phone-editor.png" width="220" alt="手机上查看和修改 __init__.py"> | <img src="docs/images/phone-run-log.png" width="220" alt="运行日志：print 输出实时显示，可停止、清空"> | <img src="docs/images/phone-schedule.png" width="220" alt="添加定时任务：每天定时、每隔 N 分钟、只运行一次"> |
| 详情页点文件即可查看和简单修改 | `print` 输出实时显示，可 **停止** / **清空** | 每天定时、每隔 N 分钟、只运行一次 |

**4. 后台悬浮窗**：脚本运行时把 XScript 切到后台，屏幕边上会出现一个悬浮窗（绿点 + 工程名 + 已运行时间），几秒不碰就缩成半透明小球；拖动会带缓动吸附到左右边（避开状态栏和导航条）并记住位置，横竖屏各一份；点一下展开 **停止 / 日志 / 打开 / 隐藏**（图标在上、小字在下，随深浅色换配色）和脚本用 `FloatWindow.add_menu` 加的按钮，不用回到 App 就能停脚本；脚本出错结束时会标红保留几秒。首页 **悬浮窗显示** 可选 运行时显示（默认）/ 后台一直显示 / 已关闭，需要 **悬浮窗权限**，没授权时不显示也不影响运行。回到 App 或脚本结束就收起。

<img src="docs/images/phone-floating.png" width="240" alt="在别的 App 上方显示的悬浮窗：展开后有停止、日志、打开、隐藏四个按钮">

**5. 在电脑上写脚本**：首页 **开发者地址** 就是电脑要访问的地址。同一局域网直接打开 `http://<开发者地址>/tools/`；USB 或模拟器先 `adb forward tcp:19860 tcp:9860`，再打开 `http://127.0.0.1:19860/tools/`，进入 **脚本 IDE**。

![脚本 IDE：左侧目录树，右侧带 Python 高亮的编辑器，下方运行日志](docs/images/ide-overview.png)

- **新建** 工程时可选模板（空工程、Hello、AScript 兼容、签到、找图点击、OCR 读数、悬浮窗 UI，手机 App 的「新建」也一样）；新建文件 / 文件夹：文件路径如 `utils/net.py`，默认放在目录树选中的文件夹里；目录树用法同 VS Code。
- ⌘/Ctrl+S 保存，**保存并运行**（F6）在手机上运行，**停止**（Shift+F6）结束；**保存并调试** 支持断点、单步和变量查看。
- **删除文件**：入口 `__init__.py` 不能删，文件夹要先清空。右上角可切换深色主题。

### VS Code 插件

不想用网页 IDE 时，可以在 VS Code（或 Cursor）里写脚本：从 [GitHub Release](https://github.com/JackLuguibin/xscript/releases/latest) 下载 `xscript-vscode-<版本>.vsix`（版本号和 App 相同，校验值在 `SHA256SUMS`），然后 `code --install-extension xscript-vscode-<版本>.vsix`（v0.2.4 及更早的 Release 没有 vsix，可以先按[插件说明](ide/vscode-extension/README.md)自己打包）。装好后左侧活动栏出现 **XScript** 图标：

![VS Code 插件：左侧是设备、手机上的工程和工具，底部 Output → XScript 实时显示运行日志](docs/images/vscode-run.png)

- **设备**：**扫描设备**（ADB 和局域网）或 **添加设备** 填 App 里的开发者地址；点设备即设为当前设备。
- **运行**：打开 `__init__.py`，按 **Ctrl+Shift+R**（或编辑器右上角 ▶）：只把改动的文件同步到手机并运行，日志实时输出；再按一次先停止再重新运行，**Shift+F6** 停止。`.vscode/.syncignore` 控制哪些文件不上传。
- **新建工程**、从手机 **拉取工程**、截图、ADB 终端、投屏也在这个视图里。

![一键调试：Alt+F6 上传并在手机上启动 debugpy，在断点处停下，查看变量、调用栈，在调试控制台求值](docs/images/vscode-debug.png)

和 AScript 官方扩展的逐项对照、没做的功能见[插件说明](ide/vscode-extension/README.md)。

更多说明（快捷键、错误提示、图色和标注工具、VS Code 插件、管理后台）见[使用手册](docs/使用手册.md)。

## 项目结构

```text
xscript/
├── android/       Android 应用、设备端 Python 运行时与测试
├── backend/       FastAPI 管理服务、React 控制台与 APK 打包工具
├── ide/           VS Code / Cursor 扩展、MCP 服务与类型存根
├── protocol/      设备 HTTP API 的 OpenAPI 契约
├── examples/      自动化、设备服务、图色与调试示例
├── scripts/       验证、存根生成与设备测试脚本
├── deploy/        容器部署配置
└── docs/          使用、接口、架构与部署文档
```

设备端可以独立使用，管理后台按需部署。电脑端工具通过设备 HTTP API 连接应用；云控采用设备主动建立的 WebSocket 连接。

## 环境要求

- **运行设备**：Android 8.0 / API 26 或更高版本的手机或模拟器；4KB 和 16KB 内存页面的设备都支持（16KB 页面设备靠清单里的 `pageSizeCompat` 兼容模式，已在 Android 17 模拟器验证，详见 [功能对照](docs/功能对照.md)）。
- **Android 构建**：JDK 17+、Android SDK Platform 37 与相应 Build Tools、Python 3.10，以及 Bash 环境。Gradle 通过仓库自带 wrapper 执行。
- **可选管理后台**：Python 3.10+；构建 Web 控制台需要 Node.js 与 npm。
- **Python 版本**：管理后台、MCP 服务和构建机统一要求 Python 3.10+，设备上内置的是 Python 3.10（Chaquopy），`ide/python-stubs` 类型存根 3.8 起即可使用。
- **可选 IDE 工具**：MCP 服务需要 Python 3.10+；编辑器扩展需要 VS Code 1.90+ 或兼容的 Cursor。

构建脚本默认尝试使用 Android Studio 自带 JBR，并查找 Python 3.10。可以通过 `JAVA_HOME`、`ANDROID_HOME` 和 `XSCRIPT_BUILD_PYTHON` 指定本机安装路径。其他构建细节见 [Android 开发说明](android/README.md)。

## 快速开始

### 1. 获取源码并构建

```bash
git clone https://github.com/JackLuguibin/xscript.git
cd xscript
./android/build.sh
```

调试 APK 输出到：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

### 2. 安装并启动

确认设备已连接 ADB，然后安装：

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

> 如果设备上装过用其他签名打包的 XScript（例如正式版，或别的电脑打的 Debug 包），`adb install -r` 会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。只能先 `adb uninstall com.xscript.app` 再安装，**卸载会清除应用数据（工程、设置、授权）**，请先导出需要的工程。

在设备上打开 **XScript**，首次安装后先授予通知权限，否则 HTTP 服务不会启动；再根据使用的功能开启无障碍、悬浮窗或截图权限。Root 为可选通道，不是所有功能的前提。短信、定位和通知等功能需要各自的系统授权。

### 3. 连接开发工具

应用首页显示开发者地址。默认端口为 `9860`，被占用时依次尝试至 `9869`，请以设备实际显示为准。

通过 USB 或 Android Studio 模拟器连接时，可以转发端口：

```bash
adb forward tcp:19860 tcp:9860
curl http://127.0.0.1:19860/status
```

如果连接了多个设备，为 ADB 命令增加 `-s <设备序列号>`；如果设备端端口不是 `9860`，相应调整转发目标。

在浏览器打开 `http://127.0.0.1:19860/tools/`，进入脚本 IDE，新建工程，编辑 `__init__.py`，保存并运行。脚本 IDE 的目录树、文件管理和快捷键见[使用手册](docs/使用手册.md#脚本-ide)。

### 4. 运行与调试示例

- [基础自动化](examples/settings_search/__init__.py)：通过控件查找完成操作。
- [断点调试](examples/debug_demo/__init__.py)：设置行断点，观察变量并单步执行。
- [设备服务](examples/device_services/__init__.py)：短信权限、定位与传感器示例。
- [GP 流水线](examples/gp_pipeline/__init__.py)：本地图像处理任务编排。
- [自有视觉服务](examples/as_demo/vlm_custom_service.py)：配置 VLM 客户端。

详细连接排查见[入门指南](docs/GETTING_STARTED.md)，断点与调试生命周期见[调试说明](docs/DEBUGGING.md)。

## 脚本示例

每个工程是一个 Python 包，入口为 `__init__.py`。运行时的工作目录为工程目录。

```python
from xscript.android import node

button = node.Selector().text("搜索").find(timeout=5)
if button:
    button.click()
else:
    print("当前界面未找到搜索控件")
```

工程可以包含 Python 子模块、资源文件和 `requirements.txt`。第三方依赖是否可用取决于其 Python 版本与 Android 平台支持，并非所有桌面 Python 包都能在设备端安装。

迁移 AScript 工程时，可以使用 `ascript.android.*` 兼容入口；部分接口仍存在行为差异或尚未实现，请先阅读[功能对照](docs/功能对照.md)和[兼容实现说明](docs/ASCRIPT_RECONSTRUCTION.md)。

## 可选组件

### 管理后台

在独立 Python 3.10+ 环境中安装并初始化：

```bash
python3.10 -m venv .venv
.venv/bin/python -m pip install -e ./backend
(cd backend/web && npm ci && npm run build)
.venv/bin/python -m xscript_server init --data xscript-data
.venv/bin/python -m xscript_server serve --data xscript-data --port 8765
```

访问 `http://127.0.0.1:8765/`。初始化过程会提示创建管理员账号。容器部署、设备密钥、存储和备份见[后台说明](backend/README.md)。

### 编辑器与 MCP

- [IDE 工具说明](ide/README.md)：安装 VS Code / Cursor 扩展，上传工程并查看日志。
- [MCP 服务说明](ide/mcp-server/README.md)：为支持 MCP 的客户端配置设备访问。
- [类型存根](ide/python-stubs/README.md)：配置 `xscript.*` 与 `ascript.*` 自动补全。

## 开发与测试

Python 后台/MCP 测试和设备端运行时测试使用独立环境：

```bash
# 后台与 MCP
python3.10 -m venv .venv
.venv/bin/python -m pip install -e './backend[test]' -e ./ide/mcp-server

# 设备端 API 的本机测试
python3.10 -m venv .venv-rt
.venv-rt/bin/python -m pip install numpy==1.26.4 opencv-python-headless==4.10.0.84 pillow==10.4.0

# Web 控制台与编辑器扩展（Node 22+，见 .nvmrc）
(cd backend/web && npm ci)
(cd ide/vscode-extension && npm ci)

# 桌面端（可选；没有时 verify.sh 跳过这一步）
python3.10 -m venv .venv-desktop
.venv-desktop/bin/python -m pip install -e './desktop/app[test]'
(cd desktop/frontend && npm ci)

# 仓库检查与 Android JVM 测试
./scripts/verify.sh
./android/build.sh :app:testDebugUnitTest
```

`verify.sh` 覆盖 Python 运行时、后台、MCP、类型存根、网页 IDE、编辑器扩展、桌面端（装了 `.venv-desktop` 时）及 mock 集成流程。完整设备行为需要另外连接手机或模拟器验证。

修改公共 Python API 后重新生成类型存根：

```bash
python3 scripts/gen_stubs.py
python3 scripts/gen_completions.py   # 网页 IDE 的补全索引
```

设备调试回归测试会创建并清理自己的临时工程，执行前应确保没有其他脚本正在运行：

```bash
python3 scripts/device_debug_smoke.py --base http://127.0.0.1:19860
# 截图权限（模拟器上自动点系统授权对话框）和 /screen 缩放检查
scripts/emulator_grant_capture.sh emulator-5554
python3 scripts/device_screen_smoke.py http://127.0.0.1:19860
```

## 当前状态与限制

项目持续开发中。基本 DAP 调试、短信查询和加速度传感器回调已在 ARM64 Android 17 / API 37 模拟器上验证；不同设备、ROM 和权限策略仍可能影响实际行为。

以下能力尚未完整实现：APK 强制更新在 App 内下载后交给系统安装程序，需要用户允许「安装未知应用」，没有静默安装；更新前打的旧包没有服务器地址，需要重新打包一次才会读公告；登录 IP 白名单在反向代理后面需要 `--behind-proxy`；原始 HID 硬件通道和完整 V4 加密脚本运行（自带输入法、外部 APK/JAR 插件加载、BLE 和按次卡已经实现，见[功能对照](docs/功能对照.md)）。网页 IDE 的工程内搜索只做文本匹配（没有替换预览；撤销替换只保留最近一次、一步），截图面板只截取静态一帧；补全和语法检查都是轻量的本地实现：补全覆盖 `xscript.*` / `ascript.*` 和文件内的名字，不做类型推断；语法检查只抓常见的括号、引号、冒号和缩进错误，不能替代运行；没有悬停提示、跳转定义、重构和完整 IDE 的全部调试功能。管理后台的卡密已支持续期叠加、体验卡、多设备卡、滥用告警（统计窗口写入数据库，重启不丢）、App 内续期、按设备黑名单和按次卡（每次启动脚本扣一次）。VS Code / Cursor 扩展已打成 vsix，并在 Cursor 里加载验证（激活、11 条命令、调试类型、快捷键），一键调试以及条件 / 命中次数断点、日志点、修改变量用适配器脚本在两台模拟器上实测通过；但没有用鼠标在编辑器调试界面里点完整一轮（Cursor 无头宿主里不能驱动调试 UI）。具体范围见[功能对照](docs/功能对照.md)。

## 文档

- [使用手册](docs/使用手册.md)：各组件的使用入口。
- [入门指南](docs/GETTING_STARTED.md)：构建、连接设备和常见问题。
- [脚本 API](docs/API.md)：设备端接口。
- [断点调试](docs/DEBUGGING.md)：网页调试与 DAP API。
- [云控协议](docs/CLOUD.md)：设备连接与指令转发。
- [打包与授权](docs/PACKAGING.md)：独立 APK、更新与激活码。
- [发布流程](docs/发布.md)：推 tag 由 GitHub Actions 构建签名 APK 和 VS Code 插件并发布 Release；CI 覆盖范围。
- [技术架构](docs/ARCHITECTURE.md)：模块与运行流程。
- [设备 HTTP 契约](protocol/openapi.yaml)：客户端和设备共用的 API 定义。
- [路线图](docs/路线图.md)：后续规划。
- [更新记录](CHANGELOG.md)：各版本面向用户的变化。

## 贡献

欢迎通过 [Issues](https://github.com/JackLuguibin/xscript/issues) 报告问题、提出建议，或提交 Pull Request。

报告问题时请提供 Android 版本、设备/模拟器型号、复现步骤和相关日志；提交代码时请保持改动范围清晰，补充必要的测试与文档，并通过对应检查。

提交信息采用 Conventional Commits，例如：

```text
feat(vision): add a new image-processing operation
fix(android): handle service disconnection
docs: improve setup instructions
```

## 安全说明

设备开发 HTTP 服务没有鉴权，能够访问端口的客户端可以上传和执行代码。请使用可信网络或 USB/ADB 转发，避免将开发端口直接暴露到公网。打包应用默认关闭开发服务。

自托管后台的公网部署应配置 HTTPS/WSS，并保护设备密钥、管理员凭据和签名私钥。App 通过 `Authorization` 请求头发送设备密钥，状态和设置接口里只显示 `token=***`；自写客户端也请用请求头，不要把密钥放进 URL（见[云控协议](docs/CLOUD.md)）。部署与备份要求见[后台说明](backend/README.md)。报告问题时不要附带这些凭据或个人设备数据。

## 许可证与第三方组件

XScript 以 [MIT 许可证](LICENSE) 开源，Copyright (c) 2026 Jack Lu (JackLuguibin)。第三方组件的许可证和条款分别适用。

依赖信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；随包提供的 debugpy wheel 来源与许可证见 [android/wheels/README.md](android/wheels/README.md)。
