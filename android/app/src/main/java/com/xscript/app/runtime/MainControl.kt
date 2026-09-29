package com.xscript.app.runtime

import android.content.Context
import android.os.Build
import com.xscript.app.XscriptApp
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.net.NetworkInfo
import com.xscript.app.root.RootShell
import com.xscript.app.settings.Settings
import com.xscript.app.ui.FloatControl
import org.json.JSONObject

/** Main-process operations the script process asks for through `IAutomation.control`. */
object MainControl {
    fun handle(op: String, arg: String): String {
        val ctx = XscriptApp.instance
        return when (op) {
            "current_app" -> Automation.currentApp().toString()
            "status" -> status(ctx).toString()
            "float_show" -> {
                FloatControl.show(ctx, RunState.get(ctx))
                "ok"
            }
            "float_hide" -> {
                FloatControl.hide()
                "ok"
            }
            "script_started" -> {
                if (Settings.floatOnRun) FloatControl.show(ctx, arg)
                "ok"
            }
            "script_finished" -> {
                FloatControl.hide()
                "ok"
            }
            else -> ""
        }
    }

    fun status(ctx: Context): JSONObject {
        val metrics = ctx.resources.displayMetrics
        val running = RunState.current(ctx)
        return JSONObject()
            .put("name", Build.DEVICE ?: "android")
            .put("model", Build.MODEL ?: "")
            .put("brand", Build.BRAND ?: "")
            .put("sdk", Build.VERSION.SDK_INT)
            .put("release", Build.VERSION.RELEASE ?: "")
            .put("width", metrics.widthPixels)
            .put("height", metrics.heightPixels)
            .put("density", metrics.densityDpi)
            .put("ip", NetworkInfo.localIp(ctx))
            .put("port", NetworkInfo.PORT)
            .put("accessibility", AccessibilityEngine.isOn())
            .put("root", RootShell.known() == true)
            .put("run_mode", Settings.runMode)
            .put("channel", Automation.channel().name.lowercase())
            .put("capture", CaptureEngine.available())
            .put("capture_source", CaptureEngine.sourceLabel())
            .put("running", running != null)
            .put("project", running)
            .put("version", XscriptApp.versionName(ctx))
    }
}
