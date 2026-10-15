# Python 断点调试

网页 IDE 支持保存并调试、行断点、继续、暂停、单步、进入/跳出、调用栈和变量查看。使用 Microsoft debugpy 1.8.22 的进程内适配器，运行在 XScript `:script` 进程。

## 模拟器使用

```sh
adb -s emulator-5554 forward tcp:19860 tcp:9860
```

启动 XScript，打开 `http://127.0.0.1:19860/tools/ui/editor.html`。
本轮已在模拟器创建 `debug_demo`；源码也在 `examples/debug_demo/__init__.py`。

1. 选择工程，将光标放在第 2 行 `total += 41`，点击“切换当前行断点”。
2. 点击“保存并调试”。所有草稿保存成功才启动，保存中发生新编辑会阻止此次启动。
3. 暂停时查看 `total = 1`；点击“单步”后变为 `42`。
4. 点击“继续”，日志显示“调试完成 42”，任务结束。

“断开”先发送 DAP disconnect（terminateDebuggee=false），再关闭传输，使暂停脚本继续执行；“停止”终止脚本进程，也可中断等待 attach 的任务。
断点保存在当前网页会话中，刷新后需要重设。当前没有 Monaco、悬停求值、嵌套变量展开或完整 IDE 的全部配置。编辑器只有轻量的 Python 语法高亮（盖在文本框下面的一层着色），行号栏里的断点标记、编辑和保存都不受影响。删除文件时会一并清除该文件的断点。

## API 与生命周期

- `POST /projects/{name}/debug`：调试启动，返回 debug.port=5678 和 debug.remote_root。已有运行/启动中的任务返回 409；许可拒绝返回 403。
- `POST /debug/connect`：连接脚本进程的 127.0.0.1:5678。
- `POST /debug/request`：标准 DAP JSON request，经 UTF-8 Content-Length 帧发送。
- `GET /debug/messages?since=N`：返回 messages [{id,message}]、next、connected、error、dropped_before。
- `DELETE /debug`：只关闭传输；客户端应先发送 DAP disconnect，才能正确解除暂停。

握手为 initialize → attach → initialized event → setBreakpoints → configurationDone。attach 响应可能在 configurationDone 之后到达，不能提前阻塞等待。
source.path 使用 remote_root 下的绝对路径；前端只打开所选工程内的文件。

调试器仅在明确请求调试时启动，监听 loopback，不增加 LAN 端口。消息沿用开发服务 HTTP API，单次一个客户端。普通运行不启动 debugpy。
等待 attach/配置最多 120 秒，超时后项目不执行并报错。结束/停止会退出整个脚本进程，释放监听端口与调试线程。
HTTP 缓冲最多 512 条/8 MiB，DAP 单帧上限 4 MiB；客户端需留意 dropped_before。本实现采用 HTTP 轮询，没有复制 AScript `/dap/` WebSocket URL。

## 验证

ARM64 Android 17/API 37、16 KiB 页模拟器已验证断点、栈、局部变量、单步、evaluate、继续完成、等待 attach 时停止、调试后普通运行、标准 disconnect 后恢复任务。网页控件也经过真实浏览器操作。
其他 Android/ROM、第三方原生线程等场景仍需进一步验证。

可复现检查（只创建并删除自己的临时工程，要求没有用户任务正在运行）：

```sh
python3 scripts/device_debug_smoke.py --base http://127.0.0.1:19860
```

debugpy wheel 来源、哈希与许可证见 `android/wheels/README.md`。

## VS Code / Cursor 一键调试

扩展注册了调试类型 `xscript`（内联调试适配器，不起子进程）：把 VS Code 的调试协议（DAP）经上面的 `/debug/*` 接口转给手机上的 debugpy。启动流程：保存全部文件 → 上传工程 → `POST /projects/{name}/debug` → 轮询 `POST /debug/connect` 直到 debugpy 监听 → 发 attach（带路径映射）→ 回 `initialized` → 设置断点 → `configurationDone`。

- 路径映射：本地工程目录 ⇄ `remote_root`；栈帧、断点来源和输出里的路径都转换回本地文件，所以 VS Code 能直接跳转。
- 日志：脚本输出来自 `/logs`，在 `terminated` 事件前补齐；debugpy 自己转发的重复 stdout 会被丢弃。
- 结束：停止调试 = DAP disconnect（终止）+ 停止手机脚本 + `DELETE /debug`；`terminateDebuggee=false` 只分离，脚本继续运行。设备断线会给出提示并结束会话。
- 调试配置见 `ide/vscode-extension/package.json`（`projectRoot` / `project` / `device` / `upload` / `justMyCode`）。

测试：`ide/vscode-extension/src/test/dap.test.ts`（10 个，用假设备覆盖握手、路径映射、重试、断开、超时、断线）；真机检查：

```sh
adb forward tcp:19860 tcp:9860
cd ide/vscode-extension && npm run compile && node scripts/debug-smoke.js 127.0.0.1:19860
```

该脚本直接驱动适配器核心，在 emulator-5554 上验证了：上传 → 启动 → 断点命中（本地路径）→ 变量 → 单步 → evaluate → 继续 → 输出 → 断开，以及分离后脚本自己跑完。没有在真正的 VS Code / Cursor 界面里加载过扩展；条件断点、命中次数、日志点和修改变量只是声明并原样转发给 debugpy，没有逐项实测。

## 同轮短信修正

已匹配原版 Java 契约：read 为布尔值，包含 subject；地址绑定 LIKE 包含匹配；按 date 排序；负 offset 按 0、非正 limit 不限；无权限/查询失败返回 []，首条助手返回 None。
可用 has_permission 区分无权限与无短信。request_permission 返回 None，但仍沿用 XScript 同步权限桥接，未复制原版非阻塞时序。

模拟器本地合成短信验证了字段、号码匹配、分页和无授权空结果，未输出号码或正文。测试后 READ_SMS 恢复为原先未授权状态。
另已验证模拟器加速度传感器的回调和 stop。

## 设备上的端到端脚本

```bash
adb -s emulator-5556 forward tcp:19861 tcp:9860
python3 scripts/device_cvfont_e2e.py http://127.0.0.1:19861                      # 图片字库：Pillow 渲染真实字体字形 → 上传工程 → 设备上识别 → 对比
python3 scripts/device_ml_e2e.py http://127.0.0.1:19861 --models /path/to/models  # 运行时 pip、PaddleOCR v5、YOLO11n（模型目录放 yolo11n.onnx 和 bus.jpg）
```

两个脚本都建立并删除自己的工程；需要设备上的 numpy / OpenCV，所以用 **4KB 页面**的模拟器（16KB 页面的模拟器上 numpy / OpenCV 无法加载，是 Chaquopy 现有轮子的限制，脚本会给出提示）。`device_ml_e2e.py` 的 pip 和 OCR 步骤要求设备能上网（OCR 模型由设备自己下载并校验 SHA-256）。

## 在手机自带的 Chrome 里测试网页 IDE

网页 IDE 的浏览器测试默认用本机无头 Chrome。要在手机（或模拟器）自己的 Chrome 里跑，用 DevTools 转发：

```bash
adb forward tcp:19860 tcp:9860                                   # 设备接口（测试读写工程用）
adb forward tcp:9222 localabstract:chrome_devtools_remote        # 手机 Chrome 的调试口（先在手机上打开一次 Chrome）
XS_CDP=http://127.0.0.1:9222 XS_PAGE_URL=http://127.0.0.1:9860 XS_DEVICE_URL=http://127.0.0.1:19860 \
  node --test scripts/tests/editor-mobile.test.cjs
```

`XS_PAGE_URL` 是手机上看到的设备地址。这个测试用手机的真实屏幕尺寸和触摸输入，检查抽屉、补全弹窗、搜索面板、撤销替换和正则超时保护。桌面布局的 `editor-dom.test.cjs` 不适合手机屏幕（目录树在抽屉里），在手机上只跑 `editor-mobile`；同一台设备上的测试文件要串行跑（`--test-concurrency=1`），否则互相干扰。
