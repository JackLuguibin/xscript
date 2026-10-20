# UI 设计器：真机验证 + 网页 IDE 复用

状态：草稿计划（docs/plans）。逐阶段实现，每阶段一个或几个小提交，推送到同一个草稿 PR。

## 范围

- VS Code 扩展里的 `*.ui.json` 设计器（8 种表单控件、拖拽排序、属性面板、预览，生成 `res/ui/<name>.html` 和 `ui_<name>.py`）在设备上跑通：`show()` 弹出界面、读到填写的值。
- 把表单模型和生成器抽成与宿主无关的 JS，网页 IDE 复用同一份设计器（打开 `.ui.json` 时显示设计器）。
- 设备验证只用模拟器上的 `com.xscript.app.perf`，不安装 / 卸载。

## 依据

- `docs/功能对照.md` UI 设计器行：第一版在 VS Code 扩展里，「单测和 VS Code 宿主测试通过，还没在真机上点过；网页 IDE 和桌面端还没有」。
- `docs/路线图.md` UI 设计器：🚧 第一版（2026-10）。
- 代码：`ide/vscode-extension/src/{uiDesigner,uiForm,uiFiles}.ts`。

## 分阶段清单

- [x] **E.1 设备验证脚本**：`scripts/device_ui_designer_e2e.py`：用现有生成器生成一个设置界面，上传到 perf 应用，运行，uiautomator 填表并提交，读运行日志里的返回值；修复发现的问题
- [x] **E.2 抽出共享核心**：`uiForm` 的模型、校验、HTML/Python 生成改为无依赖 JS（`android/app/src/main/assets/tools/ui-form.js`），VS Code 扩展改为引用它（构建时复制，`--check` 防漂移）
- [ ] **E.3 网页 IDE 设计器**：网页 IDE 打开 `.ui.json` 时显示设计器（控件面板、拖拽排序、属性、预览），保存生成两份文件
- [ ] **E.4 文档与截图**：使用手册、功能对照、截图

## 测试计划

- E.1：模拟器 API34_4k + perf 应用（只上传 / 删除自己的测试工程），记录 PASS 列表。
- E.2：VS Code 扩展现有单测不变；新共享模块 Node 单测；生成结果和旧实现逐字节一致。
- E.3：headless Chrome DOM 测试（mock 设备）。

## 风险

- perf 应用版本较旧（签名不同，不能更新），若缺接口则只记录，不升级。
