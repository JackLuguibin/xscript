# UI 设计器：桌面端

状态：草稿计划（docs/plans）。逐步实现，每步一个小提交，推送到同一个草稿 PR；全部完成前不合并。

## 依据

- VS Code 扩展和网页 IDE 已有 `*.ui.json` 设计器，共用 `android/app/src/main/assets/tools/ui-form.js`（模型、校验、生成 HTML/Python）和 `ui-designer.js`（设计器视图）。见 [ui-designer-device-webide.md](ui-designer-device-webide.md)。
- 桌面端工程页能打开、编辑、保存设备上的文件，但打开 `.ui.json` 只是一段 JSON 文本。

## 范围

- 桌面端工程页打开 `res/ui/<name>.ui.json` 时显示设计器（控件面板、排序、属性、预览），保存时和其他设计器一样写三份文件（`.ui.json`、`res/ui/<name>.html`、`ui_<name>.py`）。
- 生成结果与 VS Code / 网页 IDE 逐字节一致（同一份核心）。
- 不改设备端协议，不新增 RPC：用现有的 `project.write`。

## 分步清单

- [x] **D.1 引入共享核心**：`desktop/frontend/src/vendor/ui-form.js`（原样复制）+ 类型入口 `src/ui-form.ts`；`tests/ui-form.test.ts` 在副本和源文件不一致时失败，并验证生成结果
- [x] **D.2 只读预览**：工程页打开 `.ui.json` 时在编辑器旁显示表单预览（用 `renderHtml`，放进 sandbox iframe，不执行脚本）；JSON 有错时显示 `validateSpec` 的问题
- [x] **D.3 设计器视图**：直接复用共享的 `ui-designer.js`（`src/vendor/ui-designer.js`，与 VS Code / 网页 IDE 同一份，测试防漂移），在「设计 / JSON」两种视图间切换，文本始终是唯一来源
- [x] **D.4 保存生成文件**：保存 `.ui.json` 时用 `outputs()` 一并写入 HTML 和 Python（有未保存修改时的确认与其他文件一致）；「新建界面」入口
- [x] **D.5 真机验证**：在模拟器 XS_Verify_API34 的 perf 应用上运行生成的 `ui_<name>.py`，填表并读回值。2026-10-21 用 `scripts/device_ui_designer_e2e.py emulator-5556 http://127.0.0.1:19861`（perf 应用 0.5.0，需悬浮窗权限）跑通 15 项：8 种控件填写、提交返回值和类型、取消返回 None、`show(values)` 预填。桌面端写出的文件来自 `src/vendor/ui-form.js`，`tests/ui-form.test.ts` 保证它与这里用的生成器逐字节一致
- [x] **D.6 文档与截图**：使用手册「界面设计器」、功能对照、桌面端设计 1.3、`desktop/README.md` 浅色/深色截图

## 测试计划

- 每步 vitest（jsdom）覆盖；D.2 起检查 iframe 有 `sandbox` 且不含 `allow-scripts`。
- D.4 断言写入的三份文件与 `outputs()` 一致，和 VS Code 单测用同一个 spec 对照。
- D.5 只上传/删除自己的测试工程。

## 风险

- 共享核心是 UMD 脚本：页面里挂到 `window.XSUiForm`，vitest 里走 `module.exports`；`src/ui-form.ts` 两种都处理。
- 预览 HTML 来自工程文件，必须放在无脚本的 sandbox iframe 里，不能进主页面 DOM（桌面端页面能调本机 RPC）。
