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
import com.xscript.app.IEventSink
import com.xscript.app.project.ProjectStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Runs one project in the `:script` process. Stop = kill the process, which is the only
 * reliable way to interrupt arbitrary Python (threads, blocking native calls, overlays).
 *
 * The run attaches an [IEventSink] to the main process ([ScriptSupervisor]): its binder
 * dies with this process, and subscribed events arrive through it into [events].
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

    private val sink = object : IEventSink.Stub() {
        override fun onEvent(json: String) {
            // Bounded: a script that never reads events must not grow memory without limit.
            if (!events.offer(json)) {
                events.poll()
                events.offer(json)
            }
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
                finish("stopped")
            }
            ACTION_RUN -> {
                val name = intent.getStringExtra(EXTRA_NAME) ?: return START_NOT_STICKY
                if (running) return START_NOT_STICKY
                running = true
                // This is the :script process; the companion field here is its own copy.
                launchParams = intent.getStringExtra(EXTRA_PARAMS) ?: "{}"
                debugRun = intent.getBooleanExtra(EXTRA_DEBUG, false)
                thread(name = "xscript-project") { runProject(name) }
            }
        }
        return START_NOT_STICKY
    }

    @Volatile
    private var running = false

    private var debugRun = false

    private fun runProject(name: String) {
        ready.await(5, TimeUnit.SECONDS)
        val dir = ProjectStore(this).dir(name)
        RunState.set(this, name)
        try {
            AutomationDispatcher.remote?.attachScript(name, sink)
        } catch (_: Throwable) {
        }
        safeControl("script_started", name)
        LogBuffer.append(this, "stdout", "xscript: script process start $name\n")
        var exit = "1"
        try {
            val runner = Python.getInstance().getModule("xscript.runtime.runner")
            exit = runner.callAttr("run_project", dir.absolutePath, launchParams, debugRun).toString()
        } catch (t: Throwable) {
            LogBuffer.append(this, "stderr", (t.message ?: t.toString()) + "\n")
        } finally {
            finish(exit)
        }
    }

    private fun safeControl(op: String, arg: String) {
        try {
            AutomationDispatcher.control(op, arg)
        } catch (_: Throwable) {
        }
    }

    private fun finish(exit: String) {
        RunState.set(this, null)
        safeControl("script_finished", exit)
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
        const val EXTRA_PARAMS = "params"
        const val EXTRA_DEBUG = "debug"

        /** Events pushed by the main process, read by Python through [Bridge.pollEvent]. */
        val events = LinkedBlockingQueue<String>(1000)

        /** Launch parameters of the current run (云控 app_run "param"), read by the script. */
        @Volatile
        var launchParams: String = "{}"

        /**
         * Start [name] in the script process. [auto] marks starts made by the supervisor
         * (boot, rerun, schedules) so a manual start resets the crash-loop counter.
         * [params] (JSON object) reach the script as `system.params()` / AScript builtins.
         *
         * Returns null when started, or the reason it was refused (packaged app without a
         * valid 卡密 license).
         */
        fun run(context: Context, name: String, auto: Boolean = false, params: String = "{}", debug: Boolean = false): String? {
            val gate = com.xscript.app.license.LicenseManager.check(context) ?: com.xscript.app.pack.AppOps.gate(context)
            if (gate != null) {
                LogBuffer.append(context, "stderr", "xscript: $name not started: $gate\n")
                return gate
            }
            ScriptSupervisor.noteStart(name, auto)
            launchParams = params.ifBlank { "{}" }
            val intent = Intent(context, ScriptService::class.java).apply {
                action = ACTION_RUN
                putExtra(EXTRA_NAME, name)
                putExtra(EXTRA_PARAMS, launchParams)
                putExtra(EXTRA_DEBUG, debug)
            }
            context.startService(intent)
            return null
        }

        /** User-requested stop: the supervisor will not rerun this run. */
        fun stop(context: Context) {
            ScriptSupervisor.noteUserStop()
            if (!RunState.scriptProcessAlive(context)) {
                RunState.set(context, null)
                return
            }
            val intent = Intent(context, ScriptService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }
}
