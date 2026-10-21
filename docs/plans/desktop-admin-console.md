# 桌面端：后台管理功能集成（#219）

状态：草稿计划（docs/plans）。逐步实现，每步一个或几个小提交，推送到同一个草稿 PR；全部完成前不合并。

## 依据

- #219「后台管理功能也要集成在桌面端」。
- 已有基础：P4 云控（[desktop-cloud-admin-p4.md](desktop-cloud-admin-p4.md)）已经在桌面端「云控」页做了后台连接（API 令牌存 keyring）、设备表、批量命令、实时画面、日志、定时任务、部署流程到分组、打包任务列表；其余后台页面目前只能在「后台网页」分区里**用系统浏览器打开**。
- 网页后台 `backend/web/src/pages/` 还有、桌面端没有的：概览（`Overview`）、设备详情抽屉（`devices/DeviceDrawer`、`DeviceRuns`：改备注 / 分组、删除、最近运行、导出日志）、设备密钥（`DeviceKeys`）、小程序与版本（`Scripts`、`scripts/DeployModal`）、运营公告（`AppOps`）、卡密（`Cards`）、代理与结算（`Resellers`、`resellers/Settlement`）、用户（`Users`）、审计（`Audit`）、系统设置与维护（`Settings`）、账号（`Account`：密码、两步验证、会话、API 令牌）、新建打包与打包机（`pack/PackForm`、`pack/Workers`）、AI 写脚本（`AiWriter`）、代理商自己的控制台（`reseller/ResellerHome`）。

## 做法（沿用 P4 的约定）

- **原生界面，不内嵌网页**：每个管理分区在桌面端「云控」页用 React 组件重做，复用桌面端已有的 `ui/*` 组件、设计令牌、浅 / 深色主题，保持和其他页面一致。不把后台网页塞进 QWebEngineView：网页用自己的 cookie 会话和 CSRF，桌面端页面也不能自己联网（CSP），令牌不能进网页（P4.6 已定）。
- **所有请求走 Python**：`services/backend_client.py` 加对应函数（只回传界面需要的字段、错误码映射、消息里抹掉令牌），`context.py` 加 `cloud.*` RPC，前端 `api.ts` + `cloud-demo.ts`（演示后台）。
- **只用后台已有的 `/api/*` 路由**，不新增后台接口；权限按 `/api/auth/me` 的角色灰显（viewer / operator / admin），后台本身仍然做最终校验（403 时提示原因）。
- **高风险操作放最后，且每一步单独评估**：用户管理、系统设置、维护、卡密离线授权、打包机等是 admin 操作；API 令牌不经过网页登录的「管理员必须开启两步验证」检查（`deps.py` 只对 `via == "web"` 检查），所以这些分区先只读，写操作要不要放到桌面端在对应步骤里再定（不行就保留「在浏览器打开」）。
- 代理商（reseller）账号目前被桌面端拒绝连接，保持不变，代理控制台不在本计划里。

## 分步清单

- [ ] **M.1 概览（只读）**：「云控」新增「概览」分区，读 `GET /api/overview`：在线 / 运行中 / 设备总数 / 24 小时活跃、定时任务（总数 / 启用）、打包（排队 / 进行中）、小程序（总数 / 已发布）、24 小时告警数、24 小时崩溃数、最近备份时间；手动刷新；viewer 可用。服务层只回传这些数字
- [ ] **M.2 概览趋势**：`GET /api/stats/daily`（7 / 30 天）的激活、到期、新设备、在线设备折线（不引入图表库，用 SVG）
- [ ] **M.3 设备详情**：设备表点一行打开详情侧栏：基本信息（`GET /api/devices/{id}`）、改备注 / 分组（`PATCH`，operator+）、批量改分组（`POST /api/devices/batch-group`）、删除设备（`DELETE`，确认框）、导出日志（`/logs/export`，系统保存对话框）
- [ ] **M.4 小程序与版本**：列表、详情、版本历史、上传新版本（选本地文件夹打 zip，沿用 P4.5 的打包与路径校验）、发布 / 取消发布 / 删除版本（admin，确认框）、查看版本源码（operator+，只读）
- [ ] **M.5 运营**：App 公告 `/api/app-notices` 列表、新建、修改、删除（operator+）；App 更新 `/api/app-updates` 列表（viewer）、设置 / 删除（admin）
- [ ] **M.6 设备密钥**：`/api/device-keys` 列表、新建（只显示一次，复制到剪贴板）、吊销、删除
- [ ] **M.7 卡密（只读起步）**：统计、批次、卡密列表筛选、封禁列表；之后再评估生成批次 / 延期 / 封禁 / 导出（operator+）和离线授权（admin）
- [ ] **M.8 新建打包与打包机**：在「打包」分区加新建打包表单（应用名、包名、图标、签名选项，和网页 `PackForm` 一致）；打包机 `/api/pack/workers` 列表与启用 / 停用（admin）
- [ ] **M.9 审计（只读，admin）**：`GET /api/audit` 按用户 / 动作 / 时间筛选、翻页
- [ ] **M.10 账号**：当前账号信息、自己的 API 令牌列表与吊销（不能吊销桌面端正在用的那个，或吊销后回到连接页）；改密码 / 两步验证 / 会话管理仍在网页里做
- [ ] **M.11 用户、代理与结算、系统设置（admin）**：先只读；写操作按上面的「高风险操作」原则逐项评估
- [ ] **M.12 AI 写脚本**：`/api/ai/status`、生成、保存为小程序版本（operator+；后台没配置模型时提示）
- [ ] **M.13 收尾**：「后台网页」分区只保留桌面端还没有的页面；中英文档、浅色 / 深色截图（演示数据）；端到端脚本 `scripts/desktop_cloud_e2e.py` 加上新分区（本地后台 + 模拟器 perf 应用）

## 测试计划

- 每步：pytest（`tests/fake_backend.py` 假后台 / ASGI 真后台，`-o required_plugins=`）覆盖服务层字段裁剪、错误码、令牌不进应答；前端 vitest 覆盖渲染、角色灰显、确认框、错误提示；Windows CI 作业同样跑。
- 改了界面的步骤更新 `desktop/README.md` 里的截图（演示后台数据，不用真实数据）。
- 端到端：本地起 `xscript_server`（演示数据、无真实密钥）+ 模拟器上的 `com.xscript.app.perf`；分别用 viewer / operator / admin 令牌检查灰显。

## 风险

- 后台接口变化需要和 `protocol/openapi.yaml`、桌面端服务层同步（服务层单测用真实后台 ASGI 应用跑一遍可以早发现）。
- API 令牌绕过网页登录的两步验证要求：admin 写操作放到桌面端前要先评估（见上）。
- 云控页分区变多：分区按「日常操作 / 管理」分两组，避免一排按钮太长。
