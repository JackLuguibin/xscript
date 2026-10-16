# XScript 桌面端（Windows 为目标平台）

设计文档：[`docs/桌面端设计.md`](../docs/桌面端设计.md)。本目录实现其 §12.1 路线图的 **P0 阶段**（验证与脚手架）。

> **状态：P0 进行中。** 本阶段只在 macOS 上开发和验证；**所有 Windows 专属行为（`adb.exe` 定位、凭据管理器、打包、安装器、
> 高 DPI 等）均未验证**，文档里用「⚠ Windows 未验证」标注。

## 目录

```text
desktop/
  app/        Python 包 xscript_desktop（PySide6 壳 + 服务层 + QWebChannel JSON-RPC 桥）
  frontend/   React 19 + Vite + TypeScript 前端（@xyflow/react 在后续阶段接入流程编辑器）
```

后续阶段才会出现的目录（`nodes/`、`schema/`）见设计文档 §12.5。
