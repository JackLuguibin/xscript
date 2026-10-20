# ide：编辑器工具

在开发者电脑上、与编辑器配合运行的所有工具。它们都通过设备 HTTP API（`protocol/openapi.yaml`，端口 9860）与手机通信。

| 路径 | 作用 |
| --- | --- |
| `vscode-extension/` | VS Code / Cursor 扩展：活动栏设备 / 工程视图、设备扫描、新建工程、增量同步与拉取、运行 / 停止 / 一键断点调试、日志、在设备上运行选中代码、截图、内置存根（对照 AScript 官方扩展，见其 README） |
| `mcp-server/` | Cursor MCP（`xscript-mcp`），让 AI 能看到屏幕，编写、上传和运行脚本。见 [mcp-server/README.md](mcp-server/README.md) |
| `python-stubs/` | 生成的 `.pyi` 存根，用于 `xscript.*` / `ascript.*` 自动补全（`scripts/gen_stubs.py`） |

## VS Code / Cursor 扩展

```bash
cd ide/vscode-extension
npm ci
npm run compile      # tsc，并把 ../python-stubs 复制到 ./stubs
npm test             # 用 node --test 对接 scripts/mock_device.py 测试（需要 Python 3）
npm run package      # xscript-vscode-<版本>.vsix（也可从 GitHub Release 下载同名文件）
code --install-extension xscript-vscode-<版本>.vsix   # 或：cursor --install-extension ...
```

开发时，在 VS Code 中打开 `ide/vscode-extension`，按 F5 启动扩展开发宿主（Extension Development Host）。

| 命令 | 默认快捷键 | 作用 |
| --- | --- | --- |
| XScript: 选择运行设备 / 管理设备列表 / 添加 / 扫描设备 | 编辑器右上角手机图标 | 设备列表、ADB + 局域网扫描；当前设备保存在工作区 `xscript.device` |
| XScript: 新建工程 | | 模板（空 / Hello / AScript 写法），生成 `__init__.py`、`build.as`、`res/` |
| XScript: 运行（Upload and Run Project） | Ctrl+Shift+R（AScript 同款）、F6 | 先停止正在运行的脚本，再增量同步（遵守 `.vscode/.syncignore`），再运行，日志在 Output → XScript |
| XScript: 停止 | Shift+F6 | |
| XScript: 调试当前工程 | Alt+F6 | 保存并上传项目，以调试方式启动并连接（调试类型 `xscript`，也可用 launch.json） |
| XScript: 上传工程 / 工程同步 / 从设备拉取工程 / 编辑同步忽略规则 | | 上传是全量；拉取先确认会被覆盖的文件 |
| XScript: 跟踪运行日志 / 显示设备状态 / 连接设备 | 状态栏 | |
| XScript: 在设备上运行选中代码 | | 对选中内容（或当前行）调用 `/eval` |
| XScript: 截图 / 打开开发者工具 / 投屏 / ADB 终端 | | 截图在编辑器里打开；开发者工具和投屏在浏览器里打开手机上的页面 |
| XScript: 启用 API 自动补全 | | 把内置存根加入 `python.analysis.extraPaths` |

活动栏的 **XScript** 视图：设备（在线状态、行内运行 / 停止）、手机上的工程（行内运行 / 拉取）、工具。与 AScript 官方扩展的逐项对照（哪些做了、哪些因为是 AScript 自家服务或格式而不做）见 [vscode-extension/README.md](vscode-extension/README.md)。

项目根目录是当前文件之上、含有 `__init__.py` 的最顶层文件夹；该文件夹名就是设备上的项目名。

设备 API 默认需要配对码（手机 XScript 首页「开发与连接 → 配对码」）。VS Code 扩展遇到 401 会提示输入并保存在系统钥匙串（SecretStorage），也可以运行命令「XScript: 配对设备」；MCP 用环境变量 `XSCRIPT_TOKEN`。只应指向可信网络中的手机，或通过 `adb forward` 指向 `127.0.0.1`。
