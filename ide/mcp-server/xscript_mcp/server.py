from __future__ import annotations

import json
import os
from pathlib import Path

try:  # mcp 2.x renamed FastMCP to MCPServer
    from mcp.server.mcpserver import Image, MCPServer as _Server
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server, Image

from xscript_mcp.client import DEFAULT_PORT, DeviceClient, DeviceTarget
from xscript_mcp.debug import DebugError, DebugSession

EVAL_DEADLINE_MS = 8000

mcp = _Server("xscript")
_client = DeviceClient(DeviceTarget.parse(os.environ.get("XSCRIPT_DEVICE", "127.0.0.1:%d" % DEFAULT_PORT)))
_debug = DebugSession(_client)


def _catalog() -> dict:
    path = Path(__file__).with_name("api_catalog.json")
    return json.loads(path.read_text(encoding="utf-8"))


def _json(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


@mcp.tool()
def connect_device(ip: str, port: int = DEFAULT_PORT, token: str = "") -> str:
    """Connect to an XScript device. Use a LAN IP, or 127.0.0.1 after adb forward.

    `token` is the pairing code shown on the phone (开发与连接 → 配对码); empty keeps XSCRIPT_TOKEN."""
    target = _client.set_target(ip, int(port), token=token or None)
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
def get_device_settings() -> str:
    """Runtime settings: run_mode (auto/accessibility/root), float_on_run, float_always, keep_screen_on, cloud_url."""
    return _json(_client.get_settings())


@mcp.tool()
def update_device_settings(run_mode: str | None = None, float_on_run: bool | None = None,
                           float_always: bool | None = None, keep_screen_on: bool | None = None) -> str:
    """Change device runtime settings; only the arguments you pass are changed. cloud_url is read-only.

    run_mode: "auto", "accessibility" or "root". float_on_run shows the floating window while a script runs;
    float_always also shows it when idle; keep_screen_on stops the screen sleeping.
    """
    if run_mode is not None and run_mode not in ("auto", "accessibility", "root"):
        return _json({"ok": False, "error": "run_mode must be auto, accessibility or root"})
    changes = {k: v for k, v in {"run_mode": run_mode, "float_on_run": float_on_run, "float_always": float_always,
                                 "keep_screen_on": keep_screen_on}.items() if v is not None}
    if not changes:
        return _json({"ok": False, "error": "nothing to change"})
    return _json(_client.update_settings(changes))


@mcp.tool()
def list_ascript_projects() -> str:
    """AScript projects already on the phone (/sdcard/airscript/model) that can be imported."""
    return _json({"projects": _client.list_ascript_projects()})


@mcp.tool()
def import_ascript_project(name: str) -> str:
    """Copy one AScript project from the phone into XScript so it can run unchanged.

    Needs root or shared-storage access on the device. Use list_ascript_projects for the names; for a
    project on this computer, use upload_directory instead.
    """
    return _json(_client.import_ascript_project(name))


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
def project_run_options(project_name: str, auto_run: bool | None = None, stop_re_run: bool | None = None) -> str:
    """Read or change a project's run options. Omit both flags to read.

    auto_run: 开机自启, start the project after the device boots (one boot project per device).
    stop_re_run: 停止后重新运行, re-run the project when it exits or crashes (not after a user stop).
    """
    flags = {k: v for k, v in (("auto_run", auto_run), ("stop_re_run", stop_re_run)) if v is not None}
    if not flags:
        return _json(_client.project_config(project_name))
    return _json(_client.set_project_config(project_name, **flags))


@mcp.tool()
def list_schedules(project_name: str = "") -> str:
    """定时任务 on the device (all, or one project's). Each has id, kind, next (epoch ms), enabled."""
    return _json(_client.list_schedules(project_name or None))


@mcp.tool()
def add_schedule(project_name: str, kind: str, time: str = "", weekdays: list[int] | None = None,
                 every: int = 0, window: str = "", at: str = "", if_running: str = "skip") -> str:
    """Add a 定时任务 that runs a project. Times are device-local.

    kind:
      daily     time = "HH:mm"; weekdays = [1..7] (1 = Monday), empty = every day
      interval  every = minutes; window = "HH:mm-HH:mm" to limit hours (optional, may cross midnight)
      once      at = "yyyy-MM-dd HH:mm"
    if_running: "skip" (default) leaves a running script alone; "restart" stops it and runs this project.
    """
    body: dict = {"project": project_name, "kind": kind, "if_running": if_running}
    if kind == "daily":
        body.update(time=time, weekdays=list(weekdays or []))
    elif kind == "interval":
        body.update(every=int(every), window=window)
    elif kind == "once":
        body["at"] = at
    return _json(_client.add_schedule(body))


@mcp.tool()
def update_schedule(schedule_id: str, enabled: bool | None = None, time: str = "", every: int = 0,
                    window: str | None = None, if_running: str = "") -> str:
    """Change a schedule: enable/disable it, or change its time / interval / window / if_running."""
    fields: dict = {}
    if enabled is not None:
        fields["enabled"] = enabled
    if time:
        fields["time"] = time
    if every:
        fields["every"] = int(every)
    if window is not None:
        fields["window"] = window
    if if_running:
        fields["if_running"] = if_running
    return _json(_client.update_schedule(schedule_id, fields))


@mcp.tool()
def delete_schedule(schedule_id: str) -> str:
    """Remove a 定时任务."""
    return _json(_client.delete_schedule(schedule_id))


@mcp.tool()
def run_schedule_now(schedule_id: str) -> str:
    """Run a schedule's project immediately. result: started / skipped / queued / missing."""
    return _json(_client.run_schedule(schedule_id))


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
    """Short probe on the device. Assign _result. No while-True loops.

    Runs in a separate device process that is killed on timeout, which also drops any state
    earlier evals left behind.
    """
    # Guidance for the agent, not a security boundary: the device enforces the timeout.
    if "whileTrue" in code.replace(" ", ""):
        return _json({"ok": False, "error": "eval_python forbids while True; put loops in a project"})
    limit = min(int(timeout_ms), 15000)
    return _json(_client.eval_python(code, timeout_ms=limit))


@mcp.tool()
def take_snapshot() -> str:
    """Freeze the current screen on the device for 图色 checks. Returns {id, width, height}.

    Pass the id to vision_test / crop_template so every check runs on the same frame.
    """
    return _json(_client.snapshot())


@mcp.tool()
def vision_test(snapshot_id: str, op: str, colors: str = "", rect: list[int] | None = None, sim: float = 0.9,
                x: int = 0, y: int = 0, template: str = "", template_rect: list[int] | None = None,
                confidence: float = 0.8, engine: str = "", model: str = "", conf: float = 0.25) -> str:
    """Run one 图色 check on a snapshot, with the same engine scripts use. Returns timings in ms.

    op:
      pixel           color at (x, y)
      find_colors     colors = 'x,y,#RRGGBB|x2,y2,#RRGGBB' (first point is the anchor); rect optional
      compare_colors  per-point expected vs actual
      find_image      template = '<project>:res/img/a.png', or template_rect = region of this snapshot
      ocr             text lines with rects; rect optional. engine = mlkit (default) | auto | paddle | paddle_v4 | paddle_v6t | paddle_v6s
      yolo            detections; model = '<project>:res/best.onnx' or a path under the model dir; conf threshold
    rect / template_rect are [left, top, right, bottom] in screen pixels. sim is 0..1 (0.9 ≈ ±25 per channel).
    The first paddle / auto / yolo call loads (and may download) models, so it takes longer.
    """
    req: dict = {"snapshot": snapshot_id, "op": op, "sim": sim, "confidence": confidence}
    if engine:
        req["engine"] = engine
    if op == "yolo":
        req.update(model=model, conf=conf)
    if rect:
        req["rect"] = rect
    if op == "pixel":
        req.update(x=x, y=y)
    if colors:
        req["colors"] = colors
    if template:
        req["template"] = template
    if template_rect:
        req["template_rect"] = template_rect
    return _json(_client.vision(req))


@mcp.tool()
def crop_template(snapshot_id: str, rect: list[int], project_name: str, path: str = "res/img/tpl.png") -> str:
    """Save a region of a snapshot as a PNG template inside a device project (for find_image / FindImages)."""
    return _json(_client.crop_snapshot(snapshot_id, rect, project_name, path))


@mcp.tool()
def list_datasets() -> str:
    """标注 datasets on the device: name, classes, image and labelled counts."""
    return _json({"datasets": _client.list_datasets()})


@mcp.tool()
def export_dataset(name: str, local_path: str) -> str:
    """Download a dataset as a YOLO zip (images/{train,val}, labels/{train,val}, data.yaml) to local_path."""
    data = _client.export_dataset(name)
    target = Path(local_path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return _json({"ok": True, "path": str(target), "bytes": len(data)})


@mcp.tool()
def list_models() -> str:
    """Model files on the device (YOLO .onnx, PaddleOCR packs) with sizes, and the model directory."""
    return _json(_client.list_models())


@mcp.tool()
def upload_model(local_path: str, remote_path: str = "") -> str:
    """Copy a local model file (e.g. runs/detect/train/weights/best.onnx) to the device model directory.

    remote_path defaults to the file name. Scripts load it with
    yolo.load(models.path("<remote_path>")). Project-local models (res/best.onnx) go through
    upload_directory instead.
    """
    name = remote_path or Path(local_path).name
    return _json(_client.upload_model(local_path, name))


@mcp.tool()
def pip_install(packages: list[str], upgrade: bool = False, index_url: str = "") -> str:
    """Install PyPI packages on the device at runtime (no APK rebuild), e.g. ["schedule", "pymysql==1.1.1"].

    Pure-Python wheels come from PyPI (or index_url); C-extension packages only from Chaquopy's
    Android index (pandas, scipy, lxml, cryptography, ...). Packages built into the app (numpy,
    opencv, pillow, requests, pyyaml) are never replaced. A project's requirements.txt installs
    automatically on its first run, so prefer that for project dependencies.
    """
    return _json(_client.pip("install", packages, upgrade=upgrade, index_url=index_url))


@mcp.tool()
def pip_list() -> str:
    """Packages installed at runtime with pip_install / requirements.txt (not the bundled ones)."""
    return _json(_client.list_packages())


@mcp.tool()
def pip_uninstall(packages: list[str]) -> str:
    """Remove runtime-installed packages from the device."""
    return _json(_client.pip("uninstall", packages, timeout_s=60))


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


# ---------------------------------------------------------------- breakpoint debugging

def _dbg(fn, *a, **kw) -> str:
    try:
        return _json(fn(*a, **kw))
    except DebugError as e:
        return _json({"ok": False, "error": str(e), "state": _debug.state})


@mcp.tool()
def debug_start(project_name: str, breakpoints: dict[str, list[int]] | None = None, wait_seconds: float = 30) -> str:
    """Run a saved device project under the debugger and wait until it stops at a breakpoint or ends.

    breakpoints maps project-relative files to 1-based lines, e.g. {"__init__.py": [12, 30]}. Upload the
    project first. Returns state (stopped/running/terminated) plus, when stopped, file, line, stack and locals.
    Always finish with debug_stop.
    """
    if _debug.client is not _client:
        _debug.client = _client
    return _dbg(_debug.start, project_name, breakpoints or {}, wait_seconds=wait_seconds)


@mcp.tool()
def debug_step(action: str = "continue", wait_seconds: float = 30) -> str:
    """Resume a stopped program: continue, next (step over), step_in, step_out, or pause a running one.

    Waits up to wait_seconds for the next stop and returns the same snapshot as debug_start.
    """
    return _dbg(_debug.step, action, wait_seconds)


@mcp.tool()
def debug_set_breakpoints(file: str, lines: list[int]) -> str:
    """Replace the breakpoints of one project file (an empty list clears them) during a session."""
    return _dbg(lambda: {"breakpoints": _debug.set_breakpoints(file, lines)})


@mcp.tool()
def debug_evaluate(expression: str, frame_id: int | None = None) -> str:
    """Evaluate a Python expression in a stopped frame (top frame by default). Keep it side-effect free."""
    return _dbg(_debug.evaluate, expression, frame_id)


@mcp.tool()
def debug_status(wait_seconds: float = 0) -> str:
    """Current debug state and snapshot; wait_seconds > 0 waits for a running program to stop."""
    return _dbg(_debug.wait, wait_seconds)


@mcp.tool()
def debug_stop(terminate: bool = True) -> str:
    """End the debug session. terminate=False only detaches and leaves the script running."""
    return _dbg(_debug.stop, terminate)
