# xscript-mcp

供 Cursor、Trae 等支持 MCP 的编辑器使用的 stdio MCP 服务器。它连接 App 中显示的端口上的 XScript 设备 HTTP API（默认 9860；AScript 使用 9096）。同时兼容 mcp 1.x（`FastMCP`）和 2.x（`MCPServer`）。

```bash
# 在仓库根目录执行
python3.12 -m venv .venv && .venv/bin/pip install -e ide/mcp-server
export XSCRIPT_DEVICE=127.0.0.1:9860
.venv/bin/python -m xscript_mcp
```

Cursor 配置：

```json
{
  "mcpServers": {
    "xscript": {
      "command": "/absolute/path/to/.venv/bin/python",
      "args": ["-m", "xscript_mcp"],
      "env": { "XSCRIPT_DEVICE": "127.0.0.1:9860" }
    }
  }
}
```

Trae 配置：在 Trae 的「设置 → MCP」里手动添加 MCP Server，填入上面同样的 JSON（`command` 必须是不含空格的完整路径，见 [Trae 官方文档：添加 MCP Server](https://docs.trae.cn/ide_add-mcp-servers)）；也可以开启项目级 MCP，把同样内容写进项目根目录的 `.trae/mcp.json`。其他支持 stdio MCP 的客户端同理。

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
