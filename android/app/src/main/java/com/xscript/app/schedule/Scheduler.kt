package com.xscript.app.schedule

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import com.xscript.app.http.DeviceHttpService
import com.xscript.app.runtime.LogBuffer
import com.xscript.app.runtime.ScriptSupervisor
import com.xscript.app.settings.Settings
import java.io.File
import java.time.ZoneId
import kotlin.concurrent.thread

/**
 * Arms one AlarmManager alarm for the earliest enabled schedule and runs due schedules when it
 * fires. Uses exact alarms when the app may (Android 12+ needs 闹钟和提醒 / SCHEDULE_EXACT_ALARM),
 * otherwise inexact "allow while idle" alarms that Doze may delay by several minutes.
 */
object Scheduler {
    private const val ACTION_FIRE = "com.xscript.app.SCHEDULE_FIRE"
    /** Slack when deciding which schedules are due: alarms may fire slightly early or late. */
    private const val DUE_SLACK_MS = 30_000L
    /** Missed by more than this (device off, app killed) → skip the run and move on. */
    private const val MAX_LATE_MS = 10 * 60_000L

    @Volatile private var storeRef: ScheduleStore? = null

    fun store(context: Context): ScheduleStore =
        storeRef ?: synchronized(this) {
            storeRef ?: ScheduleStore(File(context.filesDir, "schedules.json")).also { storeRef = it }
        }

    fun canExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 31) return true
        return alarms(context).canScheduleExactAlarms()
    }

    /** Recompute every schedule's next fire time and arm the earliest one. */
    fun rearm(context: Context, now: Long = System.currentTimeMillis()) {
        val zone = ZoneId.systemDefault()
        val all = store(context).rewrite { list -> list.map { it.copy(next = it.nextAfter(now, zone) ?: 0L) } }
        arm(context, all)
    }

    private fun arm(context: Context, all: List<Schedule>) {
        val am = alarms(context)
        val pi = pending(context)
        val next = all.filter { it.enabled && it.next > 0 }.minOfOrNull { it.next }
        am.cancel(pi)
        if (next == null) return
        try {
            if (canExact(context)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
            }
        } catch (e: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
        }
    }

    /** Alarm fired: run due schedules, advance them, and arm the next alarm. */
    fun fire(context: Context) {
        val now = System.currentTimeMillis()
        val zone = ZoneId.systemDefault()
        val due = mutableListOf<Schedule>()
        val all = store(context).rewrite { list ->
            list.map { s ->
                if (!s.enabled || s.next <= 0 || s.next > now + DUE_SLACK_MS) {
                    s
                } else {
                    val late = now - s.next
                    if (late <= MAX_LATE_MS) due.add(s)
                    else LogBuffer.append(context, "stdout", "xscript: schedule ${s.id} (${s.project}) missed by ${late / 60000} min, skipped\n")
                    val ran = s.copy(lastRun = now)
                    val next = ran.nextAfter(now + DUE_SLACK_MS, zone) ?: 0L
                    ran.copy(next = next, enabled = if (s.kind == Schedule.KIND_ONCE) false else s.enabled)
                }
            }
        }
        arm(context, all)
        // One script runs at a time: the first due schedule wins, the rest are logged as skipped.
        for (s in due) {
            if (s.wake) wake(context)
            val result = ScriptSupervisor.launch(context, s.project, "schedule ${s.id}", restart = s.ifRunning == Schedule.IF_RUNNING_RESTART)
            if (result == "started" || result == "queued") {
                due.filter { it !== s }.forEach {
                    LogBuffer.append(context, "stdout", "xscript: schedule ${it.id}: skipped ${it.project}, ${s.project} started at the same time\n")
                }
                break
            }
        }
    }

    /** A project was deleted: drop its schedules and its boot / rerun settings. */
    fun forgetProject(context: Context, project: String) {
        if (store(context).removeProject(project) > 0) rearm(context)
        if (Settings.bootProject == project) Settings.bootProject = ""
        val rerun = Settings.rerunProjects
        if (project in rerun) Settings.rerunProjects = rerun - project
    }

    /** Runs a schedule immediately (HTTP `POST /schedules/<id>/run`, the project screen). */
    fun runNow(context: Context, id: String): String {
        val s = store(context).get(id) ?: throw IllegalArgumentException("missing schedule $id")
        return ScriptSupervisor.launch(context, s.project, "schedule ${s.id}", restart = s.ifRunning == Schedule.IF_RUNNING_RESTART)
    }

    @Suppress("DEPRECATION")
    private fun wake(context: Context) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isInteractive) return
        val wl = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "xscript:schedule",
        )
        wl.acquire(10_000)
    }

    private fun alarms(context: Context) = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        1,
        Intent(context, Receiver::class.java).setAction(ACTION_FIRE),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** Alarm, boot, clock and time-zone changes. */
    class Receiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val app = context.applicationContext
            val done = goAsync()
            thread(name = "xscript-schedule") {
                try {
                    when (intent.action) {
                        ACTION_FIRE -> fire(app)
                        Intent.ACTION_BOOT_COMPLETED, "android.intent.action.QUICKBOOT_POWERON" -> {
                            rearm(app)
                            // Keep the device API reachable after reboot when the device is set up
                            // to work unattended (boot project or schedules).
                            if (Settings.bootProject.isNotEmpty() || store(app).list().any { it.enabled }) {
                                try {
                                    DeviceHttpService.start(app)
                                } catch (_: Exception) {
                                }
                            }
                            ScriptSupervisor.bootRun(app)
                        }
                        else -> rearm(app)
                    }
                } finally {
                    done.finish()
                }
            }
        }
    }
}
