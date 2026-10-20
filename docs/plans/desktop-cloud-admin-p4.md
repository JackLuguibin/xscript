# 桌面端 P4：云控与管理

状态：草稿计划（docs/plans）。逐阶段实现，每阶段一个或几个小提交，推送到同一个草稿 PR。

## 范围

- 桌面端接入后台 `xscript_server`：登录 / 令牌（存系统凭据库）、设备群表、批量命令、实时缩略图、日志检索、服务端任务、把流程部署到分组、内嵌后台页和打包页。
- 权限：operator / viewer 在桌面端按后台角色灰显，不在客户端另做一套权限。
- 不做：新的后台接口（优先复用 `/api/*` 现有路由），手机端改动。

## 依据

- `desktop/README.md`「没做」：云控与后台（P4）。
- `docs/桌面端设计.md` §12.1：P4 = 后台登录/令牌、设备群表、批量命令、HTTP 转发、实时缩略图、日志检索、服务端任务、部署流程到分组、内嵌后台页、打包页，3–4 人周；验收「登录→批量运行→部署→看日志；operator/viewer 权限正确灰显」。
- 已有基础：`desktop/app/xscript_desktop/services/secrets.py`（keyring 凭据，W-16）、`backend/xscript_server/routes/{devices,tasks,scripts,pack}.py`。

## 分阶段清单

- [x] **P4.1 后台连接**：「云控」页填后台地址 + API 令牌（后台「账号 → API 令牌」创建；bearer 只认 api 令牌，不走密码登录），令牌只进 keyring（`backend/<origin>`），换后台即删旧令牌；`/api/auth/me` 取角色，拒绝代理商账号；令牌失效 / 连不上分别提示；服务层 `services/backend_client.py`（错误码映射、消息里抹掉令牌）+ `tests/fake_backend.py` 假后台单测；前端 `CloudPage` + 演示后台 `cloud-demo.ts`
- [ ] **P4.2 设备群表**：后台设备列表（在线、分组、标签、版本），筛选和多选；只读
- [ ] **P4.3 批量命令**：对选中设备运行 / 停止脚本，结果逐台汇总；viewer 灰显
- [ ] **P4.4 日志与任务**：日志检索、服务端定时任务列表和编辑
- [ ] **P4.5 部署流程到分组**：把编译好的流程打包成脚本版本发布到分组，可回滚
- [ ] **P4.6 缩略图 / 内嵌后台页 / 打包页**：实时缩略图墙、内嵌后台网页（同源令牌）、APK 打包页
- [ ] **P4.7 收尾**：中英文档、截图、端到端验收（本地后台 + 模拟器 perf 应用）

## 测试计划

- 每阶段：pytest（假后台，`-o required_plugins=`）+ 前端 vitest；Windows CI 作业同样跑。
- 端到端：本地起 `xscript_server`（演示数据、无真实密钥）+ API34_4k 上的 `com.xscript.app.perf`：登录→批量运行→部署→看日志；用 viewer 账号检查灰显。
- 安全：令牌只进 keyring，不进日志 / SQLite / RPC 应答（沿用 secrets 的测试方式）。

## 风险

- 后台接口变化需要和 `protocol/openapi.yaml` 同步。
- 缩略图流量：沿用屏幕墙的节流参数。
