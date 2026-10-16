# XScript：VS Code / Cursor 扩展

> **English:** run, stop and debug XScript / AScript-style projects on an Android phone from VS Code or Cursor, with live logs. Download `xscript-vscode-<version>.vsix` from the [GitHub Release](https://github.com/JackLuguibin/xscript/releases/latest) and install it with `code --install-extension xscript-vscode-<version>.vsix`, or build it with `cd ide/vscode-extension && npm ci && npm run package`. It talks to the device HTTP API (default port 9860, no login), so only point it at a phone on a trusted network or at `127.0.0.1` via `adb forward`. The details below are in Chinese. See the [English README](../../README.en.md) for the project overview.

把 XScript / AScript 风格的工程上传到 Android 手机，运行、停止、调试，看日志。通过设备 HTTP API（`protocol/openapi.yaml`，默认端口 9860）通信，没有登录。只指向可信网络中的手机，或用 `adb forward` 指向 `127.0.0.1`。

```bash
# 方式一：从 GitHub Release 下载（v0.2.4 及更早的 Release 没有，从下一个发布起附带） xscript-vscode-<版本>.vsix（和 App 同一个 Release，版本号相同，校验值在 SHA256SUMS 里）
code --install-extension xscript-vscode-<版本>.vsix      # Cursor：cursor --install-extension ...
# 方式二：自己打包
cd ide/vscode-extension && npm ci && npm run package     # 生成 xscript-vscode-<版本>.vsix
```

扩展版本号 = App 发布版本号（同一个 Git 标签、同一个 Release 页面），不上架 VS Code 应用市场。发布流程见 `scripts/release.sh` 和 [docs/发布.md](../../docs/发布.md)。

## 截图

![XScript 活动栏：设备、手机上的工程、工具；运行后 Output → XScript 实时输出日志](../../docs/images/vscode-run.png)

![一键调试：在断点处停下，左侧是变量、调用栈和断点，底部是调试控制台](../../docs/images/vscode-debug.png)

（真实 VS Code 1.142、隔离配置，连着一台 Android 模拟器的演示工程；`bash scripts/vscode-screenshots.sh` 可重新生成。）

## 使用

1. 打开 **XScript** 活动栏图标：**Devices** 里列出已保存的设备（在线 / 离线、正在运行的工程），点一下就把它设为当前设备；**Projects on device** 列出手机上的工程（行内按钮：运行、拉取到本地）；**Tools** 里是常用入口。
2. **扫描设备**（视图标题栏的放大镜）：自动找 ADB 设备（USB / 模拟器，必要时自动 `adb forward`）和局域网内 9860 端口上的 XScript。也可以用 **添加设备** 手动填 App 里的「开发者地址」。
3. **新建工程**（命令面板或 Tools）：选模板、选父目录、填名字。生成 `__init__.py`、`build.as`（AScript 的工程标记，手机端也认）和 `res/`。
4. 打开 `__init__.py`，点编辑器右上角的 ▶ 或按 **Ctrl+Shift+R**（F6 也行）。扩展会：停掉正在运行的脚本（再次运行等于「重新运行」）→ 把变化的文件同步到手机（按内容摘要和文件大小对比，只传新增或修改的）→ 启动，日志实时输出到 **Output → XScript**。**Shift+F6** 或 ■ 停止；**Alt+F6** 调试。
5. **工程同步**：上传（强制全量，忽略对比缓存）或从手机拉取（本地有差异的文件会先确认；手机上没有的本地文件不动）。
6. **编辑同步忽略规则**：`.vscode/.syncignore`（和 AScript 同一个位置），gitignore 风格（`*.log`、`dist/`、`/build/`、`!keep.log`）。以 `.` 开头的文件和目录、`__pycache__`、`.pyc`、虚拟环境始终不上传。

## 命令（命令面板里的名字有中文版，跟随 VS Code 显示语言）

| 命令 | 默认快捷键 | 说明 |
| --- | --- | --- |
| 选择运行设备 `xscript.selectDevice` | 编辑器右上角手机图标 | 从列表里选（含扫描、添加）；保存在工作区的 `.vscode/settings.json`（`xscript.device`） |
| 管理设备列表 / 添加 / 编辑 / 删除 / 扫描设备 | | 设备列表保存在扩展的全局存储里 |
| 新建工程 `xscript.newProject` | | 模板：空工程、Hello（屏幕 + 点击）、AScript 写法 |
| 运行 `xscript.run` | Ctrl+Shift+R、F6 | 先停止、再增量同步、再运行 |
| 停止 `xscript.stop` | Shift+F6 | |
| 调试当前工程 `xscript.debug` | Alt+F6 | 见 `docs/DEBUGGING.md` |
| 上传工程 / 工程同步 / 从设备拉取工程 | | |
| 编辑同步忽略规则 | | |
| 跟踪运行日志、显示设备状态、连接设备（手填地址） | 状态栏 | |
| 在设备上运行选中代码 `xscript.eval` | | 走 `/eval` |
| 截图、打开开发者工具（图色 / 标注）、投屏 | | 开发者工具和投屏用浏览器打开手机上的页面 |
| ADB 终端 | | 对当前 USB / 模拟器设备开 `adb shell` |
| 启用 API 自动补全 | | 把自带的 `xscript.*` / `ascript.*` 存根加到 `python.analysis.extraPaths` |

设置：`xscript.device`、`xscript.logPollMs`、`xscript.evalTimeoutMs`、`xscript.adbPath`（空 = 自动找 ANDROID_HOME / 常见 SDK 目录 / PATH）、`xscript.scanLan`（扫描时是否也扫局域网，默认开）。

## 和 AScript 官方扩展的对照

对照依据（2026-10-15）：

- 应用市场里的 **AScript (ascript)**，发布者 `ascript-aojoy`，版本 0.3.0（2026-05-12 更新）。下载了它的 vsix，只读了 `package.json`（命令、菜单、快捷键、视图、设置、调试器）、`readme.md`、`templates/` 和编译后脚本里的界面文字，没有拷贝代码。
- 官方文档 <https://www.ascript.cn/docs/android/devtools/vscode/>。
- 这些信息之外的实际界面（图标、网页面板的外观）没有在真实 AScript 扩展里运行过，所以下表只比较命令、菜单、行为描述，不比较像素。

| AScript 扩展 0.3.0 | XScript 扩展（与 App 同版本） | 状态 |
| --- | --- | --- |
| `新建 AScript 工程`（网页面板；Android 工程要从设备拉取；生成 `build.as`、`__init__.py`、`res/`） | `新建 XScript 工程`：模板 + 父目录 + 名字，本地生成同样的三项；不需要先连设备 | ✅ 对齐（体验不同） |
| `选择运行设备`（编辑器右上角手机图标；设备记在 `.vscode/settings.json`） | 同名图标、同样记在工作区设置（`xscript.device`） | ✅ |
| `运行`，**Ctrl+Shift+R**；再按一次先停止再同步再启动；对比本地与设备文件、只传新增 / 修改的 | **Ctrl+Shift+R**；同样先停止再运行；按大小 + 内容摘要增量上传 | ✅ |
| `停止` 按钮（运行时替换运行按钮，上下文 `ascript.running`） | `xscript.running` 上下文：运行时 ▶ 换成 ■ | ✅ |
| 日志经 WebSocket 到 Output → AScript | HTTP 轮询 `/logs`（约 1 秒）到 Output → XScript | ✅ 效果相同，实现不同 |
| 活动栏 AScript 视图：网站 / 设备 / 工具 / 导出 | 活动栏 XScript 视图：Devices / Projects on device / Tools | ✅ 部分（见下） |
| 设备：添加 / 编辑 / 删除，一键扫描 ADB 和局域网（端口 9096），设备行内的运行 / 停止按钮 | 同样的操作，局域网扫描 9860，行内运行 / 停止（按设备实时状态切换） | ✅ |
| `管理设备列表`（网页表单，公网地址 + 公网密码） | 命令面板里的选择菜单；没有公网地址 / 密码 | ◐ 设备接口没有鉴权，不做公网登录 |
| `工程同步[Android/iOS]`（网页面板：拉取 / 推送，标「本地新 / 远端新」） | `工程同步` 选择菜单：上传 / 拉取，拉取前列出会被覆盖的本地文件并确认 | ◐ 设备文件没有修改时间，做不了「谁更新」的判断 |
| `编辑同步忽略规则 (.syncignore)`，位于 `.vscode/.syncignore` | 同样的路径和命令，gitignore 风格规则 | ✅ |
| `调试当前工程 (Android)`，**F6**，调试类型 `ascript`（attach） | `调试当前工程`，**Alt+F6**，调试类型 `xscript`（launch：上传、启动、连接）；F6 仍是运行 | ◐ 功能对齐，快捷键保留原来的 F6 = 运行 |
| 工具：控件检索、图色助手、UI 生成器、Yolo 标注 / 训练 / 检测（打开网页） | `Developer Tools` 打开手机上的 `/tools/`（图色、标注、投屏）；没有 UI 生成器和云端训练 | ◐ |
| 工具：ADB 终端、投屏（下载 scrcpy） | `ADB 终端`（用系统 adb）；`投屏` 打开手机自带的网页投屏。不下载 scrcpy | ✅ / ◐ |
| 命令标题是中文 | `package.nls.zh-cn.json`，中文显示语言下是中文标题 | ✅ |
| 工程识别：`build.as` | `build.as` 或 `__init__.py` | ✅ |
| 设置：`ascript.pythonPath`（Windows 本地运行用） | 没有对应项：XScript 脚本只在手机上运行。另有 `xscript.adbPath`、`xscript.scanLan` 等 | ⛔ 不适用 |
| `在 Windows 本地运行`、`选择工程类型`（Windows / Android / iOS）、iOS 设备、`安装 ascript 库`（桌面 pip） | 不做：XScript 只有 Android；桌面补全用扩展自带存根（`启用 API 自动补全`） | ⛔ |
| `导包`（打 `.was` 引擎包）、`从设备导出并保存`、上传分发小程序 / 插件、官网 / 开发者后台 / 云控 / 云数据库链接 | 不做：这些是 AScript 官方服务和格式；XScript 的 APK 打包在管理后台（`docs/PACKAGING.md`） | ⛔ |
| 自动下载 ADB 和 scrcpy | 不做：使用本机已有的 adb | ⛔ |
| 没有状态栏项、没有「运行选中代码」、没有截图命令 | XScript 额外有：状态栏设备型号、`在设备上运行选中代码`、`截图` | 额外 |
| 没有代码片段（snippets）、也没有自带补全（靠 pip 装的 `ascript` 库 + Pylance） | 自带存根补全；没有片段 | 不需要 |

## 测试

```bash
npm test                                    # 38 个单元测试（对接 scripts/mock_device.py）
bash scripts/vscode-host-test.sh            # 装 vsix 到隔离配置的真实 VS Code（--user-data-dir / --extensions-dir 都在临时目录），在扩展宿主里跑真实命令（默认连 mock）
XS_VSCODE="/path/to/Visual Studio Code.app/Contents/MacOS/Code" bash scripts/vscode-host-test.sh   # 指定 VS Code；默认找 /tmp/vscode-real 和 /Applications
# 连模拟器 / 真机：adb forward tcp:19860 tcp:9860，再加
XS_HOST_TEST_DEVICE=127.0.0.1:19860 XS_HOST_TEST_REAL=1 XS_HOST_TEST_ADB=1 bash scripts/vscode-host-test.sh
```

### 验证不会弹登录

`scripts/vscode-env.sh` 给两个脚本一份「永远不要登录」的临时配置：临时 `HOME`（不碰 `~/.vscode`、不碰你的钥匙串和账号）、临时 `--user-data-dir` / `--extensions-dir`、关闭 GitHub 认证 / Copilot 等内置扩展、`--use-mock-keychain`、`settings.json` 里关 AI、欢迎页、云端更改、遥测、更新、工作区信任。`bash scripts/vscode-no-prompt-check.sh` 读取编辑器真实显示的内容和 macOS 窗口，证明没有任何登录 / 钥匙串 / 欢迎页。原因和排查过程见 `docs/DEBUGGING.md`。成功的运行会删掉临时目录；失败时保留（或设 `XS_HOST_TEST_KEEP=1`）方便看日志。

扩展宿主测试里覆盖：激活、27 个命令、活动栏视图和树节点、快捷键、状态栏文字、添加 / 编辑 / 删除设备、ADB 和局域网扫描、新建工程、运行（`.syncignore`、再次运行先停止并只同步改动）、停止、拉取、截图在编辑器里打开、通过 VS Code 调试 API 在断点处停下并求值。验证只在真实 VS Code 1.142.0（官方稳定版，隔离配置）里做过，Cursor 没有测。没有覆盖：真实按键、图标和视图的外观、选择菜单 / 输入框（用带参数的命令代替）、中文显示语言下的标题。
