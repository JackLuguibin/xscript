# React Flow 在 QtWebEngine 里的验证（macOS）

设计 §14.10 的通过标准没有改。这一页是 2026-10-16 在 Mac 上的实测。发布目标仍是 Windows；这里不把 Windows 当成开始验证的前提。

页面是构建产物里的 `spike.html`（`@xyflow/react` 12.8.6，自定义节点，exec / data 两种引脚，`onlyRenderVisibleElements`，保留免费署名）。外壳用现有的 `xsapp://` 和 CSP。

```bash
cd desktop/frontend && npm run build
cd ../app && .venv/bin/python -m pytest -q tests/test_reactflow_spike.py
env -u QT_QPA_PLATFORM -u QTWEBENGINE_CHROMIUM_FLAGS .venv/bin/python tools/reactflow_probe.py
```

## 结果

| 编号 | 标准 | 结果 |
| --- | --- | --- |
| S1 | 自定义节点、多 Handle、边能画出来，无 CSP 报错 | ✅ 离屏外壳里先画出 2 个节点，再测 200 / 1000 个。`fetch('https://example.com/')` 被 CSP 拒绝 |
| S2 | React Flow 的 CSS 和 `style-src 'unsafe-inline'` 能共存 | ✅ 节点和右下角署名都按库的样式出现。构建把 CSS 打成独立文件（`spike-*.css`，15.8 KB，gzip 2.7 KB） |
| S3 | 拖动节点、从 Handle 拖线、`isValidConnection` 拒绝错误类型 | 连接规则 ✅：`exec-out`→`exec-in` 连上，`exec-out`→`data-in` 被拒绝，边数不变。节点拖动 ⚠：离屏里的合成鼠标事件，以及真窗口里的 `QTest` 点击，测到的位移都是 0。这不能当成「React Flow 拖不动」，只能说明这两种自动化鼠标没有进到页面的拖拽逻辑（d3-drag）。要用真的鼠标再确认一次 |
| S4 | 200 节点 / 300 边，平移时 `requestAnimationFrame` 间隔 p95 < 33 ms。真窗口，开 GPU 和 `--disable-gpu` 各一次 | ✅ 开 GPU 的真窗口：首帧 27 ms，p95 **16.8 ms**（45 帧）。离屏 + `--disable-gpu`：首帧 15 ms，p95 **16.7 ms**（49 帧） |
| S5 | 1000 节点首次渲染 < 2 s，平移 p95 < 50 ms | ✅ 离屏 + `--disable-gpu`：首次渲染 **125 ms**，平移 p95 **16.7 ms**。开了 `onlyRenderVisibleElements` |
| S6 | Tab 能在节点间移动，读屏标签在 | 部分 ✅。节点有 `aria-label`（`节点 0`），焦点能落到节点上。没有逐个 Tab 把全部节点走一遍 |
| S7 | 节点里的中文输入法 | ⚠ 没测。spike 节点没有内联输入框 |
| S8 | 同页桥事件 100 次/秒时，平移 p95 不差于 S4 的 1.3 倍 | ✅ 离屏里推 100 个 `spike.tick` 之后再平移，p95 **16.8 ms**，相对 S4 的 16.7 ms |
| S9 | 打进 `resources/app/` 后的体积，只记录 | spike 脚本 176 KB（gzip 57 KB），样式 16 KB（gzip 2.7 KB）。React 运行时和主界面共用一块 219 KB（gzip 69 KB） |
| S10 | 默认署名「React Flow」可见，不挡控件 | ✅ `react-flow__attribution` 的文字里有 “React Flow”，在画布右下角 |

S4 的两个数字都低于 33 ms，所以 §14.11 里「平移要跟手」的起点不用因为这次测量改松。千级节点在视口裁剪打开时也没有碰到 2 秒 / 50 ms 的线。图库继续用 React Flow，不改 §4.2。

没通过、也不能用这次自动化下结论的，只有节点拖动的真实鼠标和中文输入法。
