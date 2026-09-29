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
import com.xscript.app.project.ProjectStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Runs one project in the `:script` process. Stop = kill the process, which is the only
 * reliable way to interrupt arbitrary Python (threads, blocking native calls, overlays).
 */
class ScriptService : Service() {
    private val ready = CountDownLatch(1)

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            AutomationDispatcher.remote = IAutomation.Stub.asInterface(service)
            ready.countDown()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            AutomationDispatcher.remote = null
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }
        bindService(Intent(this, AutomationService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                LogBuffer.append(this, "stdout", "xscript: stopped by user\n")
                finish()
            }
            ACTION_RUN -> {
                val name = intent.getStringExtra(EXTRA_NAME) ?: return START_NOT_STICKY
                if (running) return START_NOT_STICKY
                running = true
                thread(name = "xscript-project") { runProject(name) }
            }
        }
        return START_NOT_STICKY
    }

    @Volatile
    private var running = false

    private fun runProject(name: String) {
        ready.await(5, TimeUnit.SECONDS)
        val dir = ProjectStore(this).dir(name)
        RunState.set(this, name)
        safeControl("script_started", name)
        LogBuffer.append(this, "stdout", "xscript: script process start $name\n")
        try {
            val runner = Python.getInstance().getModule("xscript.runtime.runner")
            runner.callAttr("run_project", dir.absolutePath)
        } catch (t: Throwable) {
            LogBuffer.append(this, "stderr", (t.message ?: t.toString()) + "\n")
        } finally {
            finish()
        }
    }

    private fun safeControl(op: String, arg: String) {
        try {
            AutomationDispatcher.control(op, arg)
        } catch (_: Throwable) {
        }
    }

    private fun finish() {
        RunState.set(this, null)
        safeControl("script_finished", "")
        stopSelf()
        // Script threads, overlay windows and native handles all go with the process.
        Process.killProcess(Process.myPid())
    }

    override fun onDestroy() {
        try {
            unbindService(connection)
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    companion object {
        const val ACTION_RUN = "com.xscript.app.RUN"
        const val ACTION_STOP = "com.xscript.app.STOP"
        const val EXTRA_NAME = "name"

        fun run(context: Context, name: String) {
            val intent = Intent(context, ScriptService::class.java).apply {
                action = ACTION_RUN
                putExtra(EXTRA_NAME, name)
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            if (!RunState.scriptProcessAlive(context)) {
                RunState.set(context, null)
                return
            }
            val intent = Intent(context, ScriptService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }
}
