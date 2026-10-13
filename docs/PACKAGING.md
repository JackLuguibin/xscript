# APK 打包与卡密授权

把一个工程打包成独立 App：自己的包名、名称、图标，打开后直接进入这个脚本（启动 / 停止、权限、卡密），没有开发者首页和局域网调试接口。App 里的运行时和 XScript 完全相同，所以在 XScript 里调通的工程打包后行为一致。

有两种打包方式，结果一样：

- **管理后台 → APK 打包**（推荐）：上传工程 zip 或选一个小程序版本，勾选卡密 / 云控 / 热更新 / 代码保护，后台排队构建，完成后下载 APK，或生成带二维码的公开下载链接分发给用户。卡密公钥、授权服务器地址、云控地址、设备密钥和热更新频道都由后台自动填好。见 [backend/README.md](../backend/README.md) 和 [使用手册](使用手册.md) 第 5、7 节。
- **命令行** `backend/xscript_pack.py`：适合 CI 和本地构建，参数见下文。

两种方式都需要构建机上有 Android SDK、JDK 17+、Python 3.10（见 `android/build.sh`）。后台打包时，构建在运行后台的那台机器上进行。

## 命令行打包

```bash
python backend/xscript_pack.py examples/xs_smoke \
    --app-id com.example.smoke --name "冒烟测试" \
    --version 1.0.0 --version-code 1 --icon icon.png \
    --abis arm64-v8a --out dist/
```

| 参数 | 说明 |
| --- | --- |
| `--app-id` | 包名（applicationId）。同一个包名的新版本才能覆盖安装 |
| `--name`、`--icon` | 桌面名称和图标（PNG，建议 512×512） |
| `--version`、`--version-code` | 每次发布更新都要增大 `--version-code`；新版本首次启动时会用 APK 里的工程替换设备上的旧工程 |
| `--project-name` | App 内部的工程名（默认用目录名，必须是合法的 Python 标识符） |
| `--abis` | 默认 `arm64-v8a,x86_64`。只给真机用时写 `arm64-v8a`，APK 约小 40%（实测 77 MB 对比 155 MB） |
| `--autostart` | 开机后自动运行 |
| `--license-key` / `--license-pubkey`、`--license-server` | 需要卡密，见下文 |
| `--cloud-url`、`--cloud-group` | 首次启动时自动连接云控，见 [CLOUD.md](CLOUD.md)。URL 里带设备密钥，也可以用环境变量 `XSCRIPT_CLOUD_URL` 传入，避免出现在进程列表里 |
| `--bundle-requirements` | 构建时就装好 `requirements.txt` 里的包（原生包必须在 Chaquopy 的索引里）。不加时首次运行联网安装 |
| `--dev-server` | 保留局域网调试接口（端口 9860 起），只用于调试 |
| `--protect` | 代码保护：工程编译成 Python 3.10 字节码后再打包，APK 里没有 `.py` 源码。构建机需要 `python3.10`（或 `XSCRIPT_BUILD_PYTHON`）。字节码仍可能被反编译，只能防止直接复制和修改 |
| `--update-server`、`--update-channel`、`--update-pubkey`、`--script-code` | 热更新：App 启动时和之后每 30 分钟向 `<update-server>/pub/update` 查询这个频道的发布版本。清单用卡密同一把私钥签名，App 用内置公钥验签并校验 zip 的 sha256 后才替换工程；脚本运行时不替换，下次启动生效。后台从小程序版本打包时自动填写 |
| `--keystore`、`--key-alias`、`--store-pass`、`--key-pass` | 用你的签名证书构建 release 包。密码也可以用环境变量 `XSCRIPT_STORE_PASS`、`XSCRIPT_KEY_PASS` |

不给 `--keystore` 时构建的是 debug 签名的 APK，可以直接安装，但以后无法用正式签名的包覆盖升级。正式发布前先生成自己的证书并妥善保存：

```bash
keytool -genkeypair -v -keystore release.jks -alias key0 -keyalg RSA -keysize 2048 -validity 10000
```

后台打包要用正式签名时，启动后台前设置 `XSCRIPT_KEYSTORE`、`XSCRIPT_KEY_ALIAS`、`XSCRIPT_STORE_PASS`、`XSCRIPT_KEY_PASS`，打包页的「正式签名」开关才会可用。密码只在环境变量里，不进数据库。

构建目录是 `android/app/build-pack/<包名>/`，不影响 XScript 自身的构建。

打包出来的 App 和 XScript 可以装在同一台手机上。它们的设置、工程、授权互相独立。无障碍服务也是各自单独开启的。

## 卡密授权

授权码是开发者私钥签名的令牌（ECDSA P-256），App 里只内置公钥。验签在手机本地完成，所以离线也能用；私钥只在管理后台的数据目录里（`<数据目录>/keys/private.pem`）。

### 1. 签名密钥

管理后台第一次启动时自动生成签名密钥。**备份 `keys/private.pem`**：每个开启卡密的 App 都内嵌对应的公钥，私钥丢失或更换后，已发布的 App 就无法再激活。公钥可以在「系统设置」里查看。

### 2. 打包时启用

后台打包：勾选「需要卡密授权」（需要先在「系统设置」填写服务器公网地址）。

命令行：

```bash
python backend/xscript_pack.py my_game --app-id com.me.game --name "我的脚本" \
    --license-key xscript-data/keys/private.pem --license-server https://cloud.example.com
```

`--license-key` 只读取私钥来算出公钥写进 App，私钥不会进 APK；没有私钥的机器上可以改用 `--license-pubkey <公钥>`。启用后，未激活或授权失效时脚本不会启动（界面、云控 `app_run`、定时任务、开机自启都会被拦住）。

### 3a. 在线卡密（推荐）

用户输入短卡密（`XS-ABCD-EFGH-JKLM-NPQR`），App 带着设备 ID 请求管理后台的 `/license/activate`，后台绑定设备并返回签好名的令牌。

在「卡密管理」里：

- **生成卡密**：数量、有效天数（从激活开始算，0 = 永久）、限定应用（包名，`*` 表示所有应用）、备注。每次生成是一个批次，可以按批次筛选和导出 CSV。
- 卡密第一次激活时绑定设备。同一张卡换设备会被拒绝；需要迁移时 **解绑**，到期时间保持不变。
- **停用** 卡密后，App 每 6 小时联网复核一次，被停用的授权在下次复核后失效；复核时网络不通则保留当前授权。可以 **恢复**。
- **延期**：未激活的卡增加天数，已激活的卡推迟到期时间。
- 状态：未使用 / 已激活 / 已过期 / 已解绑 / 已停用。

激活接口按 IP 限制猜卡次数。云控下发 `app_run` 时也可以带 `"card"`，没激活的设备会先激活再启动。

### 3b. 离线授权码

用户的设备不联网时，让他把 App 里显示的设备 ID 发给你，在「卡密管理 → 离线授权码」签发一个长授权码让他粘贴进去（设备 ID 填 `*` 表示任意设备，比如试用）。离线授权码也记在卡密列表里（批次 `offline`），停用后 App 联网复核时失效；如果设备一直不联网，只能等它过期。

### 在脚本里读取授权

```python
from xscript.android import system
st = system.license_status()   # {"required", "activated", "card"（打码）, "card_full", "expires", "error"}
```

AScript 的 `R.get_card()` 返回当前卡密。

### 从旧版命令行工具迁移

以前用 `xscript_license.py` + `licenses.db` 的，导入后已发布的 App 不受影响：

```bash
python -m xscript_server import-legacy --data xscript-data \
    --key keys/private.pem --licenses licenses.db
```

旧私钥会复制进数据目录（数据目录里已有不同的密钥时会拒绝，防止覆盖），卡密的绑定和到期时间原样保留。

### 安全边界

这是客户端校验：能拦住普通的复制和分享，但拦不住有能力反编译、修改 APK 的人。App 会记录见过的最晚时间，把系统时间往回调不能延长授权。对价值高的脚本，建议把关键逻辑或数据放在服务端，通过云控或网络接口按授权提供。
