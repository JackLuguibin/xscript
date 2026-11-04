# xscript-mcp

供 Cursor、Trae 等支持 MCP 的编辑器使用的 stdio MCP 服务器。它连接 App 中显示的端口上的 XScript 设备 HTTP API（默认 9860；AScript 使用 9096）。同时兼容 mcp 1.x（`FastMCP`）和 2.x（`MCPServer`）。

## Windows / PowerShell：安装后添加 MCP

先安装 Python **3.10 或更高版本**（包含 Windows Python 启动器 `py`）。在任意目录的 PowerShell 执行这一条命令，不需要克隆仓库，也不需要先安装 Git：

```powershell
py -3 -m pip install --user "https://github.com/JackLuguibin/xscript/archive/refs/heads/main.zip#subdirectory=ide/mcp-server"
```

成功后，在 Trae「设置 → MCP → 手动添加」或 Cursor 的 MCP 配置里填入：

```json
{
  "mcpServers": {
    "xscript": {
      "command": "py",
      "args": ["-3", "-m", "xscript_mcp"],
      "env": {
        "XSCRIPT_DEVICE": "127.0.0.1:9860",
        "XSCRIPT_TOKEN": "手机显示的配对码"
      }
    }
  }
}
```

将 `XSCRIPT_DEVICE` 改为手机首页显示的开发者地址（例如 `192.168.1.20:9860`，不带 `http://`），`XSCRIPT_TOKEN` 改为手机的配对码。`127.0.0.1:9860` 仅适用于已执行 `adb forward tcp:9860 tcp:9860` 的 USB 连接。关闭配对的设备可省略 `XSCRIPT_TOKEN`。

如果 Trae 找不到 `py`，用 `py -3 -c "import sys; print(sys.executable)"` 查到 Python 完整路径，将其填入 `command`，并从 `args` 中移除 `-3`；JSON 中路径反斜杠要写成 `\\`。安装命令和 MCP 必须使用同一个 Python。添加后重启 MCP Server，再调用 `get_device_status` 检查连接。可先用 `py -3 -c "import xscript_mcp; print(xscript_mcp.__file__)"` 确认安装位置。

MCP 客户端负责启动 stdio 服务，无需在终端另开一个服务器。Windows PowerShell 5.1 不支持 `&&`，也不支持 `export` 或 `.venv/bin/python`，请直接使用上面的 Windows 配置。

## macOS / Linux（从源码安装）

在仓库根目录执行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e ide/mcp-server
```

MCP JSON 同上，将 `command` 改为 `.venv/bin/python` 的绝对路径，`args` 改为 `["-m", "xscript_mcp"]`。设备地址与配对码同样放在 `env` 中。

工具：

- `connect_device`、`get_device_status`
- `screen_capture`、`dump_ui_tree`
- `list_projects`、`list_project_files`、`read_project_file`
- `upload_file`、`upload_directory`、`delete_project`
- `run_project`、`stop_project`、`get_run_log`
- `project_run_options`（开机自启 / 停止后重新运行）
- `list_schedules`、`add_schedule`、`update_schedule`、`delete_schedule`、`run_schedule_now`（定时任务）
- `device_action`、`eval_python`
- `take_snapshot`、`vision_test`、`crop_template`（图色：在冻结的画面上测试颜色、色块、主色、模板和 OCR；支持 `color_space` / `tolerance` / `method`）
- `list_datasets`、`export_dataset`（标注：下载 YOLO zip）
- `get_module_apis`、`search_api`（本地 API 目录，查准确的函数签名）
- `get_coding_rules`（XScript 编码规则，即 [docs/AGENT_RULES.md](../../docs/AGENT_RULES.md)：定位方式、API 选择、项目结构和设备工作流程；同样内容也作为资源 `xscript://rules` 提供）。让 AI 写或检查脚本前先调用它，再用上面两个工具查签名。包内的 `xscript_mcp/agent_rules.md` 是该文档的副本，改规则时两处一起改（测试会检查一致）

设备 API 默认需要配对码：把手机 XScript 首页「开发与连接 → 配对码」设置为环境变量 `XSCRIPT_TOKEN`（如 `ABCD-EFGH`），或调用 `connect_device(ip, port, token)`。缺少或错误时工具会返回 401 和提示。`XSCRIPT_DEVICE` 只应指向可信网络中的手机，或通过 `adb forward` 指向 `127.0.0.1`。
