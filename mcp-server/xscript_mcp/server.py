from __future__ import annotations

import json
import os
from pathlib import Path

try:  # mcp 2.x renamed FastMCP to MCPServer
    from mcp.server.mcpserver import Image, MCPServer as _Server
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server, Image

from xscript_mcp.client import DEFAULT_PORT, DeviceClient, DeviceTarget

EVAL_DEADLINE_MS = 8000

mcp = _Server("xscript")
_client = DeviceClient(DeviceTarget.parse(os.environ.get("XSCRIPT_DEVICE", "127.0.0.1:9096")))


def _catalog() -> dict:
    path = Path(__file__).with_name("api_catalog.json")
    return json.loads(path.read_text(encoding="utf-8"))


def _json(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


@mcp.tool()
def connect_device(ip: str, port: int = DEFAULT_PORT) -> str:
    """Connect to an XScript device. Use a LAN IP, or 127.0.0.1 after adb forward."""
    target = _client.set_target(ip, int(port))
    try:
        status = _client.status()
    except Exception as exc:
        return "connected target %s but /status failed: %s" % (target.base_url, exc)
    return _json({"target": target.base_url, "status": status})


@mcp.tool()
def get_device_status() -> str:
    """Resolution, run channel (accessibility/root), capture source, running project."""
    return _json(_client.status())


@mcp.tool()
def screen_capture(jpeg: bool = True) -> Image:
    """Full-screen capture from the device. JPEG by default (smaller); set jpeg=False for lossless PNG."""
    if jpeg:
        return Image(data=_client.screen_jpeg(), format="jpeg")
    return Image(data=_client.screen_png(), format="png")


@mcp.tool()
def dump_ui_tree(mode: int = 0) -> str:
    """Accessibility tree. mode=0 simple, 1 full, 2 simple without system windows. Read this before writing a Selector."""
    return _json(_client.ui_tree(mode=int(mode)))


@mcp.tool()
def list_projects() -> str:
    """Projects installed on the device."""
    return _json({"projects": _client.list_projects()})


@mcp.tool()
def list_project_files(project_name: str) -> str:
    """Files inside a device project."""
    return _json({"files": _client.list_files(project_name)})


@mcp.tool()
def read_project_file(project_name: str, path: str) -> str:
    """Read one file from a device project (text as utf-8, binary as base64)."""
    return _json(_client.read_file(project_name, path))


@mcp.tool()
def upload_file(project_name: str, path: str, content: str) -> str:
    """Write one text file into a device project. Entry file must be __init__.py."""
    return _json(_client.upload_file(project_name, path, content))


@mcp.tool()
def upload_directory(project_name: str, local_path: str, replace: bool = True) -> str:
    """Zip a local project folder (with __init__.py, res/, images...) and install it on the device.

    Use this for whole projects and binary assets such as template images. replace=True wipes the
    device copy first.
    """
    return _json(_client.upload_directory(project_name, local_path, replace=replace))


@mcp.tool()
def delete_project(project_name: str) -> str:
    """Remove a project from the device."""
    return _json(_client.delete_project(project_name))


@mcp.tool()
def run_project(project_name: str) -> str:
    """Start __init__.py on the device in the script process."""
    return _json(_client.run_project(project_name))


@mcp.tool()
def stop_project(project_name: str) -> str:
    """Kill the on-device script process."""
    return _json(_client.stop_project(project_name))


@mcp.tool()
def get_run_log(since: int = 0) -> str:
    """Incremental stdout/stderr from the device runtime. Pass the previous `next` as since."""
    return _json(_client.logs(since=int(since)))


@mcp.tool()
def device_action(action_type: str, x: int = 0, y: int = 0, x2: int = 0, y2: int = 0, dur: int = 0,
                  text: str = "", key: str = "") -> str:
    """One direct action without writing code.

    action_type: click (x,y) | swipe (x,y → x2,y2) | input (text) | key (key = back/home/recents/notifications).
    """
    t = action_type.strip().lower()
    if t == "click":
        payload = {"type": "click", "x": x, "y": y, "dur": dur or 20}
    elif t == "swipe":
        payload = {"type": "swipe", "x1": x, "y1": y, "x2": x2, "y2": y2, "dur": dur or 300}
    elif t == "input":
        payload = {"type": "input", "text": text}
    elif t == "key":
        payload = {"type": "key", "name": key}
    else:
        return _json({"ok": False, "error": "unknown action_type"})
    return _json(_client.action(payload))


@mcp.tool()
def eval_python(code: str, timeout_ms: int = EVAL_DEADLINE_MS) -> str:
    """Short probe on the device. Assign _result. No while-True loops."""
    if "whileTrue" in code.replace(" ", ""):
        return _json({"ok": False, "error": "eval_python forbids while True; put loops in a project"})
    limit = min(int(timeout_ms), 15000)
    return _json(_client.eval_python(code, timeout_ms=limit))


@mcp.tool()
def get_module_apis(module: str = "") -> str:
    """Local API catalog. module is a substring such as action, node, screen, system, ui, or ascript."""
    catalog = _catalog()
    needle = (module or "").strip().lower()
    if not needle:
        return _json(catalog)
    hits = [m for m in catalog["modules"] if needle in m["name"].lower() or needle in m["description"].lower()]
    return _json({"modules": hits})


@mcp.tool()
def search_api(query: str) -> str:
    """Search the local API catalog by keyword."""
    catalog = _catalog()
    needle = (query or "").lower()
    found = []
    for mod in catalog["modules"]:
        blob = json.dumps(mod, ensure_ascii=False).lower()
        if needle in blob:
            found.append(mod)
    return _json({"query": query, "modules": found})


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
