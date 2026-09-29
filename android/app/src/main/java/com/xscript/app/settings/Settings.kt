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

    var keepScreenOn: Boolean
        get() = prefs().getBoolean("keep_screen_on", false)
        set(value) = prefs().edit().putBoolean("keep_screen_on", value).apply()

    var cloudUrl: String
        get() = prefs().getString("cloud_url", "") ?: ""
        set(value) = prefs().edit().putString("cloud_url", value.trim()).apply()

    var lastProject: String
        get() = prefs().getString("last_project", "") ?: ""
        set(value) = prefs().edit().putString("last_project", value).apply()

    fun runModeLabel(mode: String = runMode): String = when (mode) {
        MODE_ACCESSIBILITY -> "仅无障碍"
        MODE_ROOT -> "仅Root"
        else -> "Root或无障碍模式"
    }
}
