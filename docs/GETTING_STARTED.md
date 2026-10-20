# 快速上手

## 构建

环境要求：

- Android SDK
- JDK 17+（脚本默认使用 Android Studio 自带的 JBR）
- 构建机上的 **Python 3.10**。Chaquopy 要求次版本号与内置的 3.10 一致。

`android/build.sh` 会查找 `python3.10`，找不到时通过 `uv` 安装。也可以设置 `XSCRIPT_BUILD_PYTHON` 指定。

```bash
./android/build.sh
# output: android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

如果安装时报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE: ... signatures do not match`，说明设备上已有用别的签名打包的 XScript（正式版，或别的电脑打的 Debug 包，Debug 签名默认是每台电脑各自的 `~/.android/debug.keystore`）。只能先卸载：

```bash
adb uninstall com.xscript.app   # 会清除应用数据：工程、设置、授权
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

卸载前请先导出需要的工程（脚本 IDE → **导出 ZIP**，或 `GET /projects/<name>/zip`），重装后重新授予下面的权限。

APK 内置 numpy 1.23.3、opencv 4.5.1.48、pillow 11.0.0、pyyaml、requests 2.33、OkHttp 和 ML Kit 中文 OCR，体积约 100 MB。

## 设备设置

1. 打开 XScript，授予通知权限。**全新安装时必须先授予，HTTP 服务（9860 端口）才会启动**；用 adb 时可执行 `adb shell pm grant com.xscript.app android.permission.POST_NOTIFICATIONS`。
2. **辅助权限管理** → 开启 XScript 无障碍服务。
3. **悬浮窗权限** → 允许。后台悬浮窗（显示运行状态，可停止）、对话框、`ui.Window` 和画布都需要它。
4. **Root 权限** → 设备已 root 时授予 `su`。授予后可使用 root 模式、`system.shell` 和截图兜底。
5. **运行模式** → 选 `Root或激活模式`（自动），除非需要指定某个通道。
6. 保持应用运行。**开发者地址** 会显示 `http://<ip>:<port>/`。

服务绑定 9860 端口，避开 AScript 的 9096，所以两个应用可以同时安装、同时运行。9860 被占用时，会依次尝试后面的空闲端口，最多到 9869。请始终以应用中显示的端口为准。

### 通过 adb 授权

适用于模拟器，或开发期间每次重装之后：

```bash
PKG=com.xscript.app
adb shell settings put secure enabled_accessibility_services $PKG/com.xscript.app.a11y.XscriptAccessibilityService
adb shell settings put secure accessibility_enabled 1
adb shell cmd appops set $PKG SYSTEM_ALERT_WINDOW allow
adb shell am start -n $PKG/com.xscript.app.LauncherActivity
```

`enabled_accessibility_services` 这一行会替换整个列表。如果其他服务需要保持开启，请改为追加。

对于打包后的应用，把 `PKG` 设为它的 `--app-id`。类名仍是 `com.xscript.app.*`，所以命令无需修改。

### MuMu 及其他模拟器

- **连接：** `adb connect 127.0.0.1:16384`（macOS 上的 MuMu 12；`127.0.0.1:5555` 也可以）。然后转发端口，见[端口转发](#端口转发)。
- **无障碍截图全黑：** MuMu 的无障碍截图 API 返回黑帧。XScript 会检测到这种情况，自动切换到 root `screencap`（见 `/status` 中的 `capture_source`）。需要开启 root。
- **没有 `uiautomator`：** MuMu 不自带它，所以即使在 root 模式下，节点树也需要无障碍服务。
- **不受信任的触摸（Android 12+）：** 穿过其他应用不透明度高于 0.8 的全屏覆盖层的点击会被丢弃，包括注入的无障碍点击和 `input` 点击。XScript 自己的覆盖层在限制之内。如果脚本运行时点击失效，检查 `adb logcat | grep "Untrusted touch"`。

## 电脑端设置

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e ide/mcp-server -e ide/python-stubs
```

`ide/python-stubs` 只提供自动补全，同时覆盖 `xscript.*` 和 `ascript.*`。

手写脚本还可以使用 `ide/vscode-extension` 中的 VS Code / Cursor 扩展（F6 上传并运行、实时日志、在设备上运行选中代码、截图、内置 stubs）。见 [ide/README.md](../ide/README.md)。

Cursor MCP 配置。仓库已自带 `.cursor/mcp.json`，指向项目的 venv：

```json
{
  "mcpServers": {
    "xscript": {
      "command": "${workspaceFolder}/.venv/bin/python",
      "args": ["-m", "xscript_mcp"],
      "env": { "XSCRIPT_DEVICE": "127.0.0.1:9860" }
    }
  }
}
```

`command` 必须是 `.venv` 中的 Python。系统自带的 `python3.12` 没有安装 `xscript_mcp`，MCP 服务启动时会报 `No module named 'xscript_mcp'` 并退出。如果使用全局的 `~/.cursor/mcp.json`，请用 `.venv/bin/python` 的绝对路径代替 `${workspaceFolder}`。

修改 `mcp.json` 后，在 Cursor 的 MCP 设置中把 xscript 服务关掉再打开，或者重启 Cursor。

## 连接设备

通过 Wi-Fi 连接时，按 **开发者地址** 中显示的地址设置 `XSCRIPT_DEVICE=<phone-ip>:<port>`。通过 USB 或在模拟器上，用 adb 转发端口。

### 端口转发

```bash
# 仅模拟器：先让 adb 连接 MuMu（如何查找端口见下文）。
adb connect 127.0.0.1:16384

# 把本机 9860 转发到应用的 9860。列出多台设备时使用 -s。
adb -s 127.0.0.1:16384 forward tcp:9860 tcp:9860

# 检查。
adb forward --list
curl http://127.0.0.1:9860/status
```

`/status` 返回设备 JSON，说明转发成功。如果端口不是 9860，请使用应用中显示的端口。

macOS 上的 MuMu 会在多个端口上开放 adb，端口号因版本和实例而异。查看正在监听的端口：

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i mumu
```

MuMu 12 的第一个实例通常是 `127.0.0.1:16384`，`127.0.0.1:5555` 也可以。如果两者都出现在 `adb devices` 中，它们是同一个模拟器。选一个，用 `-s` 指定。

### 连接中断时

转发保存在 adb server 中，所以模拟器重启、adb 断开或 adb server 重启时都会失效。按顺序排查：

1. **`adb devices` 为空。** 重新运行 `adb connect 127.0.0.1:16384`。如果显示 `offline`，先运行 `adb disconnect 127.0.0.1:16384`，再重新连接。
2. **设备在列表中，但 `curl` 失败。** 转发已失效。运行 `adb forward --list`，然后重新执行 `forward` 命令。
3. **仍然失败。** 检查应用是否在运行并监听端口：

   ```bash
   adb -s 127.0.0.1:16384 shell "ps -A | grep xscript"
   adb -s 127.0.0.1:16384 shell "ss -ltn | grep 986"
   ```

   如果没有任何监听，在设备上打开 XScript（`adb -s 127.0.0.1:16384 shell am start -n com.xscript.app/.LauncherActivity`）。
4. **`curl` 正常，但 Cursor 仍连不上。** 检查 `mcp.json` 是否使用 `.venv` 中的 Python 以及 `XSCRIPT_DEVICE=127.0.0.1:9860`，然后把 MCP 服务关掉再打开。错误信息在 Cursor 的 **Output → MCP Logs** 中。

XScript 监听 9860，AScript 监听 9096，所以两个应用可以同时安装。转发你要访问的那个应用的端口。`adb forward tcp:9096 ...` 连到的是 AScript，不是 XScript。

## 第一个脚本

```bash
export XSCRIPT_DEVICE=127.0.0.1:9860
.venv/bin/python scripts/vertical_slice.py          # 上传并运行 examples/settings_search
.venv/bin/python scripts/vertical_slice.py --mock   # 同样的流程，针对仓库内的模拟设备
```

该脚本会上传 `examples/settings_search`，运行它，然后拉取日志和截图。`examples/xs_smoke` 用于测试原生 API，`examples/as_demo` 用于测试 AScript API。

上传整个项目目录（包括 AScript 项目）：

```python
from xscript_mcp.client import DeviceClient, DeviceTarget
c = DeviceClient(DeviceTarget.parse("127.0.0.1:9860"))
c.upload_directory("my_proj", "path/to/my_proj")
c.run_project("my_proj")
```

## 测试

```bash
./scripts/verify.sh
```

它会运行以下检查。修改 `android/python-runtime/` 后，请运行 `python3 scripts/gen_stubs.py` 和 `python3 scripts/gen_completions.py`（后者更新网页 IDE 的补全索引）。

- **运行时测试**（`android/python-runtime/tests`）：如果存在 `.venv-rt` 则使用它。需要 numpy、opencv-python 和 pillow，版本与手机内置的一致（见 README「开发与测试」，CI 用同样的版本）；YOLO / PaddleOCR / pip 测试还需要 `onnxruntime==1.22.1` 和 `packaging==24.2`。
- **后端测试**（`backend/tests`）：管理后台测试需要在 `.venv` 中执行 `pip install -e backend`，否则跳过。如果已在 `backend/web` 中运行过 `npm ci`，还会运行 Web 控制台的单元测试（`npm test`，vitest + Testing Library，位于 `backend/web/tests`）并构建控制台。
- **MCP 测试**（`ide/mcp-server/tests`）。
- **Stub 是否最新的检查。**
- **网页 IDE：** `node --test scripts/tests/*.test.cjs`，覆盖编辑器状态、目录树与键盘导航、Python 高亮，以及针对模拟设备的工程/文件接口契约。
- **VS Code 扩展：** 编译并运行 `node --test`，前提是已在 `ide/vscode-extension` 中运行过 `npm ci`。需要 Node 22+（`.nvmrc`）；Node 20 的 `node --test` 不认识通配符，会报 “Could not find …”。
- **桌面端：** 存在 `.venv-desktop`（装了 `desktop/app[test]`，含 PySide6）且 `desktop/frontend` 运行过 `npm ci` 时，先做前端类型检查、单测和构建，再在 offscreen Qt 下跑 `desktop/app` 的 Python 测试；否则跳过（`XS_SKIP_DESKTOP=1` 也可跳过）。Linux 上 QtWebEngine 需要 `libegl1`、`libnss3` 等系统库。
- **模拟设备上的端到端流程（vertical slice）。**

如果还要用真实模型运行 YOLO11n / PP-OCRv5 测试，把 `yolo11n.onnx`、`ch_PP-OCRv5_det_mobile.onnx`、`ch_PP-OCRv5_rec_mobile.onnx` 和 `bus.jpg` 放到一个文件夹中，并设置 `XSCRIPT_TEST_MODELS=<folder>`。

Android JVM 单元测试（日志尾部读取、数据集、快照、定时任务、卡密令牌、工程存储的新建/删除规则）：

```bash
./android/build.sh :app:testDebugUnitTest
```

## 安全

HTTP 端口没有任何认证。任何能访问该端口的人都可以在手机上运行代码。云控连接依赖服务端的令牌（见 [CLOUD.md](CLOUD.md)）。另见 README。
