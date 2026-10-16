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
| React 19 + Vite + TypeScript 前端：设备页（ADB 设备、手动地址、扫描、设备信息、截图）；网页里没有 `fetch`/`WebSocket`（有测试守着） | `frontend/` | macOS ✅ |
| 设备如何执行工程入口的实测 + 探针工具 | `docs/桌面端-入口执行实测.md`、`app/tools/entry_probe.py` | 两台模拟器 ✅ |

**没做（不在 P0 范围）**：流程编辑器 / React Flow / DSL / 编译器（P2）、Monaco 与工程同步（P1）、投屏流（P1）、云控与后台（P4）、打包与安装器（P5）、`pyside6-deploy` 与 PyInstaller 对比。

![P0 设备页：macOS 上经 adb forward 连接 5554 模拟器，显示 /status 信息和截图](../docs/images/desktop-p0.png)

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

```bash
cd desktop/app && .venv/bin/python -m pytest -q                                  # 79 个（3 个真机测试默认跳过）：RPC、adb、设备客户端/管理器、scheme/导航、真 QtWebEngine 集成
cd desktop/app && XSCRIPT_DEVICE_TESTS=1 .venv/bin/python -m pytest -m device -v  # 真机/模拟器（adb + 已安装并启动的 XScript）
cd desktop/frontend && npm run typecheck && npm test                              # tsc + vitest（21 个）
```

## 设备连接的约定

- **ADB**：每台设备建自己的 forward，本地端口由 adb 自动分配（`forward tcp:0 tcp:9860`），**不占用 19860 之类的固定端口**，所以不会与 VS Code 扩展 / 其它工具抢端口。只删除本进程创建的 forward，别人的不动。要用固定端口，可以先自己 `adb forward tcp:19860 tcp:9860`，再在「局域网/手动地址」里填 `localhost:19860`。
- **局域网**：设备 API **没有鉴权**，非回环地址会显示警告；优先用 ADB。
- 页面 → Python 的所有请求都走桥；截图这种二进制走 `xsapp://app/_shot/<设备id>.jpg`，不走 JSON。
- 本阶段**不会**对设备做 `adb install` / `uninstall` / `pm clear`（`AdbService` 里没有这些封装）。
