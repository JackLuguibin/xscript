package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.http.HttpTimeoutException

class FollowLoopTest {
    /** Plays a script of tick outcomes: true/false = more/finished, an exception = thrown. */
    private class Ticks(vararg steps: Any) {
        val left = ArrayDeque(steps.toList())
        var calls = 0
        fun tick(): Boolean {
            calls++
            return when (val s = left.removeFirst()) {
                is Boolean -> s
                is Exception -> throw s
                else -> error("bad step $s")
            }
        }
    }

    private val slept = mutableListOf<Long>()
    private val events = mutableListOf<String>()

    private fun run(t: Ticks, alive: () -> Boolean = { true }) = followLoop(
        tick = t::tick, alive = alive, sleep = { slept += it }, pollMs = 700, delays = listOf(1, 2, 4),
        onLost = { events += "lost" }, onBack = { events += "back" },
    )

    @Test
    fun `finishes normally without reconnect messages`() {
        assertSame(FollowEnd.Finished, run(Ticks(true, true, false)))
        assertEquals(listOf(700L, 700L), slept)
        assertTrue(events.isEmpty())
    }

    @Test
    fun `a short outage reconnects once and keeps following`() {
        val t = Ticks(true, ConnectException("refused"), ConnectException("refused"), true, false)
        assertSame(FollowEnd.Finished, run(t))
        assertEquals(listOf("lost", "back"), events)
        assertEquals(listOf(700L, 1L, 2L, 700L), slept)
        assertEquals(5, t.calls)
    }

    @Test
    fun `the script finishing during the outage ends the follow`() {
        assertSame(FollowEnd.Finished, run(Ticks(HttpTimeoutException("slow"), false)))
        assertEquals(listOf("lost", "back"), events)
    }

    @Test
    fun `gives up after every delay and reports the last error`() {
        val last = IOException("reset")
        val end = run(Ticks(ConnectException("a"), ConnectException("b"), ConnectException("c"), last))
        assertTrue(end is FollowEnd.Lost)
        assertSame(last, (end as FollowEnd.Lost).error)
        assertEquals(listOf(1L, 2L, 4L), slept)
        assertEquals(listOf("lost"), events)
    }

    @Test
    fun `cancelling during the outage stops quietly`() {
        var alive = true
        val t = Ticks(ConnectException("a"))
        val end = followLoop(t::tick, { alive }, { alive = false }, delays = listOf(1, 2), onLost = { events += "lost" })
        assertSame(FollowEnd.Cancelled, end)
        assertEquals(1, t.calls)
    }

    @Test
    fun `http errors are not retried`() {
        try {
            run(Ticks(DeviceHttpException(500, "boom")))
            fail("expected the HTTP error to propagate")
        } catch (e: DeviceHttpException) {
            assertEquals(500, e.status)
        }
        assertTrue(events.isEmpty())
    }

    @Test
    fun `network failures are unreachable, http replies and bugs are not`() {
        assertTrue(isUnreachable(ConnectException("x")))
        assertTrue(isUnreachable(HttpTimeoutException("x")))
        assertTrue(isUnreachable(IOException("x")))
        assertFalse(isUnreachable(DeviceHttpException(401, "")))
        assertFalse(isUnreachable(IllegalStateException("x")))
    }
}
