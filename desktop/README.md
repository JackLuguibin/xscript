# XScript 桌面端（Windows 为目标平台）

设计文档：[`docs/桌面端设计.md`](../docs/桌面端设计.md)。本目录实现其 §12.1 路线图的 **P0 阶段**（验证与脚手架）。
入口执行方式的实测结论：[`docs/桌面端-入口执行实测.md`](../docs/桌面端-入口执行实测.md)。

> **状态：P0。只在 macOS 上开发和验证。** 所有 Windows 专属行为（`adb.exe` 定位、`CREATE_NO_WINDOW`、凭据管理器、
> 打包、安装器、高 DPI、杀软/SmartScreen……）**均未验证**，代码和文档里用「⚠ Windows 未验证」标注。
> 本阶段没有打 tag、没有发布；桌面端版本号跟随 App（`pyproject.toml` / `package.json` 都是 0.2.6），见设计 §13-14。

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
| **本地文件夹同步** | 移植 VS Code 插件 `sync.ts`：`.vscode/.syncignore`、跳过点文件 / `__pycache__` / `*.pyc` / 虚拟环境；**增量**＝设备上大小相同 *且* 内容哈希等于上次本机上传的才跳过；分批 `PUT /files`（每批约 2 MB，推送 `sync.progress`）；全量上传；拉取到本地（只写新增/变化，本地多出的不动）。哈希缓存在 `<数据目录>/sync-cache.json`。文件夹必须含 `__init__.py` 或 `build.as`，上限 5000 个文件 / 200 MB。原生「选择文件夹」对话框 | `app/xscript_desktop/services/sync.py`、`dialogs.py`、`frontend/src/components/SyncPanel.tsx` |
| **屏幕（投屏 + 操控）** | 连续截图（上一帧加载完才取下一帧，1/2/5/10 fps，设备慢就自动降速），**不占** `/screen/stream` 的 2 个观看者槽位；点按 = click，按住 ≥0.5 s = 长按，拖动 = swipe（按帧/设备尺寸换算坐标，支持横屏帧）；按键与文字输入 | `frontend/src/components/MirrorPage.tsx`、`src/mirror.ts` |
| **中 / 英界面** | 侧栏底部切换，记住选择，设置 `<html lang>`；两套词典键由类型和测试保证一致 | `frontend/src/strings.ts`、`src/i18n.ts` |

新增 RPC：`project.list|create|files|read|write|deleteFile|move|run|stop`、`device.logs`、`device.action`（仅 `click|swipe|input|key`）、`sync.preview|upload|pull`、`app.pickDirectory`；事件 `sync.progress`。所有路径参数按设备同样的规则校验（相对、无 `..` / `.` / 空段 / 反斜杠）。

**断点调试没有做**：协议里已有 `/projects/{name}/debug` 与 `/debug/status|connect|request|messages`（DAP over HTTP 轮询，见 `docs/DEBUGGING.md`），VS Code 插件的 `dap.ts` 可作为移植参考；桌面端尚未接入（需要 Monaco 断点装订线 + 调用栈/变量面板），留作后续。

**没做**：断点调试（见上）、MJPEG 镜像流代理、流程编辑器 / React Flow / DSL / 编译器（P2）、凭据管理器、云控与后台（P4）、打包与安装器（P5）、`pyside6-deploy` 与 PyInstaller 对比。

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

`adb` 的查找顺序：`--adb` 参数 → `XSCRIPT_ADB` → `ANDROID_SDK_ROOT`/`ANDROID_HOME` → `PATH` → 各系统默认目录（macOS `~/Library/Android/sdk`；Windows `%LOCALAPPDATA%\XScript\platform-tools`、`%LOCALAPPDATA%\Android\Sdk`，⚠ Windows 未验证）。

前端热更新开发：`cd frontend && npm run dev`，再 `python -m xscript_desktop --dev-url http://localhost:5173`（外壳会把 `qwebchannel.js` 注入页面）。
直接用浏览器打开 `http://localhost:5173` 是「演示模式」（假数据，不连设备）。

## 测试

完整方案与用例编号表：[`docs/桌面端-测试方案.md`](../docs/桌面端-测试方案.md)（分层：单元 / 集成 / 前端组件 / 真实外壳 e2e / 安全 / 视觉回归 / 性能 / Windows 逻辑模拟 / 真机）。

```bash
cd desktop/app && .venv/bin/python -m pytest -q                                   # 379 个通过、5 个真机用例默认跳过（macOS，约 75 s；含 10 张视觉回归与工程页/投屏 e2e）
cd desktop/app && .venv/bin/python -m pytest -q --cov --cov-report=term-missing   # 覆盖率 96%（含子进程里的 --selftest/--screenshot）
cd desktop/app && XSCRIPT_DEVICE_TESTS=1 .venv/bin/python -m pytest -m device -v  # 真机/模拟器（只读 + adb forward；5554 与 5556 已通过）
cd desktop/frontend && npm run typecheck && npm run test:coverage                  # tsc + vitest（174 个，含 77 项对比度/令牌检查；语句 93% / 分支 82%）
python desktop/app/tools/gen_test_matrix.py --check                                # 测试方案里的编号表没有过期
```

e2e 用例要先 `npm run build`（否则自动跳过）。视觉回归的基线按平台存放（`app/tests/baselines/darwin/`，只有 macOS 的；Linux CI 与 Windows 没有基线所以跳过）；`XSCRIPT_UPDATE_BASELINES=1 pytest -m visual` 重新生成。

## 设备连接的约定

- **ADB**：每台设备建自己的 forward，本地端口由 adb 自动分配（`forward tcp:0 tcp:9860`），**不占用 19860 之类的固定端口**，所以不会与 VS Code 扩展 / 其它工具抢端口。只删除本进程创建的 forward，别人的不动。要用固定端口，可以先自己 `adb forward tcp:19860 tcp:9860`，再在「局域网/手动地址」里填 `localhost:19860`。
- **局域网**：设备 API **没有鉴权**，非回环地址会显示警告；优先用 ADB。
- 页面 → Python 的所有请求都走桥；截图这种二进制走 `xsapp://app/_shot/<设备id>.jpg`，不走 JSON。
- 本阶段**不会**对设备做 `adb install` / `uninstall` / `pm clear`（`AdbService` 里没有这些封装）。
