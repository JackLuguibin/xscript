package com.xscript.app.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RunHistoryTest {
    private fun rec(project: String, start: Long, exit: String = "0", stop: Boolean = false) =
        RunHistory.Record(project, start, 1_000L, exit, stop, start, start + 10)

    @Test
    fun addKeepsNewestFirstAndCapsEachProject() {
        var list = emptyList<RunHistory.Record>()
        for (i in 1..5) list = RunHistory.add(list, rec("a", i.toLong()), perProject = 3)
        list = RunHistory.add(list, rec("b", 100), perProject = 3)
        assertEquals(listOf(100L, 5L, 4L, 3L), list.map { it.start })
        list = RunHistory.add(list, rec("a", 6), perProject = 3)
        assertEquals(listOf(6L, 100L, 5L, 4L), list.map { it.start })
    }

    @Test
    fun jsonRoundTripAndBadInput() {
        val list = listOf(rec("签到", 1_792_000_000_000, "1"), rec("b", 2, "0", stop = true))
        assertEquals(list, RunHistory.parse(RunHistory.encode(list)))
        assertEquals(emptyList<RunHistory.Record>(), RunHistory.parse("not json"))
        assertEquals(emptyList<RunHistory.Record>(), RunHistory.parse("[{\"start\":1}]"))
    }

    @Test
    fun outcomeAndFailure() {
        assertEquals("正常结束", RunHistory.outcome("0", false))
        assertEquals("已停止", RunHistory.outcome("died", true))
        assertEquals("进程意外退出", RunHistory.outcome("died", false))
        assertEquals("出错退出（退出码 1）", RunHistory.outcome("1", false))
        assertTrue(RunHistory.failed("1", false))
        assertTrue(RunHistory.failed("died", false))
        assertFalse(RunHistory.failed("0", false))
        assertFalse(RunHistory.failed("1", true))
    }

    @Test
    fun durationText() {
        assertEquals("0 秒", RunHistory.duration(-5))
        assertEquals("2 秒", RunHistory.duration(1_600))
        assertEquals("1 分 12 秒", RunHistory.duration(72_000))
        assertEquals("2 小时 5 分", RunHistory.duration(7_500_000))
    }
}
