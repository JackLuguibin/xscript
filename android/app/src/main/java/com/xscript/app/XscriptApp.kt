package com.xscript.app

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import com.xscript.app.cloud.CloudClient
import com.xscript.app.root.RootShell
import com.xscript.app.schedule.Scheduler
import kotlin.concurrent.thread

class XscriptApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        isMainProcess = resolveProcessName() == packageName
        if (isMainProcess) {
            // Packaged app: unpack the bundled project (first start / after an update).
            try {
                com.xscript.app.pack.PackInstaller.ensure(this)
            } catch (t: Throwable) {
                android.util.Log.e("XScript", "pack install failed", t)
            }
            RootShell.probeAsync()
            // Script/EvalService bind with BIND_AUTO_CREATE when needed. Starting an
            // ordinary service here crashes background launches on recent Android.
            CloudClient.autoConnect(this)
            com.xscript.app.pack.UpdateChecker.start(this)
            // Force-stop and app updates drop alarms; arm the next schedule on every start.
            thread(name = "xscript-rearm") { Scheduler.rearm(this) }
        }
    }

    private fun resolveProcessName(): String {
        if (Build.VERSION.SDK_INT >= 28) return getProcessName()
        val pid = Process.myPid()
        val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        return am.runningAppProcesses?.firstOrNull { it.pid == pid }?.processName ?: packageName
    }

    companion object {
        lateinit var instance: XscriptApp
            private set

        @Volatile
        var isMainProcess: Boolean = true
            private set

        fun versionName(context: Context): String = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }
    }
}
