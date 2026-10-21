package com.xscript.app.runtime

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 最近运行: the last runs of each project (start, duration, how it ended, and the log range), kept in
 * filesDir/run_history.json by the main process when a run ends. Pure helpers are separate for tests.
 */
object RunHistory {
    const val PER_PROJECT = 20

    /** [logFrom] / [logTo]: the run's log lines are the entries with logFrom < seq <= logTo. */
    data class Record(
        val project: String,
        val start: Long,
        val durationMs: Long,
        val exit: String,
        val userStop: Boolean,
        val logFrom: Long,
        val logTo: Long,
        /** From the run's 运行统计 line; null when the run printed none (stopped, killed, older runtime). */
        val stats: Stats? = null,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("project", project).put("start", start).put("duration_ms", durationMs)
            .put("exit", exit).put("user_stop", userStop).put("log_from", logFrom).put("log_to", logTo)
            .also { o -> stats?.let { o.put("stats", it.toJson()) } }

        /** The HTTP view (GET /projects/{name}/runs): adds the readable outcome and a failed flag. */
        fun toApi(): JSONObject = toJson().put("outcome", outcome(exit, userStop)).put("failed", failed(exit, userStop))
    }

    /** Captures, average capture time and peak memory of one run (peakMb 0 = unknown). */
    data class Stats(val captures: Int, val captureAvgMs: Int, val peakMb: Int) {
        fun toJson(): JSONObject = JSONObject().put("captures", captures).put("capture_avg_ms", captureAvgMs).put("peak_mb", peakMb)

        /** "截图 5 次 · 均 309ms · 176MB" (short enough for one row line next to the outcome) */
        fun label(): String = (if (captures > 0) "截图 $captures 次 · 均 ${captureAvgMs}ms" else "未截图") +
            (if (peakMb > 0) " · ${peakMb}MB" else "")
    }

    private val STATS_LINE = Regex("""xscript: 运行统计 .*?截图 (\d+) 次(?:（平均 (\d+)ms）)?(?:.*?峰值内存 (\d+)MB)?""")

    /** Parses the runtime's summary line (`xscript: 运行统计 用时 1.8s · 截图 5 次（平均 309ms） · 峰值内存 176MB`). */
    fun parseStats(line: String): Stats? {
        val m = STATS_LINE.find(line) ?: return null
        return Stats(m.groupValues[1].toInt(), m.groupValues[2].toIntOrNull() ?: 0, m.groupValues[3].toIntOrNull() ?: 0)
    }

    /** How the run ended, as shown in the list. */
    fun outcome(exit: String, userStop: Boolean): String = when {
        userStop -> "已停止"
        exit == "0" -> "正常结束"
        exit == "died" -> "进程意外退出"
        exit == "stopped" -> "已停止"
        else -> "出错退出（退出码 $exit）"
    }

    /** True when the run should be shown as a failure. */
    fun failed(exit: String, userStop: Boolean): Boolean = !userStop && exit != "0" && exit != "stopped"

    fun duration(ms: Long): String {
        val s = (ms.coerceAtLeast(0L) + 500) / 1000
        return when {
            s < 60 -> "${s} 秒"
            s < 3600 -> "${s / 60} 分 ${s % 60} 秒"
            else -> "${s / 3600} 小时 ${s % 3600 / 60} 分"
        }
    }

    /** Newest first; keeps at most [perProject] records of each project. */
    fun add(list: List<Record>, r: Record, perProject: Int = PER_PROJECT): List<Record> {
        val out = ArrayList<Record>(list.size + 1)
        out.add(r)
        var same = 1
        for (x in list) {
            if (x.project == r.project) {
                if (same >= perProject) continue
                same++
            }
            out.add(x)
        }
        return out
    }

    fun parse(text: String): List<Record> {
        val arr = try { JSONArray(text) } catch (_: Exception) { return emptyList() }
        val out = ArrayList<Record>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val project = o.optString("project")
            if (project.isEmpty()) continue
            val st = o.optJSONObject("stats")?.let { Stats(it.optInt("captures"), it.optInt("capture_avg_ms"), it.optInt("peak_mb")) }
            out.add(Record(project, o.optLong("start"), o.optLong("duration_ms"), o.optString("exit", "0"),
                o.optBoolean("user_stop"), o.optLong("log_from"), o.optLong("log_to"), st))
        }
        return out
    }

    /** Only the runs that ended in an error (not stopped by the user, not exit 0) when [failedOnly]. */
    fun only(list: List<Record>, failedOnly: Boolean): List<Record> =
        if (failedOnly) list.filter { failed(it.exit, it.userStop) } else list

    /** `{"runs":[...]}`, newest first. */
    fun api(list: List<Record>): JSONObject = JSONObject().put("runs", JSONArray().apply { list.forEach { put(it.toApi()) } })

    fun encode(list: List<Record>): String = JSONArray().apply { list.forEach { put(it.toJson()) } }.toString()

    // ------------------------------------------------------------------ storage (main process)

    private val lock = Any()

    private fun file(context: Context) = File(context.filesDir, "run_history.json")

    fun record(context: Context, r: Record) {
        synchronized(lock) {
            val f = file(context)
            val list = if (f.exists()) parse(f.readText()) else emptyList()
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(encode(add(list, r)))
            tmp.renameTo(f)
        }
    }

    fun of(context: Context, project: String): List<Record> = synchronized(lock) {
        val f = file(context)
        if (f.exists()) parse(f.readText()).filter { it.project == project } else emptyList()
    }
}
