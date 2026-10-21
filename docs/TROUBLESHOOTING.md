# 连不上手机怎么办

> **English:** checklist for when PyCharm, VS Code, the desktop app or the web tools cannot reach the phone. In order: is the XScript app open with its service running, is the address/port the one shown on the phone's home screen, for USB/emulators re-run `adb forward`, for Wi‑Fi check same network and no client isolation, and enter the pairing code when asked. Test with `curl http://<address>/status`.

PyCharm 的「连不上设备」通知、状态栏的「XScript：离线」、桌面端的「连不上设备」提示都链接到这一页。按顺序检查，一般前三步就能解决。PyCharm 的「连接设备」对话框和桌面端连接失败后出现的「逐项检查连接」会自动走一遍下面的检查，并指出断在哪一步。

## 1. 手机上的 XScript 打开了吗？

- 打开 XScript App，首页 **开发与连接 → 开发者地址** 应该显示 `http://<IP>:<端口>/`，通知栏有一条「正在监听 …」。
- 显示「服务未启动，点此启动」：点一下。全新安装后要先允许 **通知** 权限，服务才会启动。
- 地址是红字（9860–9869 端口都被占用）：点一下重试，或关掉占端口的其他应用。
- 系统把 App 杀掉了：首页 **权限 → 后台运行** 选「不限制」，部分手机还要在系统设置里允许自启动。

## 2. 地址和端口对吗？

- 端口以手机首页显示的为准。默认 9860，被占用时会顺延到 9869。
- 手机换了 Wi‑Fi 或重新连网后 IP 可能变了，在插件 / 桌面端里改成新地址。
- 在电脑上直接验证：

```bash
curl http://<地址>:<端口>/status
```

返回一段设备 JSON 就说明网络是通的，问题在插件设置或配对码；连接被拒绝或超时就继续往下查。

## 3. USB / 模拟器：重新 adb forward

用 `127.0.0.1` 连接时，电脑靠 adb 端口转发访问手机。**模拟器重启、adb 重启、拔插数据线后转发会失效**，这是最常见的原因：

```bash
adb devices                                   # 确认设备在线（不是 unauthorized / offline）
adb -s <设备> forward tcp:9860 tcp:9860       # 端口以手机首页为准
```

- `unauthorized`：在手机上允许 USB 调试弹窗。
- MuMu 等模拟器先 `adb connect 127.0.0.1:16384`。
- 模拟器里显示的 `10.0.2.x` 地址从电脑上访问不到，要用 `adb forward` + `127.0.0.1`。
- 桌面端连 USB 设备时会自动建立转发，失败时点「重试」即可重建；连接失败后设备页会出现「逐项检查连接」，直接告诉你断在哪一步。

## 4. Wi‑Fi：同一网络、没有隔离

- 电脑和手机要在同一个 Wi‑Fi（同一网段）。访客网络、公司网络常开启「AP 隔离 / 客户端隔离」，设备之间互相访问不到，换个网络或改用 USB。
- 电脑开了 VPN 或代理时，局域网地址可能被转发走，先关掉试试，或把手机 IP 加入代理例外。
- 电脑防火墙拦截出站连接的情况较少见，但安全软件可能会，临时关闭验证一下。

## 5. 配对码

除了 `/status` 和配对页，所有接口都要配对码（手机首页 **开发与连接 → 配对码**）。

- PyCharm / VS Code 第一次连接或配对码变了之后，会弹框要求输入；状态栏显示「XScript：需要配对」时点一下即可。
- 桌面端在设备卡片上输入；USB 连接时能自动读取。
- 配对码相当于密码，不要发给别人。

## 6. 还是不行

- 手机首页右上角 **日志** 看服务有没有报错。
- 把 App 和插件 / 桌面端升级到同一版本（「对方不像 XScript 设备」通常是版本或端口不对）。
- 在 GitHub 提 issue 时附上 `curl …/status` 的输出和日志（**去掉配对码**）。

## 附：逐项检查的每一步

桌面端的「逐项检查连接」、PyCharm 的「连接设备」和 VS Code 的 **XScript: Connect to Device** 按下表的顺序检查，停在第一个没通过的步骤，并显示同样的修法（文字来自 `protocol/connect-check.json`，下表由 `scripts/gen_connect_check.py` 生成）。

<!-- BEGIN generated: connect-check (scripts/gen_connect_check.py) -->

| 步骤 | 检查它的工具 | 没通过时怎么修 | 详见 |
| --- | --- | --- | --- |
| 找到 adb | 桌面端 | 安装 Android platform-tools，或在设置里指定 adb 路径（环境变量 XSCRIPT_ADB / ANDROID_HOME）。 | 第 3 节 |
| adb 能看到手机 | 桌面端 | 检查数据线（换一根能传数据的线），手机打开「开发者选项 → USB 调试」；模拟器先 adb connect。然后点「刷新」。 | 第 3 节 |
| 已允许 USB 调试 | 桌面端 | 在手机上的「允许 USB 调试吗？」弹窗里点允许（可勾选「始终允许」）；没有弹窗就拔插一次数据线。 | 第 3 节 |
| 端口转发 | 桌面端 | adb 转发失败：重启 adb（adb kill-server）后重试，或换个 USB 口。 | 第 3 节 |
| 地址格式 | 桌面端、PyCharm、VS Code | 请填写 主机:端口，例如 192.168.1.20:9860（端口为 1–65535，省略时用 9860）。<br>PyCharm / VS Code：请填写 主机:端口，例如 192.168.1.20:9860（省略端口时用 9860）；用 USB 时先 adb forward tcp:9860 tcp:9860，再填 127.0.0.1:9860。 | 第 2 节 |
| 能连到这个地址 | 桌面端、PyCharm、VS Code | 电脑和手机要在同一个 Wi-Fi，地址和端口以手机首页「开发者地址」为准；访客网络可能开了设备隔离，VPN / 代理也可能拦住局域网地址。也可以改用 USB。<br>PyCharm / VS Code：电脑和手机要在同一个 Wi-Fi，地址和端口以手机首页「开发者地址」为准；访客网络可能开了设备隔离，VPN / 代理也可能拦住局域网地址。用 127.0.0.1 时要先 adb forward tcp:9860 tcp:9860（模拟器或 adb 重启后要重新转发）。 | 第 4 节 |
| XScript App 在响应 | 桌面端、PyCharm、VS Code | 打开手机上的 XScript，首页「开发者地址」应显示地址而不是「服务未启动」；全新安装要先允许通知权限。省电策略可能把它冻结了。端口不是 9860 时以首页显示为准。 | 第 1 节 |
| 对方是 XScript | 桌面端、PyCharm、VS Code | 这个端口上不是 XScript（可能是别的程序占了端口）：核对端口，并把 App 升级到与电脑端匹配的版本。 | 第 6 节 |
| 配对码 | 桌面端、PyCharm、VS Code | 连接后在设备卡片上输入手机首页「开发与连接 → 配对码」显示的配对码。<br>PyCharm / VS Code：手机开了配对：连接时会弹出输入框，输入手机首页「开发与连接 → 配对码」显示的配对码。 | 第 5 节 |

<!-- END generated: connect-check -->
