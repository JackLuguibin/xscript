package com.xscript.app

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.xscript.app.cloud.CloudClient
import com.xscript.app.root.RootShell
import com.xscript.app.runtime.AutomationService

class XscriptApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        isMainProcess = resolveProcessName() == packageName
        if (isMainProcess) {
            RootShell.probeAsync()
            startService(Intent(this, AutomationService::class.java))
            CloudClient.autoConnect(this)
        }
    }

    fun ensurePython() {
        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
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
