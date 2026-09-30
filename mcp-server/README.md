# xscript-mcp

Stdio MCP server for Cursor. It talks to the XScript device HTTP API on the port shown in the app (9860 by default; AScript uses 9096). It works with both mcp 1.x (`FastMCP`) and 2.x (`MCPServer`).

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e .
export XSCRIPT_DEVICE=127.0.0.1:9860
.venv/bin/python -m xscript_mcp
```

Cursor config:

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

Tools:

- `connect_device`, `get_device_status`
- `screen_capture`, `dump_ui_tree`
- `list_projects`, `list_project_files`, `read_project_file`
- `upload_file`, `upload_directory`, `delete_project`
- `run_project`, `stop_project`, `get_run_log`
- `device_action`, `eval_python`
- `take_snapshot`, `vision_test`, `crop_template` (图色: test colors, templates and OCR on a frozen frame)
- `list_datasets`, `export_dataset` (标注: download a YOLO zip)
- `get_module_apis`, `search_api`

The device API has no authentication. Point `XSCRIPT_DEVICE` only at phones on a trusted network, or at `127.0.0.1` through `adb forward`.
