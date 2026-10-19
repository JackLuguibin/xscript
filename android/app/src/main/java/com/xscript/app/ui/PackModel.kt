package com.xscript.app.ui

/** What the packaged-app screen shows, kept free of views so the JVM tests cover it. */
object PackModel {
    /**
     * The run card. The action is what the button does now: [mustUpdate] opens the update dialog ("更新"),
     * a failed license check opens activation ("激活"), otherwise it starts or stops the script.
     * [gate] is the reason a run is blocked (forced update, license, server switch), shown as the status.
     */
    fun runCard(running: Boolean, gate: String?, mustUpdate: Boolean, licenseBlocked: Boolean, needAccessibility: Boolean): HomeModel.RunCard = when {
        running -> HomeModel.RunCard("正在运行", "脚本运行中，可随时停止", "停止", UiKit.Tone.DANGER, true)
        mustUpdate -> HomeModel.RunCard("需要更新", gate ?: "当前版本过低", "更新", UiKit.Tone.PRIMARY, false, warn = true)
        licenseBlocked -> HomeModel.RunCard("尚未授权", gate ?: "请先激活卡密", "激活", UiKit.Tone.PRIMARY, false, warn = true)
        gate != null -> HomeModel.RunCard("暂不可用", gate, "启动", UiKit.Tone.SUCCESS, false, warn = true)
        needAccessibility -> HomeModel.RunCard("还差一步", "请先开启下方的无障碍服务", "启动", UiKit.Tone.SUCCESS, false, warn = true)
        else -> HomeModel.RunCard("准备就绪", "点击启动运行脚本", "启动", UiKit.Tone.SUCCESS, false)
    }

    /** The license row: expiry and remaining uses when active, else the reason it is not. */
    fun licenseValue(active: Boolean, until: String, usesLeft: Int, gate: String?): Pair<String, Boolean> =
        if (active) Pair("有效至 $until" + if (usesLeft >= 0) "，剩余 $usesLeft 次" else "", true)
        else Pair(gate ?: "未激活", false)
}
