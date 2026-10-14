# android：XScript 手机端

Android 应用，以及它内嵌的 Python 运行时。

| 路径 | 作用 |
| --- | --- |
| `app/` | Kotlin 应用：HTTP 服务（`:9860`）、云控 WebSocket 客户端、卡密校验、无障碍 / root 引擎、截屏、OCR、悬浮窗、Web 工具（`src/main/assets/tools/`） |
| `python-runtime/xscript/` | 设备端 `xscript` 包（Chaquopy 源码目录） |
| `python-runtime/ascript/` | AScript 兼容包 |
| `python-runtime/tests/` | 运行时的 PC 端测试（模拟 bridge，无需手机） |
| `build.sh` | 查找 JDK 17+、Android SDK 和 Python 3.10，然后运行 Gradle |

## 构建

```bash
./android/build.sh                          # 调试版 APK -> android/app/build/outputs/apk/debug/
./android/build.sh :app:testDebugUnitTest   # JVM 单元测试
```

`backend/xscript_pack.py` 同样通过 `build.sh` 构建，并传入 `-Pxscript.pack=<pack.properties>`（见 [docs/PACKAGING.md](../docs/PACKAGING.md)）。

### 正式版签名

主应用从 Git 忽略目录中的 `keys/release.properties` 读取签名配置，也可通过
`-Pxscript.signingFile=/absolute/path/release.properties` 指定文件：

```properties
storeFile=xscript-release.p12
storePassword=<密钥库密码>
keyAlias=xscript-release
keyPassword=<私钥密码>
```

`storeFile` 相对于配置文件所在目录解析。构建正式版：

```bash
XSCRIPT_GRADLE_TASK=:app:assembleRelease ./android/build.sh
```

未提供签名配置时，Release 构建输出未签名 APK，不能直接安装或发布。
请安全备份密钥库和密码，后续版本必须使用同一签名才能覆盖升级；不要将它们提交到 Git 或上传到 Release。
正式签名与 Debug 签名不同，从 Debug 版切换需要先卸载，卸载会清除应用数据，请先导出项目。

## 运行时测试

```bash
PYTHONPATH=android/python-runtime:android/python-runtime/tests \
  .venv-rt/bin/python -m unittest discover -s android/python-runtime/tests
```

修改 `python-runtime/` 后，请用 `python3 scripts/gen_stubs.py` 重新生成 IDE 存根。

设备 HTTP 接口约定是 `protocol/openapi.yaml`。IDE 工具和云控中转都依赖它，所以要与 `app/src/main/java/com/xscript/app/http/ApiRouter.kt` 保持同步。
