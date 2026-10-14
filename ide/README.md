# ide：编辑器工具

在开发者电脑上、与编辑器配合运行的所有工具。它们都通过设备 HTTP API（`protocol/openapi.yaml`，端口 9860）与手机通信。

| 路径 | 作用 |
| --- | --- |
| `vscode-extension/` | VS Code / Cursor 扩展：上传并运行项目、跟踪日志、在设备上运行选中代码、截图、内置存根 |
| `mcp-server/` | Cursor MCP（`xscript-mcp`），让 AI 能看到屏幕，编写、上传和运行脚本。见 [mcp-server/README.md](mcp-server/README.md) |
| `python-stubs/` | 生成的 `.pyi` 存根，用于 `xscript.*` / `ascript.*` 自动补全（`scripts/gen_stubs.py`） |

## VS Code / Cursor 扩展

```bash
cd ide/vscode-extension
npm ci
npm run compile      # tsc，并把 ../python-stubs 复制到 ./stubs
npm test             # 用 node --test 对接 scripts/mock_device.py 测试（需要 Python 3）
npm run package      # xscript-vscode-0.1.0.vsix
cursor --install-extension xscript-vscode-0.1.0.vsix   # 或：code --install-extension ...
```

开发时，在 VS Code 中打开 `ide/vscode-extension`，按 F5 启动扩展开发宿主（Extension Development Host）。

| 命令 | 默认快捷键 | 作用 |
| --- | --- | --- |
| XScript: Connect to Device | 状态栏 | 设置 `xscript.device`（地址见 App 中的“开发者地址”，默认 `127.0.0.1:9860`） |
| XScript: Upload and Run Project | F6 | 保存并上传当前文件所在的项目，然后运行，并在 输出（Output）→ XScript 中跟踪日志 |
| XScript: Stop Project | Shift+F6 | 停止正在运行的项目 |
| XScript: Upload Project | | 仅上传 |
| XScript: Follow Run Logs | | 开启 / 关闭日志跟踪 |
| XScript: Run Selection on Device | | 对选中内容（或当前行）调用 `/eval` |
| XScript: Screenshot | | 在编辑器中打开设备截图 |
| XScript: Open Developer Tools | | 在浏览器中打开 `/tools/`（脚本 IDE / 图色 / 标注 / 投屏） |
| XScript: Enable API Autocomplete | | 把内置存根加入 `python.analysis.extraPaths` |

项目根目录是当前文件之上、含有 `__init__.py` 的最顶层文件夹；该文件夹名就是设备上的项目名。

设备 API 没有认证。扩展只应指向可信网络中的手机，或通过 `adb forward` 指向 `127.0.0.1`。
