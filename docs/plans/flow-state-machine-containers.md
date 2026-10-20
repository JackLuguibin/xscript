# 流程编译：状态机回退支持 retry / try / parallel / match / wait_until / sequence

状态：草稿计划（docs/plans）。逐阶段实现，每阶段一个或几个小提交，推送到同一个草稿 PR。

## 范围

- 流程图有回边或非结构化汇合时，编译器走状态机回退（`compileState`：`pc` + `while True`）。目前它只认 `for_range` / `for_each` / `while` 循环和单出口节点，遇到 `flow.match`、`flow.try`、`flow.parallel`、`flow.wait_until`、`flow.retry`、`flow.sequence` 就报错「state machine cannot lower …」。
- 目标：这些容器在状态机模式下也能编译，语义和结构化模式一致（结构化模式已支持，2026-10-16）。
- 不做：DSL 语法变化、新节点。

## 依据

- `desktop/README.md`「没做」：状态机回退仍不能整体降级 retry / try / parallel / match / wait_until 这类多出口容器，也不能降级循环体跳到外面的循环。
- `desktop/frontend/src/flow/dsl.ts` `compileState`：`STATE_EXIT` 只有三种循环，其它多出口节点抛 `state machine cannot lower <type>`。
- 结构化编译已有这些节点（`compileBlock` 里的 `flow.match` / `flow.try` / `flow.parallel` / `flow.wait_until` / `flow.retry` 分支），可以复用。

## 分阶段清单

- [x] **C.1 match / sequence**：`match` 降级为 `if/elif/else` 设置 `pc`；`sequence` 依次跑每条线（子块结构化时内联），然后到 `next`
- [x] **C.2 wait_until / retry**：容器体能结构化时，整个容器作为一个状态内联（复用结构化发射），出口设置 `pc`
- [ ] **C.3 try / parallel**：同上：体内无跳出的回边时整体内联；体内有跳出时给出清楚的错误（指出节点和引脚）
- [ ] **C.4 循环体跳出**：循环体里跳到循环外的回边：把循环本身也降级为状态（计数器变量 + 状态），保持 break/continue 语义
- [ ] **C.5 文档**：`desktop/README.md` 「没做」更新，设计文档 §8.8.4 标注

## 测试计划

- `desktop/frontend` vitest：每种容器在「强制走状态机」的图上编译，生成的 Python 用本机 `python3` 执行（打桩 `xscript.android`），对比结构化编译的执行轨迹一致。
- 已有用例全部不变（`flow-compile-run.test.ts` 等）。
- 前端 type-check、coverage 门槛不降。

## 风险

- `parallel` 在状态机里只能整体内联（线程里不能跳回主状态机）。
