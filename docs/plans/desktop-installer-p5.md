# 桌面端 P5：安装包、代码签名、自动更新

状态：草稿计划（docs/plans）。逐阶段实现，每阶段一个或几个小提交，推送到同一个草稿 PR。

## 范围

- Windows 安装包（Inno Setup）、macOS dmg 的正式签名与公证、桌面端自动更新、崩溃/诊断包，以及 `release.yml` 产出这些产物。
- 签名证书只放 GitHub Secrets；没有证书时构建照常产出未签名包并在日志里说明，不阻塞。
- 不做：发布 Release / 打标签（需要用户批准），本 PR 系列只改流程和产物，并在 workflow_dispatch 上演练。

## 依据

- `desktop/README.md`：v0.4.0 起只有 macOS arm64 dmg（ad-hoc 签名、未公证），「Windows 包还没有」；「没做」里有打包与安装器（P5）、`pyside6-deploy` 与 PyInstaller 对比。
- `docs/桌面端设计.md` §12.1：P5 = Inno 安装包、代码签名、自动更新、崩溃/诊断包、release.yml 加桌面产物、中英文档；验收「干净机器安装→自动更新到下一个版本；签名校验通过」；W-13（SmartScreen）、W-14（打包产物体积/冷启动/误报）。
- 已有基础：`desktop/app/packaging/build_macos_app.sh`、`verify_macos_app.sh`、CI 的 `desktop-windows` 作业（#120）。

## 分阶段清单

- [ ] **P5.1 Windows 打包**：PyInstaller onedir + Inno Setup 脚本，CI（windows-latest）产出 setup.exe 作为 artifact；`--selftest` 在安装目录里跑
- [ ] **P5.2 macOS 签名/公证**：Developer ID 签名 + notarytool（Secrets 有证书时），没有就保持 ad-hoc；`verify_macos_app.sh` 校验
- [ ] **P5.3 Windows 签名**：signtool（Secrets 有证书时）；记录 SmartScreen / Defender 结果（W-13）
- [ ] **P5.4 自动更新**：更新清单（版本、sha256、签名）+ 客户端检查/下载/校验/替换；先只提示，用户确认后安装
- [ ] **P5.5 诊断包**：一键导出日志、版本、环境（去掉令牌和密钥）
- [ ] **P5.6 release.yml**：workflow_dispatch 演练产出全部桌面产物（不发布）；文档中英

## 测试计划

- CI：windows-latest 构建 + 安装到临时目录 + `--selftest`；macOS 构建 + `verify_macos_app.sh`。
- 自动更新：本地起一个假更新服务器，旧版→新版，校验失败（错 sha256 / 错签名）时拒绝安装的单测。
- 不在用户机器上安装，不碰已安装的 com.xscript.app。

## 风险

- 证书成本和获取时间；没有证书时只能验证流程。
- Inno Setup 在 runner 上的安装方式（choco）可能变化。
