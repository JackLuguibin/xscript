package com.xscript.app.runtime

import android.content.Context
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import com.xscript.app.IEventSink
import com.xscript.app.XscriptApp
import com.xscript.app.events.EventHub
import com.xscript.app.project.ProjectStore
import com.xscript.app.settings.Settings
import com.xscript.app.ui.FloatControl
import kotlin.concurrent.thread

/**
 * Main-process owner of the script lifecycle: who is running, why a run ended, and what
 * starts next (boot run, 停止后重新运行, `system.reboot()`, schedules with if_running=restart).
 *
 * The :script process attaches an [IEventSink] at the start of every run; its binder dies
 * with the process, so crashes and kills are seen even when the script never reports back.
 */
object ScriptSupervisor {
    private const val RERUN_DELAY_MS = 3_000L
    private const val FAST_EXIT_MS = 10_000L
    private const val MAX_FAST_EXITS = 5
    private const val STARTING_GRACE_MS = 15_000L
    private const val BOOT_WAIT_MS = 60_000L

    private class Run(val project: String, val sink: IEventSink, val started: Long, val wallStart: Long, val logFrom: Long) {
        @Volatile var exit: String? = null
        @Volatile var userStop = false
        @Volatile var rerunDelayMs = -1L
    }

    private val main = Handler(Looper.getMainLooper())
    private val ctx: Context get() = XscriptApp.instance

    @Volatile private var run: Run? = null
    private var starting: String? = null
    private var startingSince = 0L
    private var startSeq = 0L
    private var queued: String? = null
    private var fastExits = 0
    private var pendingRerun: Runnable? = null

    // ------------------------------------------------------------------ run tracking

    /** Called over binder by the :script process once it is ready to run [project]. */
    fun attach(project: String, sink: IEventSink) {
        val from = synchronized(this) { startSeq.takeIf { starting == project } }
            ?: (LogBuffer.lastSeq(ctx) - 2).coerceAtLeast(0L) // "script process start" and "starting" come first
        val r = Run(project, sink, SystemClock.elapsedRealtime(), System.currentTimeMillis(), from)
        val death = IBinder.DeathRecipient { main.post { onDeath(r) } }
        try {
            sink.asBinder().linkToDeath(death, 0)
        } catch (_: Exception) {
            main.post { onDeath(r) }
            return
        }
        synchronized(this) {
            run = r
            if (starting == project) starting = null
        }
        EventHub.attach(sink)
    }

    /** The script reported how it ended: an exit code, or "stopped". */
    fun onFinished(exit: String) {
        run?.exit = exit.ifEmpty { "0" }
    }

    /** `system.reboot()`: restart the current project after [delayMs] once this run ends. */
    fun requestRerun(delayMs: Long) {
        run?.rerunDelayMs = delayMs.coerceIn(0L, 3_600_000L)
    }

    /** Start of a run requested from the UI, HTTP, a schedule or a rerun. */
    @Synchronized
    fun noteStart(project: String, auto: Boolean) {
        cancelRerun()
        if (!auto) fastExits = 0
        starting = project
        startingSince = SystemClock.elapsedRealtime()
        startSeq = LogBuffer.lastSeq(ctx)
    }

    /** A user (UI, HTTP, float button) stopped the script: never rerun this run. */
    @Synchronized
    fun noteUserStop() {
        run?.userStop = true
        starting = null
        cancelRerun()
    }

    @Synchronized
    fun isBusy(context: Context): Boolean {
        if (run != null) return true
        val s = starting
        if (s != null && SystemClock.elapsedRealtime() - startingSince < STARTING_GRACE_MS) return true
        return RunState.current(context) != null
    }

    /**
     * Unattended start (boot, schedules): start [project] unless something is running. With
     * [restart], stop the current run and start [project] when it is gone.
     * Returns started / skipped / queued / missing.
     */
    @Synchronized
    fun launch(context: Context, project: String, reason: String, restart: Boolean = false): String {
        if (!ProjectStore(context).exists(project)) {
            LogBuffer.append(context, "stderr", "xscript: $reason: missing project $project\n")
            return "missing"
        }
        if (isBusy(context)) {
            if (!restart) {
                LogBuffer.append(context, "stdout", "xscript: $reason: skipped $project, a script is running\n")
                return "skipped"
            }
            LogBuffer.append(context, "stdout", "xscript: $reason: restarting into $project\n")
            // Queue before stopping so the old run's death notification starts it.
            queued = project
            ScriptService.stop(context)
            // Covers a run that was still starting (no death link yet) or already gone.
            main.postDelayed({ drainQueue(context, force = false) }, 500)
            // If the old process never reports its death, start anyway once it is gone.
            main.postDelayed({ drainQueue(context, force = true) }, STARTING_GRACE_MS)
            return "queued"
        }
        LogBuffer.append(context, "stdout", "xscript: $reason: start $project\n")
        ScriptService.run(context, project, auto = true)
        return "started"
    }

    private fun onDeath(r: Run) {
        synchronized(this) {
            if (run === r) run = null
        }
        EventHub.detach(r.sink)
        if (RunState.get(ctx) == r.project && !RunState.scriptProcessAlive(ctx)) RunState.set(ctx, null)
        FloatControl.scriptEnded(ctx, if (r.userStop) "stopped" else (r.exit ?: "died"))
        if (r.exit == null && !r.userStop) {
            LogBuffer.append(ctx, "stderr", "xscript: script process for ${r.project} died unexpectedly\n")
        }
        com.xscript.app.cloud.CloudClient.reportRunEnd(r.project, r.exit ?: "died", r.userStop)
        try {
            val to = LogBuffer.lastSeq(ctx)
            // The summary is one of the run's last lines: read a short tail, not the whole run.
            val stats = LogBuffer.since(ctx, maxOf(r.logFrom, to - 20), limit = 20).first
                .asReversed().firstNotNullOfOrNull { if (it.seq <= to) RunHistory.parseStats(it.line) else null }
            RunHistory.record(ctx, RunHistory.Record(r.project, r.wallStart, SystemClock.elapsedRealtime() - r.started,
                r.exit ?: "died", r.userStop, r.logFrom, to, stats))
        } catch (_: Exception) {
            // history is best effort; never break the rerun / queue logic below
        }
        if (queued != null) {
            // Let the dead process leave the process list so startService creates a fresh one.
            main.postDelayed({ drainQueue(ctx, force = true) }, 500)
            return
        }
        if (r.userStop) return
        val delay = when {
            r.rerunDelayMs >= 0 -> r.rerunDelayMs
            r.project in Settings.rerunProjects -> rerunDelayFor(r)
            else -> -1L
        }
        if (delay < 0) return
        scheduleRerun(r.project, delay)
    }

    @Synchronized
    private fun rerunDelayFor(r: Run): Long {
        val ran = SystemClock.elapsedRealtime() - r.started
        fastExits = if (ran < FAST_EXIT_MS) fastExits + 1 else 0
        if (fastExits >= MAX_FAST_EXITS) {
            LogBuffer.append(ctx, "stderr", "xscript: ${r.project} exited $MAX_FAST_EXITS times within ${FAST_EXIT_MS / 1000}s; 停止后重新运行 paused until the next manual start\n")
            fastExits = 0
            return -1L
        }
        // 3 s, then 3 s more for each consecutive fast exit.
        return RERUN_DELAY_MS * maxOf(1, fastExits)
    }

    @Synchronized
    private fun scheduleRerun(project: String, delayMs: Long) {
        cancelRerun()
        LogBuffer.append(ctx, "stdout", "xscript: re-running $project in ${delayMs / 1000.0}s\n")
        val task = Runnable {
            synchronized(this) { pendingRerun = null }
            if (!isBusy(ctx) && ProjectStore(ctx).exists(project)) ScriptService.run(ctx, project, auto = true)
        }
        pendingRerun = task
        main.postDelayed(task, delayMs)
    }

    private fun cancelRerun() {
        pendingRerun?.let { main.removeCallbacks(it) }
        pendingRerun = null
    }

    /**
     * Start a project queued by launch(restart=true) once the old run is gone. [force] is the
     * fallback timer for a process that never reported its death.
     */
    private fun drainQueue(context: Context, force: Boolean) {
        val project = synchronized(this) {
            val q = queued ?: return
            if (run != null && !force) return
            if (RunState.scriptProcessAlive(context)) {
                // Still shutting down: try again shortly.
                main.postDelayed({ drainQueue(context, force) }, 500)
                return
            }
            queued = null
            run = null
            q
        }
        ScriptService.run(context, project, auto = true)
    }

    // ------------------------------------------------------------------ boot

    /** After BOOT_COMPLETED: wait for an automation channel, then start [Settings.bootProject]. */
    fun bootRun(context: Context) {
        val project = Settings.bootProject
        if (project.isEmpty() || !ProjectStore(context).exists(project)) return
        LogBuffer.append(context, "stdout", "xscript: boot: waiting for accessibility/root to start $project\n")
        thread(name = "xscript-boot") {
            val deadline = SystemClock.elapsedRealtime() + BOOT_WAIT_MS
            while (!Automation.ready() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(1000)
            // Give launchers and the accessibility tree a moment to settle.
            SystemClock.sleep(3000)
            launch(context, project, "boot")
        }
    }
}
