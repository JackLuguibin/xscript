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
