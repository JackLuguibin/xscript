### 桌面端 Windows 安装包（试用）
- 下载 `xscript-desktop-v{VERSION}-windows-x64-setup.exe`（Windows 10 / 11，64 位）。按当前用户安装到 `%LOCALAPPDATA%\Programs\XScript`，**不需要管理员权限**；再次运行新版本的安装包会原地升级。卸载：「设置 → 应用」里的 XScript，或开始菜单。
- 安装包**没有代码签名**（还没有证书）。第一次运行时 Microsoft Defender SmartScreen 会提示“Windows 已保护你的电脑”：点「更多信息」→「仍要运行」。下载时浏览器也可能提示“不常下载”，选择「保留」。
- 杀毒软件偶尔会把 PyInstaller 打包的程序误报；可以先用 `SHA256SUMS` 核对文件，再决定是否放行。
- 桌面端仍处于开发阶段，Windows 版只在 GitHub 的 Windows 构建机上做过安装、自检和卸载，没有在真实电脑上完整测试。需要电脑上能用 `adb`，手机上装好 XScript App。
