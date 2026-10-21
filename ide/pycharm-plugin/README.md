# XScript：PyCharm 插件

> **English:** see [README.en.md](README.en.md).

在 PyCharm（2024.2 及以上，社区版和专业版都行）里把 XScript / AScript 风格的工程上传到 Android 手机运行、停止、看实时日志，并为 `xscript.*` / `ascript.*` 提供补全。功能与 [VS Code 扩展](../vscode-extension/README.md)的上传运行、日志、补全、新建工程一致；断点调试暂时只有 VS Code 扩展和网页 IDE 有（原因见 [计划](../../docs/plans/pycharm-plugin.md)）。

通过设备 HTTP API（`protocol/openapi.yaml`，默认端口 9860）通信。只指向可信网络中的手机，或用 `adb forward tcp:9860 tcp:9860` 指向 `127.0.0.1`。

![运行后底部 XScript 工具窗口实时输出日志](../../docs/images/pycharm-run.png)

![Settings → Tools → XScript：设备地址、配对码和运行选中代码超时](../../docs/images/pycharm-settings.png)

![选中一行按 Ctrl+Alt+Shift+E：代码和设备返回的结果显示在 XScript 工具窗口](../../docs/images/pycharm-eval.png)

![「设备工程」标签页：手机上的工程列表，正在运行的 daily_signin 有标记，左侧是刷新 / 运行 / 停止 / 拉取](../../docs/images/pycharm-projects.png)

![Pull Project from Device：选择设备上的工程、确认覆盖后，拉取的文件出现在编辑器和工程树里，日志列出新增 / 更新数量](../../docs/images/pycharm-pull.png)

（沙盒 PyCharm 2024.2.6，连接本机模拟设备 `scripts/mock_device.py`，结果是模拟数据。）

## 安装

插件不上架 JetBrains Marketplace。版本号与 App 相同，从 v0.4.0 之后的下一个 Release 起附带 `xscript-pycharm-<版本>.zip`（校验值在 `SHA256SUMS` 里）。也可以：

- 下载 CI 产物：在 GitHub Actions 的 `ci` 运行里下载 artifact **xscript-pycharm-plugin**（一个 zip）；
- 或自己构建（需要 JDK 17 以上；Gradle 会把 JDK 21 下载到 `~/.gradle`）：

```bash
cd ide/pycharm-plugin
./gradlew buildPlugin            # 生成 build/distributions/xscript-pycharm-<版本>.zip
```

然后在 PyCharm 里 **Settings → Plugins → ⚙ → Install Plugin from Disk…**，选这个 zip（不用解压）。

## 使用

菜单 **Tools → XScript**，以及底部的 **XScript** 工具窗口：

| 动作 | 快捷键 | 作用 |
| --- | --- | --- |
| Upload and Run on Device | Ctrl+Alt+Shift+R；编辑器、项目视图右键 | 先停止手机上正在运行的脚本，再上传当前文件所在的工程并运行，日志实时显示在 XScript 工具窗口。只发送上次从本 IDE 上传后新增或改动的文件（设备上文件大小 + 本地内容哈希，与 VS Code 扩展规则一致），日志里会显示跳过了几个 |
| Upload All and Run on Device | | 与上一项相同，但重新发送所有文件（手机上改过工程后用） |
| Stop Script on Device | | 停止手机上正在运行的脚本 |
| XScript 工具窗口 →「设备工程」 | | 列出手机上的工程，正在运行的那个有标记；选中后可 **在设备上运行**（不上传，直接运行手机上的版本）、**停止**、**拉取到本工程**；第一次打开这个标签页时加载，之后点「刷新」 |
| Pull Project from Device… | | 从设备列出的工程中选一个下载：IDE 工程（或其下的子文件夹）与设备工程同名时直接拉到那里，否则选一个文件夹，在其下新建同名子文件夹。只写入新增和不同的文件；会覆盖本地修改时先列出文件请你确认；设备上没有的本地文件保留不动 |
| Run Selection on Device | Ctrl+Alt+Shift+E；编辑器右键 | 把选中的代码（没选中时为光标所在行）发到手机的 eval 进程执行，结果打印在 XScript 工具窗口；要看某个值就赋给 `_result`；超时默认 8 秒，可在设置里改（200–15000 毫秒） |
| Connect to Device… | | 填写手机地址（`IP[:端口]`），并测试连接 |
| New XScript Project… | | 选模板（与 VS Code 扩展、网页 IDE、手机 App 同一套 7 个模板），生成 `__init__.py`、`build.as`、`res/` |
| Enable / Disable XScript Completion | | 把插件自带的存根作为模块库 “XScript stubs” 加入或移除 |
| XScript Settings… | | 打开 **Settings → Tools → XScript** |

- **工程**：当前文件之上、含有 `__init__.py` 或 `build.as` 的最顶层文件夹；文件夹名就是手机上的工程名。上传时跳过隐藏文件、`__pycache__`、`.pyc`、虚拟环境，并遵守 `.vscode/.syncignore`（与 VS Code 扩展同一个文件）。
- **配对码**：手机默认需要配对码（XScript 首页「开发与连接 → 配对码」）。第一次遇到 401 时插件会弹窗询问，保存在 IDE 的密码库（macOS 钥匙串等），也可以在设置页填写。按设备地址分别保存。
- **补全**：打开像 XScript 工程的项目时，插件会提示「启用 XScript 补全」。它只是把插件目录里的 `stubs/`（由 `scripts/gen_stubs.py` 生成，与 VS Code 扩展内置的是同一份）加为模块库，不往工程里复制任何文件；关闭时移除这个库。

## 开发

```bash
cd ide/pycharm-plugin
./gradlew test                   # JUnit + 无界面 PyCharm 平台测试；设备客户端测试会启动 scripts/mock_device.py（需要 python3）
./gradlew buildPlugin verifyPlugin   # 插件 zip；Plugin Verifier 对 PyCharm 2024.2.6 和 2025.1.6 检查（内部 API 也算失败）
./gradlew runIde -PrunIdeProject=/path/to/project   # 沙盒 PyCharm（.intellijPlatform/sandbox），不影响本机已装的 IDE
```

- 新建工程模板 `src/main/resources/templates.json` 是生成的：改 `ide/vscode-extension/src/newProject.ts` 后，在 `ide/vscode-extension` 里 `npm run compile && node scripts/export-templates.js`。CI 用 `--check` 检查。
- 截图：先在 `.intellijPlatform/sandbox/xscript-pycharm/PC-2024.2.6/config_runIde/options/xscript.xml` 里把设备地址设为本机 mock 设备，再 `./gradlew runIde -PrunIdeProject=<演示工程> -PrunIdeHeadlessConsent -PrunIdeScreenshotDemo=run -PrunIdeScreenshotOut=<目录>`（模式还有 `settings`、`eval`、`pull`、`projects`）。这些开关只用于这个一次性的沙盒：跳过用户协议，打开演示工程，执行对应功能（`pull` 会自动按下选择和覆盖对话框的默认按钮；演示工程里要有与设备工程同名的文件夹），约 25 秒后把 IDE 窗口（有对话框时截对话框）存成 `<目录>/<模式>.png`，不需要系统录屏权限。
- 本机没有系统 JDK 时可以用 Android Studio 自带的：`JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`。
