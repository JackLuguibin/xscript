package com.xscript.app.schedule

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.LocalDateTime
import java.time.ZoneId

class ScheduleTest {
    private val zone: ZoneId = ZoneId.of("Asia/Shanghai")

    private fun ms(text: String): Long = LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli()

    private fun req(vararg pairs: Pair<String, Any>): JSONObject {
        val o = JSONObject().put("project", "demo")
        for ((k, v) in pairs) o.put(k, if (v is List<*>) JSONArray(v) else v)
        return o
    }

    @Test
    fun dailyNextFire() {
        val now = ms("2026-09-30T08:00:00") // Wednesday
        val s = Schedule.fromRequest(req("kind" to "daily", "time" to "08:30"), "a", now, zone)
        assertEquals(ms("2026-09-30T08:30:00"), s.nextAfter(now, zone))
        // Past today's time → tomorrow
        assertEquals(ms("2026-10-01T08:30:00"), s.nextAfter(ms("2026-09-30T08:30:00"), zone))
    }

    @Test
    fun dailyWeekdays() {
        val now = ms("2026-10-02T09:00:00") // Friday, after 08:30
        val s = Schedule.fromRequest(req("kind" to "daily", "time" to "08:30", "weekdays" to listOf(1, 2, 3, 4, 5)), "a", now, zone)
        assertEquals(listOf(1, 2, 3, 4, 5), s.weekdays)
        assertEquals(ms("2026-10-05T08:30:00"), s.nextAfter(now, zone)) // next Monday
    }

    @Test
    fun intervalGridSkipsMissedSlots() {
        val created = ms("2026-09-30T08:00:00")
        val s = Schedule.fromRequest(req("kind" to "interval", "every" to 30), "a", created, zone)
        assertEquals(ms("2026-09-30T08:30:00"), s.nextAfter(created, zone))
        // Late alarm at 09:47 → next grid slot 10:00, not 10:17
        assertEquals(ms("2026-09-30T10:00:00"), s.copy(lastRun = ms("2026-09-30T09:47:00")).nextAfter(ms("2026-09-30T09:47:00"), zone))
    }

    @Test
    fun intervalWindow() {
        val created = ms("2026-09-30T22:00:00")
        val s = Schedule.fromRequest(req("kind" to "interval", "every" to 60, "window" to "08:00-23:00"), "a", created, zone)
        // 23:00 is the window end (exclusive), so the next slot is the window opening tomorrow.
        assertEquals(ms("2026-10-01T08:00:00"), s.nextAfter(ms("2026-09-30T22:30:00"), zone))
        assertEquals(ms("2026-10-01T08:00:00"), s.nextAfter(ms("2026-10-01T03:00:00"), zone))
        // Window crossing midnight
        val night = Schedule.fromRequest(req("kind" to "interval", "every" to 60, "window" to "22:00-02:00"), "b", created, zone)
        assertEquals(ms("2026-10-01T01:00:00"), night.nextAfter(ms("2026-10-01T00:10:00"), zone))
        assertEquals(ms("2026-10-01T22:00:00"), night.nextAfter(ms("2026-10-01T02:10:00"), zone))
    }

    @Test
    fun onceFiresOnlyOnce() {
        val now = ms("2026-09-30T08:00:00")
        val s = Schedule.fromRequest(req("kind" to "once", "at" to "2026-09-30 12:00"), "a", now, zone)
        assertEquals(ms("2026-09-30T12:00:00"), s.at)
        assertEquals(s.at, s.nextAfter(now, zone))
        assertNull(s.copy(lastRun = s.at).nextAfter(now, zone))
        assertThrows(IllegalArgumentException::class.java) {
            Schedule.fromRequest(req("kind" to "once", "at" to "2026-09-29 12:00"), "b", now, zone)
        }
    }

    @Test
    fun disabledNeverFires() {
        val now = ms("2026-09-30T08:00:00")
        val s = Schedule.fromRequest(req("kind" to "daily", "time" to "09:00", "enabled" to false), "a", now, zone)
        assertNull(s.nextAfter(now, zone))
    }

    @Test
    fun validation() {
        val now = ms("2026-09-30T08:00:00")
        val bad = listOf(
            req("kind" to "daily", "time" to "25:00"),
            req("kind" to "daily", "time" to "08:00", "weekdays" to listOf(0)),
            req("kind" to "interval", "every" to 0),
            req("kind" to "interval", "every" to 10, "window" to "08:00"),
            req("kind" to "weekly"),
            req("kind" to "daily", "time" to "08:00", "if_running" to "queue"),
            JSONObject().put("kind", "daily").put("time", "08:00"), // no project
        )
        for (r in bad) {
            assertThrows(r.toString(), IllegalArgumentException::class.java) { Schedule.fromRequest(r, "x", now, zone) }
        }
    }

    @Test
    fun updateKeepsIdentityAndRestartsGridOnNewPeriod() {
        val t0 = ms("2026-09-30T08:00:00")
        val s = Schedule.fromRequest(req("kind" to "interval", "every" to 30), "a", t0, zone).copy(lastRun = t0 + 1)
        val t1 = ms("2026-09-30T09:10:00")
        val same = Schedule.fromRequest(JSONObject().put("enabled", false), "a", t1, zone, s)
        assertEquals(t0, same.created)
        assertEquals(t0 + 1, same.lastRun)
        assertFalse(same.enabled)
        val changed = Schedule.fromRequest(JSONObject().put("every", 15), "a", t1, zone, s)
        assertEquals(t1, changed.created)
        assertEquals(0L, changed.lastRun)
    }

    @Test
    fun jsonRoundTrip() {
        val now = ms("2026-09-30T08:00:00")
        val s = Schedule.fromRequest(req("kind" to "daily", "time" to "07:05", "weekdays" to listOf(6, 7), "if_running" to "restart", "wake" to false), "a", now, zone)
        assertEquals(s, Schedule.fromJson(JSONObject(s.toJson().toString())))
        assertEquals("每天 07:05 (六日)", s.label())
    }
}

class ScheduleStoreTest {
    private lateinit var dir: File
    private val zone = ZoneId.of("UTC")

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("sched").toFile()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun crudPersists() {
        val file = File(dir, "schedules.json")
        val store = ScheduleStore(file) { zone }
        val a = store.add(JSONObject().put("project", "p1").put("kind", "daily").put("time", "08:00"), 1000L)
        val b = store.add(JSONObject().put("project", "p2").put("kind", "interval").put("every", 5), 1000L)
        assertEquals(2, store.list().size)
        assertEquals(listOf(b.id), store.list("p2").map { it.id })

        val reopened = ScheduleStore(file) { zone }
        assertEquals(setOf(a.id, b.id), reopened.list().map { it.id }.toSet())
        assertEquals("09:00", reopened.update(a.id, JSONObject().put("time", "09:00"), 2000L).time)
        assertTrue(reopened.remove(a.id))
        assertFalse(reopened.remove(a.id))
        assertEquals(1, reopened.removeProject("p2"))
        assertTrue(reopened.list().isEmpty())
    }

    @Test
    fun corruptFileReadsAsEmpty() {
        val file = File(dir, "schedules.json")
        file.writeText("{not json")
        assertTrue(ScheduleStore(file) { zone }.list().isEmpty())
    }

    @Test
    fun updateMissingThrows() {
        val store = ScheduleStore(File(dir, "s.json")) { zone }
        assertThrows(IllegalArgumentException::class.java) { store.update("nope", JSONObject(), 0L) }
    }
}
