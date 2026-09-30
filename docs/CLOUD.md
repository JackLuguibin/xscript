# 云控（云端控制）

设备主动用 WebSocket 连接你的服务器，不需要公网 IP 或端口映射。一条连接上同时支持两套指令：

- **AScript 指令集**：`app_run`、`app_stop`、`device_info`、`screen_shot`、`device_action` 等，字段和 AScript 官方文档一致，原来的 AScript 云控服务端基本可以直接对接。
- **XScript HTTP 转发**：通过云控调用设备的全部 HTTP 接口（上传工程、读日志、`/eval`、定时任务……），和局域网里用的接口完全一样。

仓库里带了一个参考服务端 `scripts/xscript_cloud.py`，包括设备列表、分组、批量下发、脚本数据回显、服务端定时任务、网页控制台和卡密激活接口。

## 快速开始

```bash
pip install aiohttp==3.14.3 cryptography
python scripts/xscript_cloud.py --port 8765 --token 换成你的密钥
```

- 设备端：首页 → 云端控制 → 填 `ws://服务器地址:8765/ws?token=换成你的密钥`。也可以在脚本里调用 `cloud.connect(...)`，或者打包 APK 时用 `--cloud-url` 预置。
- 控制台：浏览器打开 `http://服务器地址:8765/?token=换成你的密钥`。
- 公网部署时在前面加一层 TLS（比如 nginx / Caddy），设备端改用 `wss://`。

**一定要设置 `--token`。** 能连上服务端的人可以控制所有在线设备，包括运行任意代码。token 会同时校验设备连接、控制台和 REST API。

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
```

`device` 就是 `GET /status` 的内容：`model`、`brand`、`running`、`project`、`channel`、`version`、`device_id`、`packaged`、`app_id` 等。

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

## 参考服务端 REST API

认证：`?token=` 或请求头 `Authorization: Bearer <token>`。

| 请求 | 说明 |
| --- | --- |
| `GET /api/devices` | 设备列表（分组、运行状态、脚本数据、最近活动）、分组列表、最近事件 |
| `POST /api/command` `{"target", "command", "timeout"}` | `target`：`all`、`group:<分组>`、`app:<包名>`、设备 id（多个用逗号分隔）。返回 `{"results": {设备: 回执}}` |
| `POST /api/devices/<id>/group` `{"group"}` | 设置分组覆盖；空字符串表示恢复为设备上报的分组 |
| `POST /api/devices/<id>/http` `{"method","path","query","body"\|"body_b64"}` | 转发到设备 HTTP 接口，原样返回设备的回复 |
| `GET/POST /api/tasks`、`DELETE /api/tasks/<id>` | 服务端定时任务：`{"target","command","daily":"08:30"}` 或 `{"every": 分钟}` |
| `POST /license/activate`、`POST /license/verify` | 卡密激活 / 复核（不需要 token，见 [PACKAGING.md](PACKAGING.md)） |

```bash
curl -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"target":"group:farm-1","command":{"path":"app_run","id":"demo","param":{"level":3}}}' \
  http://127.0.0.1:8765/api/command
```

服务端定时任务和设备上的定时任务（`/schedules`）是两回事：前者需要服务端在线，但可以一次管理整批设备；后者在设备本地触发，离线也能运行。

## 限制

- 设备侧不做鉴权，完全依赖服务端的 token。能连到你服务端的人等于拥有所有设备。
- 参考服务端是单进程、内存里保存在线状态，适合几百台设备以内。规模更大时按上面的协议自己实现。
- 截图走的是设备当前的截图来源。没有授予截图权限、也没有 root 时，`screen_shot` 会返回 `capture unavailable`。
