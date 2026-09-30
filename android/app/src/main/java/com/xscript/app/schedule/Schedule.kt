package com.xscript.app.schedule

import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * One timed run of a project. Pure data + next-fire computation, so it is unit-tested on the JVM.
 *
 * kind:
 * - `daily`: at [time] ("HH:mm"), on [weekdays] (1 = Monday .. 7 = Sunday; empty = every day).
 * - `interval`: every [every] minutes on a fixed grid from [created], optionally only inside
 *   [window] ("HH:mm-HH:mm", may cross midnight). Slots outside the window move to its opening.
 * - `once`: at [at] (epoch ms). Disabled after it fires.
 */
data class Schedule(
    val id: String,
    val project: String,
    val kind: String,
    val time: String = "",
    val weekdays: List<Int> = emptyList(),
    val every: Int = 0,
    val window: String = "",
    val at: Long = 0L,
    val ifRunning: String = IF_RUNNING_SKIP,
    val wake: Boolean = true,
    val enabled: Boolean = true,
    val created: Long = 0L,
    val lastRun: Long = 0L,
    /** Next fire time computed at the last arm (0 = none). Used to decide which tasks are due. */
    val next: Long = 0L,
) {
    /** First fire time strictly after [now], or null when the task will not fire again. */
    fun nextAfter(now: Long, zone: ZoneId): Long? {
        if (!enabled) return null
        return when (kind) {
            KIND_ONCE -> if (lastRun == 0L && at > now) at else null
            KIND_DAILY -> nextDaily(now, zone)
            KIND_INTERVAL -> nextInterval(now, zone)
            else -> null
        }
    }

    private fun nextDaily(now: Long, zone: ZoneId): Long? {
        val t = parseTime(time) ?: return null
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        for (offset in 0..7L) {
            val date = today.plusDays(offset)
            if (weekdays.isNotEmpty() && date.dayOfWeek.value !in weekdays) continue
            val at = date.atTime(t).atZone(zone).toInstant().toEpochMilli()
            if (at > now) return at
        }
        return null
    }

    private fun nextInterval(now: Long, zone: ZoneId): Long? {
        if (every <= 0) return null
        val step = every * 60_000L
        // Fixed grid from creation, so late or inexact alarms do not drift later runs.
        val base = created
        // Next point on the grid base + k*step that is after `now` (missed slots are skipped).
        val candidate = if (base + step > now) base + step else base + ((now - base) / step + 1) * step
        val win = parseWindow(window) ?: return candidate
        val local = Instant.ofEpochMilli(candidate).atZone(zone)
        if (inWindow(local.toLocalTime(), win)) return candidate
        // Outside the window: the next window opening after the candidate.
        val date: LocalDate = local.toLocalDate()
        val sameDay = date.atTime(win.first).atZone(zone).toInstant().toEpochMilli()
        return if (sameDay > candidate) sameDay else date.plusDays(1).atTime(win.first).atZone(zone).toInstant().toEpochMilli()
    }

    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("project", project)
        .put("kind", kind)
        .put("time", time)
        .put("weekdays", JSONArray(weekdays))
        .put("every", every)
        .put("window", window)
        .put("at", at)
        .put("if_running", ifRunning)
        .put("wake", wake)
        .put("enabled", enabled)
        .put("created", created)
        .put("last_run", lastRun)
        .put("next", next)

    /** Short Chinese label for the project screen, e.g. "每天 08:30 (一至五)". */
    fun label(): String = when (kind) {
        KIND_DAILY -> "每天 $time" + if (weekdays.isEmpty() || weekdays.size == 7) "" else " (" + weekdays.joinToString("") { WEEK_LABELS[it - 1] } + ")"
        KIND_INTERVAL -> "每 $every 分钟" + if (window.isNotEmpty()) " ($window)" else ""
        KIND_ONCE -> "一次 " + LocalDateTime.ofInstant(Instant.ofEpochMilli(at), ZoneId.systemDefault()).format(LABEL_FORMAT)
        else -> kind
    }

    companion object {
        const val KIND_DAILY = "daily"
        const val KIND_INTERVAL = "interval"
        const val KIND_ONCE = "once"
        const val IF_RUNNING_SKIP = "skip"
        const val IF_RUNNING_RESTART = "restart"

        private val WEEK_LABELS = arrayOf("一", "二", "三", "四", "五", "六", "日")
        private val LABEL_FORMAT = DateTimeFormatter.ofPattern("MM-dd HH:mm")
        private val AT_FORMATS = listOf(
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"),
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"),
            DateTimeFormatter.ISO_LOCAL_DATE_TIME,
        )

        fun parseTime(text: String): LocalTime? {
            val m = Regex("^(\\d{1,2}):(\\d{2})(?::(\\d{2}))?$").matchEntire(text.trim()) ?: return null
            val h = m.groupValues[1].toInt()
            val min = m.groupValues[2].toInt()
            val s = m.groupValues[3].toIntOrNull() ?: 0
            if (h > 23 || min > 59 || s > 59) return null
            return LocalTime.of(h, min, s)
        }

        fun parseWindow(text: String): Pair<LocalTime, LocalTime>? {
            if (text.isBlank()) return null
            val parts = text.split('-')
            require(parts.size == 2) { "window must be HH:mm-HH:mm" }
            val a = requireNotNull(parseTime(parts[0])) { "bad window start" }
            val b = requireNotNull(parseTime(parts[1])) { "bad window end" }
            require(a != b) { "window start and end must differ" }
            return a to b
        }

        fun inWindow(t: LocalTime, win: Pair<LocalTime, LocalTime>): Boolean {
            val (a, b) = win
            return if (a < b) !t.isBefore(a) && t.isBefore(b) else !t.isBefore(a) || t.isBefore(b)
        }

        /** `at` as epoch ms: a number, or a local date-time string in [zone]. */
        fun parseAt(value: Any?, zone: ZoneId): Long {
            when (value) {
                is Number -> return value.toLong()
                is String -> {
                    val text = value.trim()
                    text.toLongOrNull()?.let { return it }
                    for (f in AT_FORMATS) {
                        try {
                            return LocalDateTime.parse(text, f).atZone(zone).toInstant().toEpochMilli()
                        } catch (_: DateTimeParseException) {
                        }
                    }
                    throw IllegalArgumentException("at must be epoch ms or 'yyyy-MM-dd HH:mm'")
                }
                else -> throw IllegalArgumentException("at is required for kind=once")
            }
        }

        /**
         * Build a validated schedule from client JSON. [existing] supplies id/created/last_run when
         * updating. Throws IllegalArgumentException with a readable message on bad input.
         */
        fun fromRequest(o: JSONObject, id: String, now: Long, zone: ZoneId, existing: Schedule? = null): Schedule {
            val project = o.optString("project", existing?.project.orEmpty()).trim()
            require(project.isNotEmpty()) { "project is required" }
            val kind = o.optString("kind", existing?.kind.orEmpty()).trim().lowercase()
            val ifRunning = o.optString("if_running", existing?.ifRunning ?: IF_RUNNING_SKIP)
            require(ifRunning == IF_RUNNING_SKIP || ifRunning == IF_RUNNING_RESTART) { "if_running must be skip or restart" }
            val base = Schedule(
                id = id,
                project = project,
                kind = kind,
                ifRunning = ifRunning,
                wake = o.optBoolean("wake", existing?.wake ?: true),
                enabled = o.optBoolean("enabled", existing?.enabled ?: true),
                created = existing?.created ?: now,
                lastRun = existing?.lastRun ?: 0L,
            )
            return when (kind) {
                KIND_DAILY -> {
                    val time = o.optString("time", existing?.time.orEmpty())
                    requireNotNull(parseTime(time)) { "time must be HH:mm" }
                    val days = mutableListOf<Int>()
                    o.optJSONArray("weekdays")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val d = arr.getInt(i)
                            require(d in DayOfWeek.MONDAY.value..DayOfWeek.SUNDAY.value) { "weekdays are 1 (Mon) .. 7 (Sun)" }
                            if (d !in days) days.add(d)
                        }
                    } ?: existing?.weekdays?.let { days.addAll(it) }
                    base.copy(time = time, weekdays = days.sorted())
                }
                KIND_INTERVAL -> {
                    val every = if (o.has("every")) o.getInt("every") else existing?.every ?: 0
                    require(every in 1..(7 * 24 * 60)) { "every must be 1..10080 minutes" }
                    val window = o.optString("window", existing?.window.orEmpty()).trim()
                    parseWindow(window)
                    // A changed period restarts the grid from now.
                    val restart = existing == null || existing.every != every
                    base.copy(every = every, window = window, created = if (restart) now else base.created, lastRun = if (restart) 0L else base.lastRun)
                }
                KIND_ONCE -> {
                    val at = if (o.has("at")) parseAt(o.get("at"), zone) else existing?.at ?: parseAt(null, zone)
                    require(at > now) { "at is in the past" }
                    base.copy(at = at, lastRun = if (existing?.at == at) base.lastRun else 0L, enabled = o.optBoolean("enabled", true))
                }
                else -> throw IllegalArgumentException("kind must be daily, interval or once")
            }
        }

        fun fromJson(o: JSONObject): Schedule {
            val days = mutableListOf<Int>()
            o.optJSONArray("weekdays")?.let { for (i in 0 until it.length()) days.add(it.getInt(i)) }
            return Schedule(
                id = o.getString("id"),
                project = o.getString("project"),
                kind = o.getString("kind"),
                time = o.optString("time"),
                weekdays = days,
                every = o.optInt("every"),
                window = o.optString("window"),
                at = o.optLong("at"),
                ifRunning = o.optString("if_running", IF_RUNNING_SKIP),
                wake = o.optBoolean("wake", true),
                enabled = o.optBoolean("enabled", true),
                created = o.optLong("created"),
                lastRun = o.optLong("last_run"),
                next = o.optLong("next"),
            )
        }
    }
}
