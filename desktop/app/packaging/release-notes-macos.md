### 桌面端 macOS 安装包（试用）
- 下载 `xscript-desktop-v{VERSION}-macos-arm64.dmg`。仅支持 **Apple Silicon（arm64）**，Intel Mac 暂无安装包。打开后把 XScript 拖进「应用程序」。
- 安装包**未用开发者证书签名、未经 Apple 公证**（仅 ad-hoc 签名，签名完整可校验）。第一次打开时 macOS 会提示“无法验证开发者”或“Apple 无法检查其是否包含恶意软件”，放行方式：
  - **macOS 15（Sequoia）及以上**：先双击打开一次，在弹窗里点「完成」；再到「系统设置 → 隐私与安全性」，在页面下方找到 XScript，点「仍要打开」，输入密码后再点「仍要打开」。
  - **macOS 14 及以下**：在 Finder 里右键（或按住 Control 点按）XScript →「打开」→ 再点「打开」。
  - 以上只需一次；之后可正常双击打开。
- 如果提示 **“已损坏，无法打开”**：说明下载的是旧的安装包（v0.4.0 最初上传的 dmg 签名有误，已替换），请重新下载；仍不行可在终端执行 `xattr -dr com.apple.quarantine /Applications/XScript.app` 后再打开。
- 桌面端仍处于开发阶段，需要电脑上能用 `adb`，手机上装好 XScript App。可以用 `SHA256SUMS` 校验下载的文件。
