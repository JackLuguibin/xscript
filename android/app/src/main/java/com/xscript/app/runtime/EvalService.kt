package com.xscript.app.runtime

import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Process
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.xscript.app.IAutomation
import com.xscript.app.IEval
import org.json.JSONObject

/**
 * Hosts `/eval` snippets in the `:eval` process, so a runaway snippet never blocks or
 * crashes the main process (HTTP server, accessibility, capture). The interpreter stays
 * warm between calls; [EvalRunner] kills the process on timeout and the next call
 * starts a fresh one. Automation calls reach the main process over [IAutomation],
 * exactly like the :script process.
 */
class EvalService : Service() {
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            AutomationDispatcher.remote = IAutomation.Stub.asInterface(service)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            AutomationDispatcher.remote = null
        }
    }

    private val binder = object : IEval.Stub() {
        override fun run(code: String): String = try {
            val py = Python.getInstance()
            val result = py.getModule("xscript.runtime.eval_runner").callAttr("run", code)
            py.getModule("json").callAttr("dumps", result).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("result", "").put("error", t.message ?: t.toString()).toString()
        }

        override fun pid(): Int = Process.myPid()
    }

    override fun onCreate() {
        super.onCreate()
        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        bindService(Intent(this, AutomationService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        try {
            unbindService(connection)
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
