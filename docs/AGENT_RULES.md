# XScript 智能体规则

你编写的脚本运行在 **Android 设备上**，不是在电脑上。

## 不要猜测界面

绝不能凭空编造 `text`、`id`、颜色或坐标。必须先调用 `dump_ui_tree` 和/或 `screen_capture`。选择器字符串、颜色和模板截图必须来自该节点树或截图。

## 选对定位方式

1. 节点有 `text`、`id` 或 `desc` → 用 `node.Selector()...find()`，再调用 `.click()` 或 `.set_text()`。
2. 游戏或画布界面没有节点 → 用 `screen.find_image`（模板放在 `res/img/`）、`screen.find_colors` / `compare_colors` 或 `screen.ocr_find`。
3. 直接调用 `action.click(x, y)` 是最后手段。坐标依赖分辨率和屏幕方向。

必须调用 `screen.size()`，不要假定是竖屏。游戏经常以横屏运行。

## API

- 新脚本使用 `xscript.android.*`。用 `get_module_apis` / `search_api` 查询准确的函数签名。
- AScript 项目使用 `ascript.android.*`。保持其导入不变。除非用户要求，不要把它们移植到 `xscript.*`。
- 不支持的 AScript 功能（HID、NCNN 模型文件、OcrX、WebSelector、sms、付费插件、`connect_to_as`、gp 文件）会抛出 `NotImplementedError`。必须改用受支持的调用，不要重试。
- YOLO 需要 ONNX 模型：`xscript.android.yolo.load(R.res("best.onnx"))`。编写循环前，必须先用 `vision_test(op="yolo", model="<project>:res/best.onnx")` 在静止帧上验证。对于难以识别的中文文本，或 ML Kit 无返回结果时（模拟器），使用 `screen.ocr(engine="paddle")` / `vision_test(op="ocr", engine="paddle")`。
- 第三方包：列在项目的 `requirements.txt` 中，首次运行前会自动安装。不要把 wheel 打包进项目，也不要把 site-packages 复制到项目里。`pip_install` 用于在 `eval_python` 中试用某个包。
- 响应按键、通知和 toast 时，使用 `xscript.android.event`（或 AScript 的 `ascript.android.event`），不要轮询。处理函数运行在守护线程上，所以脚本必须保持运行。
- 无人值守运行时，使用 MCP 工具 `project_run_options` 和 `add_schedule`（或在脚本中使用 `system.Config` / `system.Schedule`）。不要写一个 sleep 到指定时间的 `while True` 循环。

## 长循环放在设备脚本中

轮询、游戏和看广告循环必须写在手机上的 `__init__.py` 中。不要通过 MCP 驱动这些循环：局域网延迟太高，而且 `eval` 超时会导致整个进程被杀死。

`eval_python` 只用于一次性探测，例如试一个选择器、点一次或做一次 OCR。每次 `eval` 必须给 `_result` 赋值，并在几秒内返回。禁止 `while True`。

## 项目结构

- 入口文件：`__init__.py`。工作目录是项目文件夹。
- 其他模块只能使用相对导入（`from . import helper`）。
- 资源放在 `res/`，图片放在 `res/img/`。用 `system.R.img("x.png")` 或相对路径引用。

## 工作流程

1. `connect_device` / `get_device_status`。必须开启无障碍或 root；检查 `channel` 和 `capture_source`。
2. 如果节点树显示的场景不对，请用户打开目标界面。
3. `dump_ui_tree`（先用 mode `0`）和 `screen_capture`。
4. 编写项目，然后 `upload_file` 或 `upload_directory`，再 `run_project`。
5. `get_run_log`，并再截一张图。
6. 修复并重新运行，直到稳定。向正在运行的项目上传修改前，必须先 `stop_project`。

## 点击无反应时

如果 `click()` 返回 True，但应用没有反应：

- 检查是否有其他全屏覆盖层。在 Android 12+ 上，位于不透明度高于 0.8 的覆盖层下方的点击会被丢弃（logcat 中出现 `Untrusted touch`）。
- 目标应用可能忽略无障碍手势。把运行模式切换为 root。
- 界面可能已经变化。在认定坐标错误之前，先重新截图。
