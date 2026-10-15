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
        val name = project?.trim().orEmpty()
        val since = File(context.filesDir, "running-since")
        if (name.isEmpty()) {
            since.delete()
        } else if (!since.exists() || get(context) != name) {
            writeAtomic(since, System.currentTimeMillis().toString())
        }
        writeAtomic(file, name)
    }

    /** Readers in the other process never see a half-written (empty) file. */
    private fun writeAtomic(file: File, text: String) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) file.writeText(text)
    }

    /** Epoch ms the current run started (for the floating window timer), or null when unknown. */
    fun since(context: Context): Long? =
        try {
            File(context.filesDir, "running-since").takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull()
        } catch (_: Exception) {
            null
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
