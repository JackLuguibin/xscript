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
- [ ] **F.5 新建工程**：模板与 VS Code 扩展、手机 App 同一套
- [ ] **F.6 调试（可选）**：接 DAP（若 PyCharm 社区版接口允许），否则记录不可行原因
- [ ] **F.7 文档**：中英 README、截图

## 测试计划

- CI：`./gradlew test buildPlugin verifyPlugin`；客户端测试对 mock 设备。
- 手动：用 CI 产物在本机 PyCharm 安装（需要用户确认），连接模拟器 perf 应用跑一次。

## 风险

- 本机无 JDK，开发迭代依赖 CI。
- IntelliJ 平台版本兼容范围要定（建议 2024.2+）。
