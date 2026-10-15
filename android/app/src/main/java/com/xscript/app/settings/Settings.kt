package com.xscript.app.settings

import android.content.Context
import com.xscript.app.XscriptApp

/**
 * App-wide preferences. Read and written from the main process only; the script process
 * reaches automation through the binder, so it never needs these directly.
 */
object Settings {
    const val MODE_AUTO = "auto"
    const val MODE_ACCESSIBILITY = "accessibility"
    const val MODE_ROOT = "root"

    private fun prefs() = XscriptApp.instance.getSharedPreferences("xscript", Context.MODE_PRIVATE)

    var runMode: String
        get() = prefs().getString("run_mode", MODE_AUTO) ?: MODE_AUTO
        set(value) = prefs().edit().putString("run_mode", value).apply()

    var floatOnRun: Boolean
        get() = prefs().getBoolean("float_on_run", true)
        set(value) = prefs().edit().putBoolean("float_on_run", value).apply()

    /** Floating window also shows while no script runs (only when the app is in the background). */
    var floatAlways: Boolean
        get() = prefs().getBoolean("float_always", false)
        set(value) = prefs().edit().putBoolean("float_always", value).apply()

    /** Where the floating window rests: edge + vertical fraction (see ui.FloatLogic.Dock). */
    var floatDock: com.xscript.app.ui.FloatLogic.Dock
        get() = com.xscript.app.ui.FloatLogic.Dock(
            prefs().getBoolean("float_right", com.xscript.app.ui.FloatLogic.DEFAULT_DOCK.right),
            com.xscript.app.ui.FloatLogic.clampFrac(prefs().getFloat("float_y", com.xscript.app.ui.FloatLogic.DEFAULT_DOCK.yFrac)),
        )
        set(value) = prefs().edit().putBoolean("float_right", value.right).putFloat("float_y", value.yFrac).apply()

    /** "run" (default: while a script runs), "always" (whenever the app is in the background) or "off". */
    var floatMode: String
        get() = if (!floatOnRun) "off" else if (floatAlways) "always" else "run"
        set(value) {
            prefs().edit().putBoolean("float_on_run", value != "off").putBoolean("float_always", value == "always").apply()
        }

    fun floatModeLabel(mode: String = floatMode): String = when (mode) {
        "always" -> "后台一直显示"
        "off" -> "已关闭"
        else -> "运行时显示"
    }

    var keepScreenOn: Boolean
        get() = prefs().getBoolean("keep_screen_on", false)
        set(value) = prefs().edit().putBoolean("keep_screen_on", value).apply()

    var cloudUrl: String
        get() = prefs().getString("cloud_url", "") ?: ""
        set(value) = prefs().edit().putString("cloud_url", value.trim()).apply()

    /** 云控 group label reported in hello; the server can also assign groups on its side. */
    var cloudGroup: String
        get() = prefs().getString("cloud_group", "") ?: ""
        set(value) = prefs().edit().putString("cloud_group", value.trim()).apply()

    /** Packaged apps: whether the LAN developer server (HTTP API) runs. Off by default there. */
    var devServer: Boolean
        get() = prefs().getBoolean("dev_server", !com.xscript.app.BuildConfig.PACKAGED)
        set(value) = prefs().edit().putBoolean("dev_server", value).apply()

    /** `xscript://run` links: "confirm" (ask each time, default), "allow" or "off". See link.SchemeLink. */
    var schemeMode: String
        get() = prefs().getString("scheme_mode", com.xscript.app.link.SchemeLink.MODE_CONFIRM)
            ?.takeIf { com.xscript.app.link.SchemeLink.isMode(it) } ?: com.xscript.app.link.SchemeLink.MODE_CONFIRM
        set(value) = prefs().edit().putString("scheme_mode", value).apply()

    fun schemeModeLabel(mode: String = schemeMode): String = when (mode) {
        com.xscript.app.link.SchemeLink.MODE_ALLOW -> "直接运行"
        com.xscript.app.link.SchemeLink.MODE_OFF -> "已关闭"
        else -> "每次确认"
    }

    var lastProject: String
        get() = prefs().getString("last_project", "") ?: ""
        set(value) = prefs().edit().putString("last_project", value).apply()

    /** Project started after boot (AScript `Config.set_auto_run`). Only one project can run at a time. */
    var bootProject: String
        get() = prefs().getString("boot_project", "") ?: ""
        set(value) = prefs().edit().putString("boot_project", value.trim()).apply()

    /** Projects re-run when they exit on their own or crash (AScript `Config.set_stop_re_run`). */
    var rerunProjects: Set<String>
        get() = prefs().getStringSet("rerun_projects", emptySet())?.toSet() ?: emptySet()
        set(value) = prefs().edit().putStringSet("rerun_projects", value.toSet()).apply()

    fun runModeLabel(mode: String = runMode): String = when (mode) {
        MODE_ACCESSIBILITY -> "仅无障碍"
        MODE_ROOT -> "仅Root"
        else -> "Root或无障碍模式"
    }
}
