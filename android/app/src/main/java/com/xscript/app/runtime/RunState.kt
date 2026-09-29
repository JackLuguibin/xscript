package com.xscript.app.runtime

import android.app.ActivityManager
import android.content.Context
import java.io.File

/**
 * Name of the running project, shared between processes through a small file.
 * The script process writes it; the main process validates it against the live
 * process list so a crashed script never looks "running" forever.
 */
object RunState {
    fun set(context: Context, project: String?) {
        val file = file(context)
        file.parentFile?.mkdirs()
        file.writeText(project?.trim().orEmpty())
    }

    fun get(context: Context): String? {
        val file = file(context)
        if (!file.exists()) return null
        return file.readText().trim().ifEmpty { null }
    }

    /** Like [get], but clears a stale value when the :script process is gone. */
    fun current(context: Context): String? {
        val name = get(context) ?: return null
        if (!scriptProcessAlive(context)) {
            set(context, null)
            return null
        }
        return name
    }

    fun scriptProcessAlive(context: Context): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val target = context.packageName + ":script"
        return am.runningAppProcesses?.any { it.processName == target } == true
    }

    private fun file(context: Context) = File(context.filesDir, "running-project")
}
