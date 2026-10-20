# XScript 桌面端（Windows 为目标平台）

设计文档：[`docs/桌面端设计.md`](../docs/桌面端设计.md)。本目录实现其 §12.1 路线图：**P0**（验证与脚手架）已完成，**P1**（壳 + 设备 + 工程）大部分已实现，**P2**（流程编辑器）部分已实现，P3–P5 见下面的「没做」。
入口执行方式的实测结论：[`docs/桌面端-入口执行实测.md`](../docs/桌面端-入口执行实测.md)。

> **状态：P0 完成，P1 大部分、P2 部分。只在 macOS 上开发和验证。** 所有 Windows 专属行为（`adb.exe` 定位、`CREATE_NO_WINDOW`、凭据管理器、
> 打包、安装器、高 DPI、杀软/SmartScreen……）**均未验证**，代码和文档里用「⚠ Windows 未验证」标注。
> v0.4.0 起 macOS arm64 的 dmg（ad-hoc 签名、未公证）随 App 一起附在 GitHub Release；Windows 包还没有。桌面端版本号跟随 App（`pyproject.toml` / `package.json` 都是 0.4.0），见设计 §13-14。

## P0 里有什么

| 内容 | 位置 | 验证 |
| --- | --- | --- |
| PySide6 外壳：`QWebEngineView` + 自定义协议 `xsapp://app/`（提供前端、`qwebchannel.js`、设备截图）+ CSP（页面不能自己发网络请求）+ 导航白名单 | `app/xscript_desktop/{main,window,scheme}.py` | macOS ✅ |
| QWebChannel **JSON-RPC 桥**（一个 `Bridge` 对象：`call(json)` 进、`message(json)` 出，请求/应答/事件/取消） | `app/xscript_desktop/{bridge,rpc,runtime,context}.py` | macOS ✅ |
| 设备连接：`adb devices` → `adb forward tcp:<自动端口> tcp:9860` → `GET /status`；局域网/手输 `host:port`；LAN 扫描（9860–9869）；健康轮询；退出时只删自己建的 forward | `app/xscript_desktop/services/` | macOS ✅（单测 + 两台模拟器） |
| React 19 + Vite + TypeScript 前端：设备页（侧边栏导航、设备卡片、状态徽标、截图预览、空/加载/错误状态、浅/深/跟随系统主题、设计令牌、键盘焦点与对比度）；网页里没有 `fetch`/`WebSocket`（有测试守着） | `frontend/` | macOS ✅ |
| 设备如何执行工程入口的实测 + 探针工具 | `docs/桌面端-入口执行实测.md`、`app/tools/entry_probe.py` | 两台模拟器 ✅ |

## P1 已实现的部分（macOS 验证，分支 `feat/desktop-improvements`）

| 功能 | 说明 | 位置 |
| --- | --- | --- |
| **工程页** | 选在线设备 → 工程列表 / 新建 → 文件列表 → 编辑与保存（⌘/Ctrl+S）→ 保存并运行（F6）/ 停止（Shift+F6）→ 按 `seq` 游标跟随 `/logs`（约 1 s 轮询，最多 2000 行）；文件 **新建 / 重命名 / 删除**（入口 `__init__.py` 受保护）；返回 / 主页 / 最近任务 按键 | `frontend/src/components/ProjectsPage.tsx` |
| **Monaco 编辑器** | 本地打包（无 CDN，CSP 下可用），只注册 Python；按需加载（约 4 MB 的独立 chunk）；**补全** 来自 `ide/python-stubs`：`import` / `from … import` / 别名 `x.` / 类成员，带签名与文档。数据重新生成：`python3 frontend/scripts/gen_stub_completions.py`（`--check` 由 pytest 守着）。浏览器演示模式与 jsdom 测试里回退为 `<textarea>` | `frontend/src/editor/`、`components/CodeEditor.tsx` |
| **本地文件夹同步** | 移植 VS Code 插件 `sync.ts`：`.vscode/.syncignore`、跳过点文件 / `__pycache__` / `*.pyc` / 虚拟环境；**增量**＝设备上大小相同 *且* 内容哈希等于上次本机上传的才跳过；分批 `PUT /files`（每批约 2 MB，推送 `sync.progress`）；全量上传；拉取到本地（只写新增/变化，本地多出的不动）。哈希在应用数据库的 `sync_cache` 表（设计 §14.5）；若数据目录里还有旧的 `sync-cache.json`，启动时导入一次。文件夹必须含 `__init__.py` 或 `build.as`，上限 5000 个文件 / 200 MB。原生「选择文件夹」对话框 | `app/xscript_desktop/services/sync.py`、`store.py`、`dialogs.py`、`frontend/src/components/SyncPanel.tsx` |
| **屏幕（投屏 + 操控）** | 每台设备只开一条 `GET /screen/stream`（MJPEG，默认 fps=12、scale=0.5、quality=60），扇出给订阅者。最新一帧放内存，页面用 `xsapp://app/_frame/<id>?seq=N` 取（事件 `mirror.frame`，加载中到达的帧丢掉）。开流前先看 `/status.capture`，未授权绝不开流。429 时改轮询 `GET /screen`（约 2 fps，max=480）并按 0.5–8 秒退避重试（每次不早于关闭后 1.5 秒），成功后回到流。3 秒无帧则主动断开且不自动重试。最后一个订阅者离开、断开设备或退出时立刻关闭上游。点按/长按/滑动与按键、文字仍走 `device.action`。设备卡片上的单张截图仍走 `/_shot/`，不占观看槽 | `app/xscript_desktop/services/mirror.py`、`frontend/src/components/MirrorPage.tsx` |
| **断点调试** | 移植 VS Code 插件 `dap.ts`：Python 侧 `DebugSession` 当 DAP 客户端（页面不能联网），经 `POST /projects/{name}/debug` → `/debug/connect`（409 时重试）→ `/debug/request` + `/debug/messages?since=` 轮询驱动设备上的 debugpy；握手顺序 initialize → attach（不等响应）→ `initialized` → setBreakpoints → setExceptionBreakpoints(uncaught) → configurationDone。Monaco **装订线断点**（点行号左侧或 F9），暂停行高亮并自动打开对应文件；工具栏 调试/继续（F5）、单步跳过（F10）、进入（F11）、跳出（Shift+F11）、暂停、分离、停止（Shift+F5）；**调用栈**（工程外的帧会标出来）、**变量**（Locals 自动展开，Globals 与子对象按需展开）、在栈帧上**求值**、调试控制台。停止时先发 DAP `disconnect(terminateDebuggee=false)` 再关通道，然后只停自己启动的脚本（设备忙时报 409「已在运行」，不会停别人的脚本）；会话中切换断点会立即下发 | `app/xscript_desktop/services/debugger.py`、`frontend/src/components/DebugPanel.tsx` |
| **中 / 英界面** | 侧栏底部切换，记住选择，设置 `<html lang>`；两套词典键由类型和测试保证一致 | `frontend/src/strings.ts`、`src/i18n.ts` |
| **已保存设备** | SQLite `desktop.db`（WAL，专用线程）。连接成功后记住设备；**不保存 adb 自动分配的本地端口**，下次按序列号重新 `forward`。断开后卡片留在列表里显示离线，忘记才删除。可改名称、分组、备注，以及「自动重连」：第一次连上的设备默认勾上，打开窗口时并行重连，ADB 设备重新插上（或刚授权）时也会自动连接；设备页顶部「自动重连设备」是全局开关（设计 §14.5）。数据库损坏会改名后重建并提示；来自更新版本则只读。不写密钥 | `app/xscript_desktop/services/store.py`、`frontend/src/components/DevicePage.tsx` |
| **全局快捷键** | `⌘/Ctrl+K` 命令面板；`⌘/Ctrl+1…5` 切换设备/屏幕/工程/设备墙/流程；设备页 `⌘/Ctrl+R` 与 `F5` 刷新 ADB（其它页的 `F5` 仍留给调试）；`⌘/Ctrl+L` 聚焦地址；`⌘/Ctrl+B` 侧栏只留图标（流程页里改为显示/隐藏节点库）；`⌘/Ctrl+Shift+T` 循环主题；`⌘/Ctrl+,` 打开设置（语言、主题、adb 路径、凭据、单键快捷键、图标侧栏）；`?` 快捷键帮助，可在设置里关闭（WCAG 2.1.4）。`Esc` 关闭浮层并归还焦点。输入框里 `?` 不触发。macOS 上修饰键是 `⌘` | `frontend/src/shortcuts.ts`、`components/GlobalShortcuts.tsx` |
| **凭据** | 设置里按名称保存环境变量、后台地址、设备配对槽。值只进系统凭据库（`keyring`；Windows 凭据管理器 ⚠ 未在 Windows 上验证）。保存后界面不再显示值，RPC 应答也不带回值。名称记在数据目录的 `slot-index.json`，**不进** SQLite | `services/secrets.py`、`components/CredentialsForm.tsx` |
| **设备工具页** | 图色 / 标注 / 投屏网页 / 工具首页在**独立窗口、独立 profile** 里打开设备自己的 `/tools/`。没有桥，所以那个页面调不了桌面 RPC。请求只允许这台设备的地址；点外部链接交给系统浏览器。页面传入的 URL 一律忽略 | `tools_view.py`、`services/tool_pages.py` |
| **控件树 / 取色 / 截图** | 屏幕页可切换操控、选控件、取色。选控件读 `GET /ui-tree`，点画面或点树里的一行，高亮并复制 `Selector()` 片段和 XPath。取色先 `POST /tools/snapshots` 再 `POST /tools/vision`（`op=pixel`）。保存截图由系统对话框选路径，页面不能指定路径。「放到流程画布」把选中的控件变成流程里的「查找 → 找到就点击」（有文本用查找控件节点，没有文本用带完整 Selector 的代码节点），接在主流程末尾 | `components/ScreenTools.tsx`、`ui-tree.ts` |
| **设备墙** | 每台设备一张 `/_shot/` 缩略图（约 2 秒刷新），**不开** `/screen/stream`，所以不占两个观看槽。勾选后按键广播；在一张图上点击，把同一相对位置发给所有勾选的在线设备（没勾选时只发给被点的那台） | `components/WallPage.tsx` |
| **流程编辑器（P2 部分）** | 蓝图式画布与文本 DSL（`*.xflow`）是同一张图，改一边另一边跟着变；节点库（搜索、分类、自定义函数/节点；树形键盘导航，搜索框回车添加第一个结果）、检查器（常规 / 输入 / 输出 / 代码 / 缓存分组可折叠，数字字段就地校验；⌘⇧I / Ctrl+Shift+I 收起，≤1100 px 时没有选中就自动收起）、变量面板（变量 / 环境 / 工程参数 / 局部 / 循环变量，可拖到画布）；撤销重做、注释框、便签、折叠、进入子图、复制粘贴；问题面板与接线检查。**本地调试**：运行 / 单步 / 断点，按 trace 回放到画布。**试跑节点**：设备类节点经 `device.eval` 发到当前设备执行，其它节点在本地模拟。**在设备上运行**：编译成带 `__xf_trace` 的 Python，写进与流程同名的工程（`flows/<name>.py`、`.xflow`、`.xflow.map.json`、`.xflow.layout.json` 和入口 `__init__.py`），然后运行并跟随日志；设备上的 traceback 按部署时的 source map 反查到节点，画布标红，「问题」页签写出节点、行号和异常；工程里已有别人写的 `__init__.py` 时拒绝覆盖。窗口 ≤1280px 时节点库默认收起，打开时自动取景 | `frontend/src/components/FlowPage.tsx`、`src/flow/*`（`dsl.ts` 解析/打印/编译，`session.ts` 调试会话，`deploy.ts` 部署） |

新增 RPC：`project.list|create|files|read|write|deleteFile|move|run|stop`、`device.logs`、`device.action`（仅 `click|swipe|input|key`）、`device.eval`（流程试跑：一段代码发到设备 `POST /eval`，64 KB 以内，超时 200–15000 ms）、`device.update|forget`、`device.uiTree`、`device.pixel`、`device.saveScreenshot`、`sync.preview|upload|pull`、`app.pickDirectory`、`app.copyText`、`app.setUnsaved`（页面报告编辑器是否有未保存修改；有则关窗前先确认）、`secret.list|set|delete|has`、`tools.open`、`debug.start|status|setBreakpoints|step|scopes|variables|evaluate|stop`、`mirror.subscribe|unsubscribe|retry`；事件 `sync.progress`、`debug.state`、`debug.output`、`mirror.frame`、`mirror.state`。`device.list` 含已保存但未连接的设备（状态「离线」）。所有路径参数按设备同样的规则校验（相对、无 `..` / `.` / 空段 / 反斜杠）。`secret.set` 的值不会出现在应答里。

断点列表里每个断点可点 ✎ 设置**条件**（为真才停）、**命中次数**（如 `3`、`>= 3`、`% 2`）或**日志消息**（日志点：不暂停，`{表达式}` 求值后打印到调试控制台）；编辑器行号旁条件断点是带环的红点，日志点是蓝色菱形。**监视**区添加的表达式按工程保存，每次暂停时在选中的栈帧求值（DAP `evaluate` 的 `watch` 上下文）。这几项已用 `scripts/device_desktop_debug_e2e.py`（直接驱动 `DebugSession`）在 arm64 模拟器的真实 debugpy 上验证（条件 `i == 3` 停在 i=3、会话中改成命中次数 2 停在 i=5、日志点逐次输出、监视求值）；实测发现 debugpy 的日志点输出是 `category: stdout` 加空的 `source: {}`，以前被当成脚本输出的重复而丢掉，已修复。

调试的限制：每台设备一个会话；多线程切换还没做。测试用的是 `app/tests/fake_debug_device.py` 里脚本化的 debugpy（`scripts/mock_device.py` 不支持 `/debug/*`）；设备上的真实 debugpy 用上面的脚本验证过；桌面窗口里的完整点击流程只在 fake 设备上做了 e2e。

**没做**：trace 节流的真机预算核对（设计 §14.7；编译器已按 200 行突发 / 每秒 500 行生成 `__xf_trace`，还没在真机上测）；流程编辑器的剩余部分：状态机回退（有回边或汇合的图）里，被整体内联的容器（match / sequence / try / parallel / wait_until / retry 和封闭的循环）分支不能跳出容器，也不能 `break` / `continue` 外层被拆成状态的循环（会报错并指出节点）（React Flow 在 Qt 里的验证见 [`docs/桌面端-ReactFlow验证.md`](../docs/桌面端-ReactFlow验证.md)；语义 JSON 的 schema 在 `desktop/schema/`）、云控与后台（P4）、打包与安装器（P5）、`pyside6-deploy` 与 PyInstaller 对比。镜像流的方案 A（scheme 直接吐 multipart）没做，方案 B 已实现；本轮没有对真机开流。Windows 凭据管理器只按 `keyring` 的接口接上，没有在 Windows 上读写过。设计和 Mac 上能做的验证不等 Windows。

**设备页美化前 → 后**（macOS 真实外壳，经 adb forward 连接 5554 模拟器；设计细节见设计文档 §14.15）：

| 美化前（P0） | 美化后 · 浅色 |
| --- | --- |
| ![美化前](../docs/images/desktop-before.png) | ![美化后浅色](../docs/images/desktop-after-light.png) |

| 美化后 · 深色 | 窄窗口（图标栏 + 叠放） |
| --- | --- |
| ![美化后深色](../docs/images/desktop-after-dark.png) | ![窄窗口](../docs/images/desktop-after-narrow-dark.png) |

重新生成：`python -m xscript_desktop --screenshot out.png --connect-adb emulator-5554 --click-screenshot --theme dark --size 1180x760`（`--theme` 会真的去按侧栏的主题按钮）。

## 目录

```text
desktop/
  app/        Python 包 xscript_desktop（PySide6 外壳 + 服务层 + 桥）
    xscript_desktop/   main.py（入口）、window.py、scheme.py、bridge.py、rpc.py、context.py、runtime.py、services/
    tests/             pytest：单元、Qt 集成（offscreen）、真机（需 XSCRIPT_DEVICE_TESTS=1）
    tools/entry_probe.py
  frontend/   React + Vite + TS；构建产物写进 app/xscript_desktop/resources/app/（已 .gitignore）
```

## 运行（macOS / Linux 开发）

需要：Python ≥ 3.10、Node ≥ 22、`adb`（Android platform-tools；找法见下）。

```bash
# 1) 前端
cd desktop/frontend && npm ci && npm run build          # 产物 -> desktop/app/xscript_desktop/resources/app/

# 2) Python 外壳
cd ../app && python3.10 -m venv .venv && .venv/bin/pip install -e '.[test]'
.venv/bin/python -m xscript_desktop                      # 打开窗口
.venv/bin/python -m xscript_desktop --selftest           # 无头自检：加载前端、桥往返一次，退出码 0/1
.venv/bin/python -m xscript_desktop --selftest --connect-adb emulator-5554   # 并连上设备、打印设备信息
```

打包成 macOS 应用：`app/packaging/build_macos_app.sh` → `app/dist/XScript.app`（PyInstaller，自带 `.icns` 图标，Dock/菜单栏显示 XScript；`dist/XScript.app/Contents/MacOS/XScript --selftest` 可无头自检）。脚本最后会重新做 ad-hoc 签名并用 `app/packaging/verify_macos_app.sh` 校验（`codesign --verify --deep --strict`、Info.plist 已绑定、arm64）；签名之后不能再改动 bundle 里的任何文件，否则下载后的应用会被 macOS 报“已损坏”。`app/packaging/build_macos_dmg.sh` 打包成 `app/dist/xscript-desktop-vX.Y.Z-macos-arm64.dmg`，并在 dmg 内再校验一次；发布时由 release 工作流在 macOS 运行器上构建并附到 Release（`app/packaging/release-notes-macos.md` 是首次打开说明）。

`adb` 的查找顺序：`--adb` 参数 → `XSCRIPT_ADB` → `ANDROID_SDK_ROOT`/`ANDROID_HOME` → `PATH` → 各系统默认目录（macOS `~/Library/Android/sdk`；Windows `%LOCALAPPDATA%\XScript\platform-tools`、`%LOCALAPPDATA%\Android\Sdk`，⚠ Windows 未验证）。

前端热更新开发：`cd frontend && npm run dev`，再 `python -m xscript_desktop --dev-url http://localhost:5173`（外壳会把 `qwebchannel.js` 注入页面）。
直接用浏览器打开 `http://localhost:5173` 是「演示模式」（假数据，不连设备）。

## 测试

完整方案与用例编号表：[`docs/桌面端-测试方案.md`](../docs/桌面端-测试方案.md)（分层：单元 / 集成 / 前端组件 / 真实外壳 e2e / 安全 / 视觉回归 / 性能 / Windows 逻辑模拟 / 真机）。

```bash
cd desktop/app && .venv/bin/python -m pytest -q                                   # 433 个通过、5 个真机用例默认跳过（macOS，约 2 min；含 10 张视觉回归与工程页/投屏 e2e）
cd desktop/app && .venv/bin/python -m pytest -q --cov --cov-report=term-missing   # 覆盖率 96%（含子进程里的 --selftest/--screenshot）
cd desktop/app && XSCRIPT_DEVICE_TESTS=1 .venv/bin/python -m pytest -m device -v  # 真机/模拟器（只读 + adb forward；5554 与 5556 已通过）
cd desktop/frontend && npm run typecheck && npm run test:coverage                  # tsc + vitest（216 个，含对比度/令牌检查）
python desktop/app/tools/gen_test_matrix.py --check                                # 测试方案里的编号表没有过期
```

e2e 用例要先 `npm run build`（否则自动跳过）。视觉回归的基线按平台存放（`app/tests/baselines/darwin/`，只有 macOS 的；Linux CI 与 Windows 没有基线所以跳过）；`XSCRIPT_UPDATE_BASELINES=1 pytest -m visual` 重新生成。

## 设备连接的约定

- **ADB**：每台设备建自己的 forward，本地端口由 adb 自动分配（`forward tcp:0 tcp:9860`），**不占用 19860 之类的固定端口**，所以不会与 VS Code 扩展 / 其它工具抢端口。只删除本进程创建的 forward，别人的不动。要用固定端口，可以先自己 `adb forward tcp:19860 tcp:9860`，再在「局域网/手动地址」里填 `localhost:19860`。
- **配对码**：设备 API 默认需要配对码。ADB 连接经 `adb forward tcp:0 localabstract:xscript-pair.<包名>` 自动读取（只有 adb 守护进程能读到，不用 `adb shell`）；局域网连接在设备卡片上输入一次，保存在系统钥匙串（凭据槽 `device/<设备 id>`）。手机上重新生成配对码后，卡片会变成「待配对」。
- **局域网**：手机关闭了配对（或 App 版本较旧）时，非回环地址会显示警告；优先用 ADB。
- 页面 → Python 的所有请求都走桥；截图这种二进制走 `xsapp://app/_shot/<设备id>.jpg`，不走 JSON。
- 本阶段**不会**对设备做 `adb install` / `uninstall` / `pm clear`（`AdbService` 里没有这些封装）。
