package com.xscript.app.runtime

import android.content.Context
import android.os.Build
import com.xscript.app.XscriptApp
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.events.EventHub
import com.xscript.app.net.NetworkInfo
import com.xscript.app.root.RootShell
import com.xscript.app.schedule.Scheduler
import com.xscript.app.settings.Settings
import com.xscript.app.ui.FloatControl
import org.json.JSONArray
import org.json.JSONObject

/** Main-process operations the script process asks for through `IAutomation.control`. */
object MainControl {
    /** [handle], with failures returned as {"error": ...} so Python can raise a readable exception. */
    fun safeHandle(op: String, arg: String): String =
        try {
            handle(op, arg)
        } catch (e: IllegalArgumentException) {
            JSONObject().put("error", e.message ?: "bad request").toString()
        } catch (t: Throwable) {
            android.util.Log.w("XScriptControl", "control:$op failed", t)
            JSONObject().put("error", t.message ?: t.toString()).toString()
        }

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
                ScriptSupervisor.onFinished(arg)
                FloatControl.hide()
                "ok"
            }
            // ---- lifecycle (AScript system.Config / system.reboot)
            "rerun_after_exit" -> {
                ScriptSupervisor.requestRerun(arg.toLongOrNull() ?: 0L)
                "ok"
            }
            "config_get" -> config(arg).toString()
            "config_set" -> {
                val a = JSONObject(arg)
                val project = a.getString("project")
                if (a.has("auto_run")) {
                    val on = a.getBoolean("auto_run")
                    if (on) Settings.bootProject = project else if (Settings.bootProject == project) Settings.bootProject = ""
                }
                if (a.has("stop_re_run")) {
                    val on = a.getBoolean("stop_re_run")
                    Settings.rerunProjects = if (on) Settings.rerunProjects + project else Settings.rerunProjects - project
                }
                config(project).toString()
            }
            // ---- events
            "events_subscribe" -> {
                val a = JSONObject(arg)
                val types = mutableSetOf<String>()
                a.optJSONArray("types")?.let { for (i in 0 until it.length()) types.add(it.getString(i)) }
                EventHub.subscribe(types, a.optInt("a11y_mask", 0))
                EventHub.subscribed().toString()
            }
            "events_status" -> EventHub.subscribed().toString()
            "notification_send" -> EventHub.sendNotification(arg).toString()
            // ---- schedules
            "schedule_list" -> JSONArray(Scheduler.store(ctx).list(arg.ifEmpty { null }).map { it.toJson() }).toString()
            "schedule_add" -> {
                val s = Scheduler.store(ctx).add(JSONObject(arg), System.currentTimeMillis())
                Scheduler.rearm(ctx)
                (Scheduler.store(ctx).get(s.id) ?: s).toJson().toString()
            }
            "schedule_update" -> {
                val a = JSONObject(arg)
                val s = Scheduler.store(ctx).update(a.getString("id"), a, System.currentTimeMillis())
                Scheduler.rearm(ctx)
                (Scheduler.store(ctx).get(s.id) ?: s).toJson().toString()
            }
            "schedule_remove" -> {
                val ok = Scheduler.store(ctx).remove(arg)
                if (ok) Scheduler.rearm(ctx)
                ok.toString()
            }
            else -> ""
        }
    }

    /** Boot / rerun flags for [project] (empty = the running project). */
    fun config(project: String): JSONObject {
        val name = project.ifEmpty { RunState.get(XscriptApp.instance).orEmpty() }
        return JSONObject()
            .put("project", name)
            .put("auto_run", name.isNotEmpty() && Settings.bootProject == name)
            .put("stop_re_run", name in Settings.rerunProjects)
            .put("boot_project", Settings.bootProject)
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
            .put("notification_listener", EventHub.listenerConnected)
            .put("exact_alarms", Scheduler.canExact(ctx))
            .put("running", running != null)
            .put("project", running)
            .put("version", XscriptApp.versionName(ctx))
    }
}
