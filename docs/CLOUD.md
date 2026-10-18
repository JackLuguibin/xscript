# 云控（云端控制）

设备主动用 WebSocket 连接你的服务器，不需要公网 IP 或端口映射。一条连接上同时支持两套指令：

- **AScript 指令集**：`app_run`、`app_stop`、`device_info`、`screen_shot`、`device_action` 等，字段和 AScript 官方文档一致，原来的 AScript 云控服务端基本可以直接对接。
- **XScript HTTP 转发**：通过云控调用设备的全部 HTTP 接口（上传工程、读日志、`/eval`、定时任务……），和局域网里用的接口完全一样。

服务端是仓库里的管理后台 `backend/xscript_server`（FastAPI + React 控制台），包括设备管理、分组、批量下发、实时截图、脚本数据回显、服务端定时任务、设备密钥、卡密和 APK 打包。部署见 [backend/README.md](../backend/README.md)。

## 快速开始

```bash
.venv/bin/pip install -e backend
(cd backend/web && npm ci && npm run build)
.venv/bin/python -m xscript_server init --data xscript-data        # 创建管理员
.venv/bin/python -m xscript_server serve --data xscript-data --port 8765
```

- 控制台：浏览器打开 `http://服务器地址:8765/`，用管理员账号登录。
- 设备密钥：控制台 → 设备密钥 → 新建，得到 `ws://服务器地址:8765/ws?token=xsd_…`。
  设备端照常填这个地址即可：App 会把 `token` 从地址里拿出来，改用 `Authorization: Bearer <密钥>` 请求头连接，密钥不会出现在服务端或反向代理的访问日志里。直接把密钥放在 `?token=` 里连接属于旧方式（旧版 App 和自写客户端），服务端仍然接受，日志里会显示成 `token=***`；新写的客户端请用请求头。
- 设备端：首页 → 云端控制 → 填上面的地址。也可以在脚本里调用 `cloud.connect(...)`，或者打包 APK 时勾选「连接云控」（后台为每个打包 App 单独生成密钥）。
- 公网部署时在前面加一层 TLS（nginx / Caddy），设备端改用 `wss://`，后台用 `--behind-proxy` 启动。

**设备密钥等于设备的控制权。** 能连上服务端并通过认证的人可以控制所有在线设备，包括运行任意代码。可以按渠道分别建密钥；停用某个密钥会立即断开用它连接的设备。

## 脚本侧 API

```python
from xscript.android import cloud, system

cloud.send({"gold": 180, "water": 200})     # 控制台里按设备显示，同名字段覆盖

@cloud.on_message
def on_msg(data):                            # 服务端发来的 message，或未知指令
    print("收到", data)

params = system.params()                     # app_run 的 "param"，没有时为 {}
cloud.status()                               # {"state": "connected", "device_id", "group", ...}
```

AScript 写法照常可用：`cloud_control.connect_to_ws(url)`、`cloud_control.send(dict)`、`cloud_control.close()`、`system.channel(fun)`、`system.Control.send(dict)`。启动参数也会像 AScript 一样写进 `builtins`（`if hasattr(builtins, 'name'): print(name)`）。`connect_to_as`（AScript 官方云控）不支持。

`on_message` 只在脚本运行期间收消息，脚本要自己保持运行（循环，或 `cloud.wait_message()`）。

## 设备标识和分组

- `device_id` 是 Android 的 `ANDROID_ID`：同一台设备、同一签名的 App 重装后不变。
- 一台手机上可以同时装 XScript 和多个打包出来的 App，它们的 `device_id` 相同。参考服务端用 `device_id@应用包名` 区分（XScript 本身只用 `device_id`），并且可以按 `app:<包名>` 下发。
- 分组有两个来源：设备上报的（`cloud.connect(url, group="farm-1")`，或打包时的 `--cloud-group`），以及控制台里的覆盖设置（保存在 `--state` 文件里）。以控制台设置为准。

## 协议

所有帧都是 JSON 文本。

### 设备 → 服务端

```text
{"type":"hello","device_id":"ecb3…","group":"farm-1","app":"com.xscript.app","device":{…status…}}
{"type":"status","device_id":…,"group":…,"app":…,"device":{…}}     运行开始 / 结束时，以及每 60 秒一次
{"type":"data","device_id":…,"data":{…}}                          脚本 cloud.send()
{"type":"run_end","project":…,"exit":"1","crashed":true,"tail":[…]} 脚本结束（崩溃时触发告警）
{"type":"logs","entries":[{"seq":12,"ts":1727760000000,"stream":"stdout","line":"…"}]}
                                                                  运行日志上传，每 3 秒一批，最多 500 行
```

`device` 就是 `GET /status` 的内容：`model`、`brand`、`running`、`project`、`channel`、`version`、`device_id`、`packaged`、`app_id` 等。

### 运行日志上传

服务端收到 `hello` 后回 `{"type":"log_cursor","seq":N}`，`N` 是服务端已保存的这台设备最后一行的 `seq`（没有则为 0）。设备只在收到游标后才上传 `seq > N` 的行，所以断线重连既不丢也不重复。系统设置里「设备运行日志保留天数」为 0 时服务端不发游标，设备就不上传；旧版服务端同样不发游标，新版 App 连旧服务端不受影响。

### AScript 指令（服务端 → 设备）

每条指令带 `path`。回执回显 `path`，以及 `seq`（可选的关联号，同时发多条指令时用来配对）和 `id`（AScript 的小程序 id）。

```text
{"path":"app_run","id":"demo","param":{"name":"李四"},"card":"XS-…","seq":"c1"}
→ {"path":"app_run","code":1,"msg":"success","device_id":"…","id":"demo","seq":"c1"}
```

| path | 参数 | 说明 |
| --- | --- | --- |
| `device_info` | | `result`：`device_version`、`device_name`、`app_is_run`、`app_id`、`username`，以及 `device_id`、`group`、`license` |
| `app_list` | | `result`：设备上的工程名列表 |
| `app_run` | `id`（工程名）、`param`（对象）、`card` | 正在运行的脚本会先停掉再启动。`card` 用于打包 App 还没激活时顺便激活 |
| `app_stop` | | 没有在运行时返回 `code:-1, msg:"not running"` |
| `screen_shot` | `max`（最长边，默认 300）、`quality`（10–100，默认 20） | `result`：`image`（JPEG base64）、`s_size`、`r_size`、`scale` |
| `device_action` | `action`：`click`（`x`、`y`）、`swipe`（`ori`：left / right / top / bottom）、`key`（`ori`：home / back / recents / notifications） | 走当前的自动化通道（无障碍或 root） |
| `message` | `data` | 转给正在运行的脚本 |

`code` 为 1 表示成功，-1 表示失败，失败原因在 `msg` 里。不认识的 `path` 会原样转给脚本（`on_message` 收到整条指令），回执 `code:-1`。

### 发给脚本的消息

```text
{"type":"message","data":…}
```

不需要回执。

### HTTP 转发

```text
服务端 → 设备  {"type":"request","id":"r1","method":"GET","path":"/status","query":{},"body":"<base64>"}
设备 → 服务端  {"type":"response","id":"r1","status":200,"mime":"application/json","body":"<base64>"}
```

接口列表见 `protocol/openapi.yaml`。云控不能流式传输，文件类回复会整块读进内存再 base64 发送，大文件体积约增加 33%。

## 管理后台 REST API

完整接口文档在后台的 `/api/docs`（OpenAPI）。认证：网页登录（Cookie），或在「账号与令牌」里创建 API 令牌，用请求头 `Authorization: Bearer <令牌>`。令牌的权限与账号角色相同（只读 / 操作员 / 管理员）。

| 请求 | 说明 |
| --- | --- |
| `GET /api/devices?q=&group=&online=&page=` | 设备列表（在线和历史设备，分组、运行状态、脚本数据、最近活动），分页 |
| `GET /api/groups`、`GET /api/apps` | 分组（含在线数）、应用包名 |
| `PATCH /api/devices/<id>` `{"group_override","note"}` | 设置分组覆盖（空字符串 = 用设备上报的分组）和备注 |
| `POST /api/devices/batch-group` `{"ids","group_override"}` | 批量设置分组 |
| `GET /api/devices/<id>/logs?q=&stream=&since_ts=&until_ts=&before=&after=&limit=` | 服务器保存的运行日志（设备离线也能查），默认最新 500 行，`before=<id>` 往前翻页，`after=<id>` 取新增；时间为秒 |
| `GET /api/devices/<id>/logs/export` | 按同样的条件导出为文本文件（最多 10 万行） |
| `POST /api/command` `{"target","command","timeout"}` | `target`：`all`、`group:<分组>`、`app:<包名>`、设备 id（多个用逗号分隔）。返回 `{"results": {设备: 回执}, "devices", "ok"}` |
| `POST /api/devices/<id>/http` `{"method","path","query","body"\|"body_b64"}` | 转发到设备 HTTP 接口，原样返回设备的回复。操作员只能调用只读接口、`/action`（远程操控的点击 / 滑动 / 按键）和运行 / 停止；上传文件、`/eval` 等需要管理员。远程操控用 `GET /screen?format=jpg&max=480&quality=40` 取小尺寸画面 |
| `GET/POST /api/tasks`、`PATCH/DELETE /api/tasks/<id>`、`POST /api/tasks/<id>/run` | 服务端定时任务：`{"target","command","daily":"08:30"}` 或 `{"every": 分钟}` |
| `GET/POST /api/device-keys`、`POST /api/device-keys/<id>/revoke` | 设备密钥（管理员） |
| `GET/POST /api/scripts`、`POST /api/scripts/<id>/versions`（multipart `file`、`version`、`notes`、`publish`） | 小程序和版本 |
| `POST /api/scripts/<id>/publish` `{"version_id"}` | 发布 / 回滚（管理员）。热更新的 App 会切换到这个版本 |
| `POST /api/scripts/<id>/deploy` `{"target","version_id","run","params"}` | 通过云控把版本安装到设备（`PUT /projects/<工程名>/zip`），可选立即启动（管理员）。单个工程上限约 11 MB |
| `POST /api/pack/jobs/<id>/shares` `{"days"}`、`DELETE /api/pack/shares/<id>` | 分发链接，公开下载页 `/d/<token>` |
| `GET /pub/update?channel=&code=`、`GET /pub/bundle/<channel>/<code>.zip` | 热更新（打包 App 调用，不需要登录）：签名清单 + 当前发布版本的工程 zip |
| `GET /pub/app-notices?app=&version_code=`、`GET /pub/app-update?app=&version_code=`、`GET /pub/app-update/apk?app=` | App 公告和 APK 更新检查 / 下载（不需要登录；`/api/app-notices`、`/api/app-updates` 管理）。打包的 App 在首页读取 |
| `POST /license/activate`、`POST /license/verify` | 卡密激活 / 复核（App 调用，不需要登录，见 [PACKAGING.md](PACKAGING.md)） |

```bash
curl -H "Authorization: Bearer $XS_TOKEN" -H "Content-Type: application/json" \
  -d '{"target":"group:farm-1","command":{"path":"app_run","id":"demo","param":{"level":3}}}' \
  https://cloud.example.com/api/command
```

所有写操作都记在「操作日志」里（谁、什么时候、对什么对象、从哪个 IP）。下发给设备的 `card` 字段不会写进日志。

服务端定时任务和设备上的定时任务（`/schedules`）是两回事：前者需要服务端在线，但可以一次管理整批设备；后者在设备本地触发，离线也能运行。

## 限制

- 设备侧不做鉴权，完全依赖服务端的设备密钥。拿到密钥并能连到服务端的人等于拥有用这个密钥连接的所有设备。
- 服务端是单进程，在线连接保存在内存里，设备、卡密、任务等保存在 SQLite（`<数据目录>/xscript.db`）。适合几百到上千台设备；更大规模需要按上面的协议做多实例和消息总线。
- 截图走的是设备当前的截图来源。没有授予截图权限、也没有 root 时，`screen_shot` 会返回 `capture unavailable`。
