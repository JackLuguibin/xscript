# xscript-mcp

供 Cursor 使用的 stdio MCP 服务器。它连接 App 中显示的端口上的 XScript 设备 HTTP API（默认 9860；AScript 使用 9096）。同时兼容 mcp 1.x（`FastMCP`）和 2.x（`MCPServer`）。

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

工具：

- `connect_device`、`get_device_status`
- `screen_capture`、`dump_ui_tree`
- `list_projects`、`list_project_files`、`read_project_file`
- `upload_file`、`upload_directory`、`delete_project`
- `run_project`、`stop_project`、`get_run_log`
- `project_run_options`（开机自启 / 停止后重新运行）
- `list_schedules`、`add_schedule`、`update_schedule`、`delete_schedule`、`run_schedule_now`（定时任务）
- `device_action`、`eval_python`
- `take_snapshot`、`vision_test`、`crop_template`（图色：在冻结的画面上测试颜色、模板和 OCR）
- `list_datasets`、`export_dataset`（标注：下载 YOLO zip）
- `get_module_apis`、`search_api`

设备 API 默认需要配对码：把手机 XScript 首页「开发与连接 → 配对码」设置为环境变量 `XSCRIPT_TOKEN`（如 `ABCD-EFGH`），或调用 `connect_device(ip, port, token)`。缺少或错误时工具会返回 401 和提示。`XSCRIPT_DEVICE` 只应指向可信网络中的手机，或通过 `adb forward` 指向 `127.0.0.1`。
