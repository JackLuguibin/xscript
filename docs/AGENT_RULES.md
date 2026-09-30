# XScript agent rules

You are writing scripts that run **on the Android device**, not on the computer.

## Do not guess the UI

Never invent a `text`, `id`, color, or coordinate. Call `dump_ui_tree` and/or `screen_capture` first. Selector strings, colors, and template crops must come from that dump or screenshot.

## Pick the right locator

1. A node with `text`, `id`, or `desc` → `node.Selector()...find()` then `.click()` or `.set_text()`.
2. A game or canvas surface with no nodes → `screen.find_image` (a template in `res/img/`), `screen.find_colors` / `compare_colors`, or `screen.ocr_find`.
3. Raw `action.click(x, y)` is a last resort. Coordinates depend on resolution and orientation.

Call `screen.size()` rather than assuming portrait. Games often run landscape.

## APIs

- New scripts use `xscript.android.*`. Look up exact signatures with `get_module_apis` / `search_api`.
- AScript projects use `ascript.android.*`. Keep their imports as they are. Do not port them to `xscript.*` unless asked.
- Unsupported AScript features (HID, YOLO, OcrX, WebSelector, sms, plug, AScript cloud control, gp files) raise `NotImplementedError`. Replace them with supported calls instead of retrying.
- React to keys, notifications and toasts with `xscript.android.event` (or AScript's `ascript.android.event`) instead of polling. Handlers run on a daemon thread, so the script must keep running.
- For unattended runs, use the `project_run_options` and `add_schedule` MCP tools (or `system.Config` / `system.Schedule` in a script). Do not write a `while True` loop that sleeps until a certain time.

## Long loops live in the device script

Polling, game, and ad-watch loops belong in `__init__.py` on the phone. Do not drive those loops through MCP: LAN latency is too high, and an `eval` that times out gets its whole process killed.

`eval_python` is for one-shot probes, such as trying a selector, one click, or one OCR. Every `eval` must assign `_result` and return within a few seconds. No `while True`.

## Project layout

- Entry file: `__init__.py`. The working directory is the project folder.
- Extra modules use relative imports only (`from . import helper`).
- Assets go in `res/`, with images in `res/img/`. Reference them with `system.R.img("x.png")` or relative paths.

## Workflow

1. `connect_device` / `get_device_status`. Accessibility or root must be on; check `channel` and `capture_source`.
2. If the dump shows the wrong scene, ask the user to open the target screen.
3. `dump_ui_tree` (mode `0` first) and `screen_capture`.
4. Write the project, then `upload_file` or `upload_directory`, then `run_project`.
5. `get_run_log` and another screenshot.
6. Fix and rerun until it is stable. `stop_project` before uploading changes to a running project.

## When clicks do nothing

If `click()` returns True but the app doesn't react:

- Check for another full-screen overlay. On Android 12+, taps under an overlay above 0.8 opacity are dropped (`Untrusted touch` in logcat).
- The target may ignore accessibility gestures. Switch 运行模式 to root.
- The screen may have changed. Take a fresh screenshot before assuming the coordinates are wrong.
