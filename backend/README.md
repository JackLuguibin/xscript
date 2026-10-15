# backend：管理后台（云控 · 卡密 · 打包）

XScript 的 PC / 服务器端。这里的内容都不在手机上运行。

| 路径 | 作用 |
| --- | --- |
| `xscript_server/` | FastAPI 服务：云控设备中心（`/ws`）、命令下发、HTTP 中转与远程操控、分组、服务端定时任务、卡密（卡密、批次、在线激活 `/license/*`、离线令牌）、小程序版本（发布 / 回滚、部署到设备、为打包应用提供热更新 `/pub/update`）、代码保护、APK 打包任务队列与分享链接（`/pub/d/…`）、用户与角色、API 令牌、操作日志 |
| `web/` | React 19 + Ant Design 6 控制台（Vite）。`npm run build` 输出到 `web/dist`，由服务器在 `/` 提供 |
| `xscript_pack.py` | APK 打包命令行工具。服务器的打包任务调用它；也可在 CI 中直接使用 |
| `tests/` | 服务器测试：真实 uvicorn + 通过 WebSocket 连接的模拟设备、卡密生命周期、打包队列、角色、旧数据导入 |
| `scripts/demo.py` | 本地演示，带模拟设备和示例卡密 |

## 运行

```bash
# 在仓库根目录执行
.venv/bin/pip install -e backend                         # fastapi、uvicorn、sqlalchemy、cryptography（固定版本）
(cd backend/web && npm ci && npm run build)              # 控制台 → backend/web/dist
.venv/bin/python -m xscript_server init  --data xscript-data     # 创建首个管理员（会提示输入密码）
.venv/bin/python -m xscript_server serve --data xscript-data --port 8765
```

打开 `http://127.0.0.1:8765/`。API 文档位于 `/api/docs`。

服务器写入的所有内容都在数据目录中（`--data` 或 `$XSCRIPT_DATA`，默认 `./xscript-data`，权限 0700）：

| 文件 | 内容 |
| --- | --- |
| `xscript.db` | SQLite：用户、会话与 API 令牌（哈希存储）、设备密钥（哈希存储）、设备、任务、卡密、打包任务、操作日志、设置 |
| `keys/private.pem` | 卡密签名私钥，首次启动时生成。**务必备份**：每个启用卡密打包的应用都内置了它的公钥 |
| `pack/<job>/` | 每个打包任务上传的项目、构建日志和 APK |
| `scripts/<id>/<version>/` | 小程序版本：上传的 `source.zip`，以及由它构建、用于部署 / 热更新的包 |

其他命令行命令：`device-key --name X`（输出一个新的设备密钥）、`reset-password <user>`、`reset-allowlist`（清空登录 IP 白名单）、`import-legacy`（从旧的 `xscript_cloud.py` / `licenses.db` / `private.pem` 导入；见 `--help`）、`backup [--out file]`、`restore <file> [--force]`。

### 备份、升级与存储

- **备份**（`backups/xscript-<time>.tar.gz`，权限 0600）包含数据库的一致性副本（SQLite 在线备份，服务运行中也安全）、`keys/private.pem` 以及所有小程序的 `source.zip`。不包含 APK 和构建日志。服务器每天在 `backup_hour` 自动备份一次，保留 `keep_backups` 份（在 系统设置 → 备份与存储 中配置；也可在那里“立即备份”和下载）。请把备份拷贝到其他机器：其中包含签名私钥。
- **恢复**：先停止服务器，再执行 `python -m xscript_server --data <dir> restore <file>`（`--force` 覆盖已有数据库）。旧版本的备份会自动迁移到新结构。
- **升级**：表结构变更是 `xscript_server/migrate.py` 中编号的步骤，启动时自动应用（`PRAGMA user_version`）。来自更新版本的数据库会被拒绝，而不会被损坏。升级前请先备份。
- **数据保留** 随每日备份一起执行：已完成的打包任务中，除最新的 `keep_pack_jobs` 个以外，其余的 APK 都会删除（任务记录保留）；早于 `audit_days` 的操作日志会删除；过期超过一周的分享链接会删除。设为 0 则全部保留。

### 告警通知

系统设置 → 告警通知 可将事件推送到企业微信 / 钉钉 / 飞书机器人（支持加签）或通用 JSON webhook：设备离线（超过 `alert_offline_minutes` 才告警，短暂重连不会打扰）/ 恢复、脚本异常退出（App 上报 `run_end`，附带退出码和最后 40 行日志）、打包成功 / 失败、定时任务失败、未使用卡密不足、卡密滥用告警。同一对象的同一事件每 10 分钟最多发送一次。Webhook 地址仅对管理员可见，且不写入操作日志；签名密钥不会回传给浏览器。

## 开发

```bash
.venv/bin/python -m xscript_server serve --data /tmp/xs-dev     # API 监听 :8765
cd backend/web && npm run dev                                   # 控制台监听 :5173，代理 /api 和 /license
.venv/bin/python backend/scripts/demo.py                        # 或者：启动带 6 台模拟设备的临时服务器
PYTHONPATH=backend .venv/bin/python -m unittest discover -s backend/tests
```

## 角色

| 角色 | 权限 |
| --- | --- |
| 只读 viewer | 查看设备、任务、卡密、打包任务、设置 |
| 操作员 operator | + 下发命令（运行 / 停止 / 截图 / 按键 / 消息）、远程操控（画面 + 点击 / 滑动 / 按键）、编辑分组和备注、管理任务、创建 / 作废 / 解绑 / 延期 / 导出卡密、创建小程序并上传版本、打包 APK 并创建分享链接。设备 HTTP 中转仅限只读调用、`/action` 和运行 / 停止 |
| 管理员 admin | + 用户、设备密钥、离线令牌、删除卡密、发布 / 回滚 / 部署小程序版本（会把代码下发到设备）、开关代码保护、完整的设备 HTTP 中转（上传、`/eval`）、操作日志、设置 |

## 部署与安全

生产部署推荐用 Docker（后台 + Caddy 自动 HTTPS），见 [docs/部署.md](../docs/部署.md)。

- **两步验证。** 账号可以开启 TOTP 两步验证（「账号与令牌」页扫码），系统设置里可以要求所有管理员必须开启。手机丢失时由其他管理员在「用户」页重置，或运行 `reset-password <user> --totp-only`。
- **登录 IP 白名单**（系统设置 → 安全，管理员设置）：名单非空时，只有名单内的 IP 能登录后台、使用会话和 API 令牌；`/ws`、`/license/*`、`/pub/*` 不受影响。保存时不允许把自己的 IP 排除在外；被锁在外面时在服务器上运行 `reset-allowlist`。放在反向代理后面时必须 `--behind-proxy`，否则判断的是代理的 IP。
- **应用公告 / 强制更新**：`/api/app-notices`（查看：只读；增删改：操作员）、`/api/app-updates`（查看：只读；设置 / 清除：管理员）；公开接口 `GET /pub/app-notices`、`GET /pub/app-update`、`GET /pub/app-update/apk`（按 IP 限流，APK 下载与分发链接同一档）。被引用的打包任务不能删除。打包的 App 在首页打开时读取（后台打包自动填入 `ops_server`），低于最低版本时拦截脚本并引导下载安装。
- **卡密滥用 / 设备黑名单**：滥用监控的窗口和冷却写入 `abuse_events` / `abuse_reports`，重启后恢复；`/api/cards/bans`（查看：只读；增删：操作员）里的设备不能激活卡密，已激活的授权在 `/license/verify` 时返回 revoked。
- **设备运行日志** 由设备每 3 秒批量上传，保存 `device_log_days` 天（默认 7，0 = 不保存），设备离线后仍可在「运行日志 → 历史」里搜索和导出。
- **HTTPS。** 在前面部署 nginx 或 Caddy，并以 `--behind-proxy` 启动（信任来自 `--forwarded-allow-ips` 的 `X-Forwarded-*`，默认 127.0.0.1）。通过 HTTPS 访问时，会话 cookie 会带上 `Secure`。此时设备使用 `wss://`。除非传入 `--host`，服务器只绑定 127.0.0.1。
- **账号。** 密码使用 scrypt 哈希；会话（12 小时滑动过期，`XSCRIPT_SESSION_HOURS`）和 API 令牌以 SHA-256 哈希存储。登录按 IP + 用户名限流（失败 5 次锁定 5 分钟）。基于 cookie 认证的写操作需要 `X-XScript-Csrf` 请求头，cookie 为 `SameSite=Strict`。服务器不发送 CORS 头，并设置严格的 CSP。
- **设备密钥** 用于 `/ws` 认证。持有密钥的人可以控制用它连接的设备，包括在设备上运行代码。请按渠道或客户分别创建；吊销密钥会立即断开其设备。每个启用云控的打包应用都有自己的密钥。
- **`/license/*` 是公开的**，这是有意设计（应用在激活前就要调用）。猜测卡密按 IP 限流；只有有效且未作废的卡密才能拿到签名令牌。
- **`/pub/*` 按客户端 IP 限流**（每分钟 120 次请求；APK 和包下载每 10 分钟 20 次）。部署在代理后面时，请以 `--behind-proxy` 启动，这样限流针对的是真实客户端 IP，而不是代理。
- **`/pub/*` 同样是公开的**：`/pub/update` + `/pub/bundle/…` 向打包应用提供小程序的*已发布*版本（热更新；清单用卡密私钥签名，App 会校验 zip 的 sha256），`/pub/d/<token>` 通过分享链接提供 APK。任何知道渠道 id 的人都能下载已发布的包（如果在意，请开启代码保护）；分享链接可以设置过期，也可在控制台删除。
- **代码保护** 把项目编译为 Python 3.10 字节码（服务器上需要 `python3.10` 或 `XSCRIPT_BUILD_PYTHON`）。它能防止随手复制，但防不了反编译。
- **打包任务** 会在本机用上传的项目运行 Gradle。只把操作员角色分配给你在这方面信得过的人。上传的 zip 会检查路径穿越、符号链接和大小（上传 256 MB，解压后 512 MB）。Release 签名密码来自环境变量（`XSCRIPT_KEYSTORE`、`XSCRIPT_KEY_ALIAS`、`XSCRIPT_STORE_PASS`、`XSCRIPT_KEY_PASS`），并通过环境变量而不是 argv 传给构建。
- 请备份数据目录。不要把它提交到 git（`.gitignore` 已覆盖 `xscript-data/`、`keys/`、`*.pem`）。

已验证：`tests/` 中的测试套件，以及在演示服务器上用浏览器走查控制台。此处未验证：通过服务器执行真实的 Gradle 打包任务（测试使用的是桩打包脚本），以及部署在真实 TLS 代理之后的情况。
