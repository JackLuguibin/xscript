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
    fun failedOnlyKeepsErrorsAndOrder() {
        val list = listOf(rec("p", 5, "1"), rec("p", 4, "0"), rec("p", 3, "stopped", stop = true), rec("p", 2, "died"), rec("p", 1, "0"))
        assertEquals(listOf(5L, 2L), RunHistory.only(list, true).map { it.start })
        assertEquals(list, RunHistory.only(list, false))
    }

    @Test
    fun durationText() {
        assertEquals("0 秒", RunHistory.duration(-5))
        assertEquals("2 秒", RunHistory.duration(1_600))
        assertEquals("1 分 12 秒", RunHistory.duration(72_000))
        assertEquals("2 小时 5 分", RunHistory.duration(7_500_000))
    }

    @Test
    fun parsesTheSummaryLine() {
        assertEquals(RunHistory.Stats(5, 309, 176),
            RunHistory.parseStats("xscript: 运行统计 用时 1.8s · 截图 5 次（平均 309ms） · 峰值内存 176MB\n"))
        assertEquals(RunHistory.Stats(0, 0, 119), RunHistory.parseStats("xscript: 运行统计 用时 0.1s · 截图 0 次 · 峰值内存 119MB"))
        assertEquals(RunHistory.Stats(3, 20, 0), RunHistory.parseStats("xscript: 运行统计 用时 2.0s · 截图 3 次（平均 20ms）"))
        assertEquals(null, RunHistory.parseStats("xscript: finished a"))
        assertEquals("截图 5 次 · 均 309ms · 176MB", RunHistory.Stats(5, 309, 176).label())
        assertEquals("未截图", RunHistory.Stats(0, 0, 0).label())
    }

    @Test
    fun statsSurviveJsonAndShowInTheApi() {
        val r = RunHistory.Record("a", 1, 2, "1", false, 3, 4, RunHistory.Stats(1, 2, 3))
        assertEquals(listOf(r), RunHistory.parse(RunHistory.encode(listOf(r))))
        val api = RunHistory.api(listOf(r)).getJSONArray("runs").getJSONObject(0)
        assertEquals("出错退出（退出码 1）", api.getString("outcome"))
        assertTrue(api.getBoolean("failed"))
        assertEquals(3, api.getJSONObject("stats").getInt("peak_mb"))
        assertFalse(RunHistory.api(listOf(r.copy(stats = null))).getJSONArray("runs").getJSONObject(0).has("stats"))
    }
}
