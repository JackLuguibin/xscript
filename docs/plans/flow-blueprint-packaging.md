# 流程蓝图：打包到其他设备运行 / 调试，并完善蓝图设计

状态：草稿计划（docs/plans），对应 issue #280。逐阶段实现，每阶段一个或几个小提交，推送到同一个草稿 PR；全部完成前不合并。

## 范围

- **打包**：桌面端编好的流程蓝图能导出成一个**流程包**（单个文件），在另一台电脑上导入，推到任意已配对 / 已连接的设备上运行；在那台设备上运行出错时，traceback 仍能反查到节点；也能在那台设备上按节点断点调试。
- **蓝图设计完善**：补上现在缺的基础能力——流程能存成本机文件、重开不丢；能从设备工程读回流程；选中节点的对齐 / 等距分布；未保存提示。
- 不做：
  - 新的 DSL 语法、新节点类型；编译器语义变化（`dsl.ts` 的编译结果不变，只是换个方式交付）。
  - 加密 / 签名流程包（包里本来就是可执行的 Python，校验只防截断和误改，不防篡改；来源可信由用户自己判断，导入时显示来源信息）。
  - 云控后台的版本部署（已有 `CloudDeploy.tsx`，走后台分组下发，见 P4.5）；本计划只做**本机直连**设备。
  - 把资源文件（图片模板、模型）打进包——第一版只包含 `deployPlan` 生成的文件，资源随后单独评估（见「风险」）。
  - 把流程编译成 APK（云控「打包」页已有 APK 打包任务）。

## 依据

- `desktop/frontend/src/flow/deploy.ts`：`deployPlan` 已能把流程编译成设备工程的文件（`flows/<name>.py` 带 `__xf_trace`、`.xflow`、`.xflow.map.json`、`.xflow.layout.json`、入口桩 `__init__.py`），`pushPlan` 写到**一台**设备，且只覆盖入口是本编辑器桩的工程。但这些文件只存在于内存和那台设备上，没有能带走的形式。
- `desktop/frontend/src/components/FlowPage.tsx` `runOnDevice`：只推到顶栏的**当前设备**（`useSharedDevice()` 的 `devId`），不能选别的设备，也不能一次推多台。
- `desktop/frontend/src/flow/draft.ts`：正在编辑的流程「只在内存里，这个窗口有效」——关掉桌面端流程就没了；`deploy.ts` 注释也写明「设备副本是从编辑器运行的流程的唯一副本」。流程页没有打开 / 保存文件，也没有接 `app.setUnsaved`（工程页接了）。
- `desktop/README.md`「流程编辑器（P2 部分）」：「本地调试」只在本机模拟回放 trace；「在设备上运行」只跟随日志和反查 traceback，**没有在设备上按节点断点暂停**。断点调试（`services/debugger.py`、`DebugPanel.tsx`）已经能经 `/projects/{name}/debug` 驱动设备上的 debugpy，但只按文件行，不认识节点。
- `desktop/frontend/src/flow/map.ts`：source map 有 行 → 节点 和 节点 → 行 两个方向，足够把节点断点翻成行断点、把暂停行翻回节点。
- `desktop/app/xscript_desktop/dialogs.py`：已有系统「保存文件」对话框（诊断包、截图在用），页面不能指定路径，新导出可复用同样的模式。
- `desktop/frontend/src/components/CloudDeploy.tsx`：多设备结果表（成功 / 失败 / 原因）的样式可复用到本机批量推送。
- `desktop/README.md`「没做」：流程编辑器剩余部分只列了状态机回退的限制；打包、跨设备、文件存取都还没在路线图里落地。

## 分阶段清单

### B 打包与跨设备运行 / 调试

- [x] **B.1 流程包格式**（本 PR 第一步）：`src/flow/bundle.ts`。`packBundle(plan, meta)` 把 `deployPlan` 的文件包成一个 JSON 文本（`format: "xscript-flow-bundle"`、`version: 1`、`project`、`createdAt`、`app`、每个文件带 UTF-8 `size` 和 FNV-1a 32 校验），扩展名 `.xflowpkg`；`readBundle(text)` 严格校验后还原成可直接交给 `pushPlan` 的 plan，以及画布要用的 graph / layout / source map。校验：格式与版本（更新的版本拒绝）、工程名、只允许 `deployPlan` 会写的路径且不重复、总大小上限 8 MB、大小与校验和、必需文件齐全、入口必须**正好**是编辑器桩（推过去后 `pushPlan` 仍认得是编辑器工程）、`.xflow` 能解析且名字等于工程名、source map 指向 build、layout 结构正确。不抛异常，错误带原因和细节。纯函数，无 UI。
- [ ] **B.2 导出流程包**：流程页工具栏「导出流程包…」→ 新 RPC `flow.saveBundle`（Python 用系统保存对话框写文件，默认名 `<流程名>.xflowpkg`，页面不能指定路径；大小上限同上）。编译失败 / 名字不合法时给出与「在设备上运行」相同的提示。
- [ ] **B.3 导入流程包**：「导入流程包…」→ RPC `flow.openBundle`（系统打开对话框，读文本，超限拒绝）→ `readBundle` → 显示来源（工程名、创建时间、桌面端版本）并确认后在画布打开（替换当前流程前走未保存确认，见 D.2）。错误按原因给中英文提示。
- [ ] **B.4 选择运行目标**：「在设备上运行」旁加目标设备下拉（本机已连接的在线设备，默认顶栏当前设备），`pushPlan` + 运行 + 跟随日志都对选中的设备；traceback 反查用当次推送的 source map。
- [ ] **B.5 批量推送**：勾选多台在线设备，逐台 `pushPlan`（可选「推送后运行」），结果表列出每台的成功 / 拒绝覆盖他人工程 / 失败原因；一台失败不影响其它台。
- [ ] **B.6 从设备读回流程**：列出设备上入口是编辑器桩的工程，读回 `.xflow` + `.xflow.layout.json` 在画布打开——设备副本不再是死副本，换一台电脑也能接着编辑。
- [ ] **B.7 设备上按节点调试**：在选中的设备上「调试运行」：复用 `debug.start`，用 source map 把画布上的节点断点翻成 `flows/<name>.py` 的行断点；暂停时把行翻回节点并在画布高亮，变量面板显示 Locals；继续 / 单步 / 停止复用调试工具栏。
- [ ] **B.8 兼容提示**：包里记录用到的节点类型；推送前对比设备 `/status` 的 App 版本，节点在该版本不可用时提示（不阻止）。

### D 蓝图设计完善

- [ ] **D.1 本机保存 / 打开流程文件**：「保存」（⌘/Ctrl+S）/「另存为」/「打开」，写 `<名>.xflow` 和旁边的 `<名>.xflow.layout.json`；记住最近打开的文件，启动时恢复上次的流程。
- [ ] **D.2 未保存提示**：流程有改动未保存时接 `app.setUnsaved`，关窗、打开别的流程、导入包前确认。
- [ ] **D.3 对齐与分布**：选中多个节点时可左 / 右 / 上 / 下对齐、水平 / 垂直等距分布（进撤销历史）。
- [ ] **D.4 文档与截图**：`desktop/README.md` 流程编辑器一行和「没做」更新，`docs/桌面端设计.md` 补流程包格式；导出 / 导入 / 目标设备 / 对齐的界面截图（浅色 + 深色）。

## 测试计划

- `desktop/frontend` vitest：
  - B.1：打包 → 读回得到相同的 plan、graph、layout、map；读回的 plan 交给 `pushPlan` 写到假设备的结果与编辑器自己的 plan 一致；每种拒绝原因各有用例（坏 JSON、格式、版本、工程名、越界 / 反斜杠 / 未知路径、重复、截断与改动、超限、缺文件、入口被改、`.xflow` 坏或改名、source map / layout 坏）；FNV-1a 用公开测试向量核对。
  - B.2–B.7：对话框和 RPC 用 demo 传输打桩；目标设备切换、批量推送部分失败、节点断点 ↔ 行断点互译都有组件 / 单元测试。
  - D.1–D.3：保存 / 打开往返、未保存状态、对齐分布与撤销。
- `desktop/app` pytest：`flow.saveBundle` / `flow.openBundle` 的路径来自对话框、大小上限、取消对话框。
- B.7 用 `app/tests/fake_debug_device.py` 的脚本化 debugpy 做 e2e；真机 / arm64 模拟器验证只用 `com.xscript.app.perf`。
- 前端 type-check、coverage 门槛（lines/statements 85、functions 80、branches 75）不降；已有用例不变。

## 风险

- 包里是可执行代码：校验只防误改，不防恶意包。导入时展示来源并需要确认；推送仍受 `pushPlan` 的「不覆盖他人工程」保护。
- 设备 App 版本不同：老版本设备上缺节点运行时会失败（B.8 只提示，不能完全避免）。
- 资源文件：引用了图片模板 / 模型的流程，只推包会在新设备上找不到资源；第一版在文档里说明，之后再评估把引用到的 `res/` 文件打进包（需要扩展白名单和大小上限）。
- 自定义节点 / 函数：编译结果已内联在 build 里，但在另一台电脑上导入后重新编辑，需要那台电脑也有同样的自定义定义；B.3 打开时如有未知节点要标出来。
