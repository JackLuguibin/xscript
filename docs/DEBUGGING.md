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

## 同轮短信修正

已匹配原版 Java 契约：read 为布尔值，包含 subject；地址绑定 LIKE 包含匹配；按 date 排序；负 offset 按 0、非正 limit 不限；无权限/查询失败返回 []，首条助手返回 None。
可用 has_permission 区分无权限与无短信。request_permission 返回 None，但仍沿用 XScript 同步权限桥接，未复制原版非阻塞时序。

模拟器本地合成短信验证了字段、号码匹配、分页和无授权空结果，未输出号码或正文。测试后 READ_SMS 恢复为原先未授权状态。
另已验证模拟器加速度传感器的回调和 stop。
