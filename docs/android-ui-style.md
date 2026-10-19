# Android 界面风格规范

所有界面（主页、小程序列表/详情、编辑器、日志、打包应用首页、悬浮窗、脚本弹窗）共用一套样式。代码入口是
`android/app/src/main/java/com/xscript/app/ui/UiKit.kt`，`StyleTokensTest` 会检查下面的规则。

## 颜色

- 只用 `res/values/colors.xml` 与 `res/values-night/colors.xml` 里的 token（通过 `UiKit.palette(ctx)` 读取），浅色/深色各一套，
  `ThemeTokensTest` 检查两套名字一致且文字对比度 ≥ 4.5:1。
- 不使用动态取色（Material You），保持固定品牌色。
- 界面代码里不写 `0xFF…`、`Color.parseColor`、`Color.rgb/argb`。唯一例外是 `script/ScriptUi.kt`：脚本自己指定的颜色原样生效。

## 尺寸

| 用途 | token | 值 |
| --- | --- | --- |
| 间距 | `UiKit.Space` | 4 / 8 / 12 / 16 / 20 / 24 / 32 dp |
| 圆角 | `UiKit.Radius` | SMALL 12（图标底块、悬浮窗按钮）· CARD 16 · FULL 24（按钮、悬浮窗） |
| 字号 | `UiKit.Type` | TITLE 20 · HEADLINE 18 · BODY_LARGE 16 · BUTTON 15 · BODY 14 · LABEL 13 · CAPTION 12 |
| 固定尺寸 | `UiKit.Size` | 图标 20/24、图标底块 36、列表行 56、圆点 8 等 |
| 触控 | `UiKit.MIN_TOUCH_DP` | 所有可点元素至少 48dp |

## 结构

- 页面：`UiKit.screen`（标题栏，可选返回箭头和右侧文字操作 `barAction`）。
- 分组：`UiKit.section` 小标题 + `UiKit.card` 卡片；卡片内用 `UiKit.row` / `UiKit.switchRow`，行间分隔线缩进到标题处。
- 运行状态：`UiKit.runCard`（标题、状态圆点、一个主按钮），主页与打包应用首页共用。
- 空列表：`UiKit.empty`（标题、说明、最多两个按钮）。脚注：`UiKit.note`。

## 图标

- 只用 Material Symbols Rounded 矢量图（`res/drawable/ic_sym_*.xml`，Apache-2.0），只打包实际用到的（`IconsTest`）。
- 列表行图标放在浅色底块上（`UiKit.icon`），统一着色；不用 emoji 或文字符号当图标。

## 按钮层级

- 填充按钮（`Tone.PRIMARY / SUCCESS / DANGER`）：每张卡片最多一个主操作。
- 色调按钮（`Tone.NEUTRAL`）：次要操作。
- 文字按钮：标题栏 `barAction`、对话框按钮。

## 状态

- 行右侧的状态文字：成功用 success，问题用 danger，其他用 muted；或运行卡片上的状态圆点。不另做标签样式。

## 对话框与提示

- 对话框一律 `MaterialAlertDialogBuilder`（`Theme.Xscript`，跟随深色模式），包括脚本弹窗与链接确认框。
- 对话框里的输入框用 `UiKit.dialogField`（24dp 内边距、至少 48dp 高）。
- 简短提示用 `UiKit.toast`（系统 Toast；悬浮窗和后台服务里没有 Snackbar 的宿主，所以统一用 Toast）。

## 悬浮窗

- 颜色来自同一套 token：卡片底色 + outline 描边，运行为 success、停止/出错为 danger、空闲为 muted。
