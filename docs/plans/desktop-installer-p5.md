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

> 2026-10-20 调整（用户要求）：只用 ad-hoc 签名，没有 Developer ID / Windows 代码签名证书；任何 dmg 都要在本机 Mac 上实际打开验证；不打标签、不发 Release；自动更新必须能用本地更新源测试，不依赖真实 Release。

- [ ] **P5.1 Windows 安装包**：PyInstaller onedir + Inno Setup（按用户安装，不要管理员权限）；`release.yml` 的 Windows 作业产出 setup.exe artifact，静默安装到临时目录、在安装目录里跑 `--selftest`、再静默卸载
- [ ] **P5.2 macOS dmg（ad-hoc）**：保持 ad-hoc 签名；新增 `check_macos_dmg.sh`：挂载 dmg、复制出 App、经 LaunchServices（`open`）真正启动并跑自检；Developer ID / 公证不做（没有证书），文档写明
- [ ] **P5.3 Windows 签名**：没有证书，不签名；文档写明 SmartScreen / Defender 的提示和放行方式（W-13），以及以后有证书时接 signtool 的位置
- [ ] **P5.4 自动更新**：更新清单 `desktop-update.json`（版本、各平台文件 sha256 / 大小）+ Ed25519 签名；客户端检查 → 提示 → 用户确认后下载、校验、替换并重启；`scripts/desktop_update_feed.py` 起本地更新源（临时密钥），端到端从旧版更新到新版
- [ ] **P5.5 诊断包**：一键导出日志、版本、环境（去掉令牌和密钥）
- [ ] **P5.6 release.yml 与文档**：workflow_dispatch / PR 演练产出全部桌面产物和更新清单（临时密钥签名，不发布）；正式发布时清单用 Secrets 里的更新密钥签名（没有就不出清单）；中英文档、截图

## 测试计划

- CI：windows-latest 构建 + 安装到临时目录 + `--selftest`；macOS 构建 + `verify_macos_app.sh`。
- 自动更新：本地起一个假更新服务器，旧版→新版，校验失败（错 sha256 / 错签名）时拒绝安装的单测。
- 不在用户机器上安装，不碰已安装的 com.xscript.app。

## 风险

- 没有证书：macOS 只能 ad-hoc（首次打开要手动放行），Windows 未签名（SmartScreen 提示）。
- 更新签名私钥要放进 GitHub Secrets（需要用户操作）；放之前正式版本不带更新清单、客户端里没有受信公钥，检查更新会说明「未配置」。
- Inno Setup 在 runner 上的安装方式（choco）可能变化。
