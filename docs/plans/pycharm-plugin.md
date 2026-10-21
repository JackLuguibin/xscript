# PyCharm 插件

状态：草稿计划（docs/plans）。逐阶段实现，每阶段一个或几个小提交，推送到同一个草稿 PR。

## 范围

- 和 VS Code 扩展功能一致的 PyCharm / IntelliJ 插件：连接设备（地址 + 配对码）、上传并运行当前工程、停止、实时日志、补全（复用 `ide/python-stubs`）、新建工程模板。调试（DAP）放最后一个阶段。
- 实现：Kotlin + IntelliJ Platform Gradle Plugin 2.x，放在 `ide/pycharm-plugin/`。
- 不做：发布到 JetBrains Marketplace（需要用户批准和账号）。

## 依据

- `docs/功能对照.md`：PyCharm 插件 ❌ 没有，「工作量中；补全存根已经能给 PyCharm 用」。
- `docs/路线图.md`：PyCharm 插件，上传运行、日志、补全，和 VS Code 插件功能一致，工作量中。
- 本机没有 JDK（`java -version` 找不到运行时），构建和测试放在 CI（ubuntu + temurin 17）。

## 分阶段清单

- [x] **F.1 脚手架**：Gradle 工程、`plugin.xml`、CI 作业（buildPlugin + test + verifyPlugin），产物作为 artifact
- [x] **F.2 设备客户端**：Kotlin HTTP 客户端（`/status`、配对、文件同步、运行/停止），单测对 `scripts/mock_device.py`
- [x] **F.3 工具窗口和动作**：设备设置、运行/停止动作、日志工具窗口
- [x] **F.4 补全和存根**：把 `ide/python-stubs` 作为外部库加入解释器路径（不复制，提示用户）
- [x] **F.5 新建工程**：模板与 VS Code 扩展、手机 App 同一套
- [x] **F.6 调试（可选）**：不做，原因见下面「调试为什么不做」
- [x] **F.7 文档**：中英 README、截图

## 测试计划

- CI：`./gradlew test buildPlugin verifyPlugin`；客户端测试对 mock 设备。
- 手动：用 CI 产物在本机 PyCharm 安装（需要用户确认），连接模拟器 perf 应用跑一次。

## 风险

- 本机没有系统 JDK；实际用 Android Studio 自带的 JBR 25 在 Mac 上构建（Gradle 通过 foojay 把 JDK 21 下载到 `~/.gradle`，不装到系统），CI 用 temurin 21。
- 兼容范围定为 PyCharm 2024.2+（since-build 242，不设上限）；Plugin Verifier 对 2024.2.6 和 2025.1.6 检查。

## 调试为什么不做（F.6）

手机端调试是 debugpy（DAP 协议），经设备 HTTP 桥（`/projects/{name}/debug`、`/debug/*`）转发。PyCharm 的 Python 调试器用的是 pydevd 自己的协议，不是 DAP；2024.2–2025.1 的 IntelliJ 平台也没有可供插件使用的通用 DAP 客户端。要在 PyCharm 里调试，只能自己实现一整套 XDebugger（断点、栈、变量、求值、单步）去翻译 DAP，工作量比 F.1–F.5 加起来还大，也难以在 CI 里测。所以先不做：需要断点调试时用 VS Code 扩展（Alt+F6）或网页 IDE。平台以后提供 DAP 客户端时再评估。

## 进度记录

- 2026-10-20：F.1–F.7 完成。
  - 插件在 `ide/pycharm-plugin/`（Kotlin，IntelliJ Platform Gradle Plugin 2.19.0，Gradle 9.3.1 wrapper），插件 ID `com.xscript.ide`（Plugin Verifier 不允许 ID 含 “pycharm”）。
  - 测试：20 个（JUnit 15 个，其中设备客户端 5 个对 `scripts/mock_device.py`，含配对；平台测试 5 个在无界面 PyCharm 里加载插件）。CI 作业 `pycharm-plugin` 跑 `test buildPlugin verifyPlugin`，产物 `xscript-pycharm-plugin`；只改插件的 PR 会跳过 Android / 桌面 / Python 作业。
  - 模板：`templates.json` 由 `ide/vscode-extension/scripts/export-templates.js` 从 VS Code 扩展生成，VS Code 作业用 `--check` 防止两边不一致。
  - 截图：在沙盒 PyCharm 2024.2.6（`./gradlew runIde`，不碰本机已装的 IDE）里连本机 mock 设备拍摄。
  - 没做：在本机正式安装的 PyCharm 里装插件（需要用户确认）；连模拟器 perf 应用跑（沙盒里用的是 mock 设备）；发布到 JetBrains Marketplace。
