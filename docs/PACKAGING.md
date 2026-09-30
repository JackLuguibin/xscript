# APK 打包与卡密授权

`scripts/xscript_pack.py` 把一个工程打包成独立 App：自己的包名、名称、图标，打开后直接进入这个脚本（启动 / 停止、权限、卡密），没有开发者首页和局域网调试接口。脚本在里面用的是和 XScript 完全相同的运行时，所以在 XScript 里调通的工程打包后行为一致。

## 打包

需要和构建 XScript 一样的环境：Android SDK、JDK 17+、Python 3.10（见 `scripts/build_android.sh`）。

```bash
python scripts/xscript_pack.py examples/xs_smoke \
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
| `--cloud-url`、`--cloud-group` | 首次启动时自动连接云控，见 [CLOUD.md](CLOUD.md) |
| `--bundle-requirements` | 构建时就装好 `requirements.txt` 里的包（原生包必须在 Chaquopy 的索引里）。不加时首次运行联网安装 |
| `--dev-server` | 保留局域网调试接口（端口 9860 起），只用于调试 |
| `--keystore`、`--key-alias`、`--store-pass`、`--key-pass` | 用你的签名证书构建 release 包。密码也可以用环境变量 `XSCRIPT_STORE_PASS`、`XSCRIPT_KEY_PASS` |

不给 `--keystore` 时构建的是 debug 签名的 APK，可以直接安装，但以后无法用正式签名的包覆盖升级。正式发布前先生成自己的证书并妥善保存：

```bash
keytool -genkeypair -v -keystore release.jks -alias key0 -keyalg RSA -keysize 2048 -validity 10000
```

构建目录是 `android/app/build-pack/<包名>/`，不影响 XScript 自身的构建。

打包出来的 App 和 XScript 可以装在同一台手机上。它们的设置、工程、授权互相独立。无障碍服务也是各自单独开启的。

## 卡密授权

授权码是开发者私钥签名的令牌（ECDSA P-256），App 里只内置公钥。验签在手机本地完成，所以离线也能用；私钥只在你自己手里。

### 1. 生成密钥

```bash
python scripts/xscript_license.py keygen --out keys/
# keys/private.pem  私钥，务必保密、备份；丢了就无法再签发授权
# keys/public.b64   公钥
```

### 2. 打包时启用

```bash
python scripts/xscript_pack.py my_game --app-id com.me.game --name "我的脚本" \
    --license-key keys/private.pem --license-server https://my.server:8765
```

`--license-key` 只读取私钥来算出公钥写进 App，私钥不会进 APK。启用后，未激活或授权失效时脚本不会启动（界面、云控 `app_run`、定时任务、开机自启都会被拦住）。

### 3a. 在线卡密（推荐）

用户输入短卡密（`XS-ABCD-EFGH-JKLM-NPQR`），App 带着设备 ID 请求授权服务器，服务器绑定设备并返回签好名的令牌。

```bash
# 生成 50 张 30 天卡，只能用于 com.me.game
python scripts/xscript_license.py cards --db licenses.db --count 50 --days 30 --app com.me.game
# 授权服务器 = 参考云控服务端加上两个参数
python scripts/xscript_cloud.py --port 8765 --token 密钥 --licenses licenses.db --key keys/private.pem
```

- 卡密第一次激活时绑定设备，有效期从激活那一刻开始算（`--days 0` 为永久）。
- 同一张卡换设备会被拒绝。需要迁移时先 `unbind`，保留原来的到期时间。
- `revoke` 停用卡密。App 每 6 小时联网复核一次，被停用的授权在下次复核后失效；复核时网络不通则保留当前授权。
- `list` 查看每张卡的状态、绑定设备和到期时间。

```bash
python scripts/xscript_license.py list   --db licenses.db
python scripts/xscript_license.py revoke --db licenses.db XS-ABCD-EFGH-JKLM-NPQR
python scripts/xscript_license.py unbind --db licenses.db XS-ABCD-EFGH-JKLM-NPQR
```

云控下发 `app_run` 时也可以带 `"card"`，没激活的设备会先激活再启动。

### 3b. 离线授权码

不部署服务器时，用户把 App 里显示的设备 ID 发给你，你签发一个长授权码让他粘贴进去：

```bash
python scripts/xscript_license.py issue --key keys/private.pem --device ecb326e7a9957d35 --days 30 --app com.me.game
python scripts/xscript_license.py issue --key keys/private.pem --device '*' --days 7    # 任意设备，比如试用
```

离线授权码无法远程停用，只能等它过期。

### 在脚本里读取授权

```python
from xscript.android import system
st = system.license_status()   # {"required", "activated", "card"（打码）, "card_full", "expires", "error"}
```

AScript 的 `R.get_card()` 返回当前卡密。

### 安全边界

这是客户端校验：能拦住普通的复制和分享，但拦不住有能力反编译、修改 APK 的人。App 会记录见过的最晚时间，把系统时间往回调不能延长授权。对价值高的脚本，建议把关键逻辑或数据放在服务端，通过云控或网络接口按授权提供。
