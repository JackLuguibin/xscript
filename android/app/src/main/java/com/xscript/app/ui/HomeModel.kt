package com.xscript.app.ui

/** What the home screen shows, kept free of views so the JVM tests cover it. */
object HomeModel {
    /** The run card: the project it is about, its status line and the primary action. */
    data class RunCard(
        val title: String,
        val status: String,
        val action: String,
        val tone: UiKit.Tone,
        val running: Boolean,
        /** Something blocks a run (the status dot turns red). */
        val warn: Boolean = false,
    )

    /**
     * [running] is the project running now, [last] the last one run if it still exists. With neither, the action
     * opens the project list ("选择"), not a green "运行" that has nothing to run.
     */
    fun runCard(running: String?, last: String?): RunCard = when {
        running != null -> RunCard(running, "运行中", "停止", UiKit.Tone.DANGER, true)
        last != null -> RunCard(last, "上次运行 · 可在小程序列表切换", "运行", UiKit.Tone.SUCCESS, false)
        else -> RunCard("还没有选择小程序", "新建、导入或选择一个小程序后即可运行", "选择", UiKit.Tone.PRIMARY, false)
    }

    /** Trailing text of the permissions section header. */
    fun permissionSummary(granted: Int, total: Int): String =
        if (granted >= total) "全部已开启" else "已开启 $granted/$total"
}
