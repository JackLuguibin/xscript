package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeModelTest {
    @Test
    fun runningProjectOffersStop() {
        val c = HomeModel.runCard(running = "demo", last = "other")
        assertEquals("demo", c.title)
        assertEquals("停止", c.action)
        assertEquals(UiKit.Tone.DANGER, c.tone)
        assertTrue(c.running)
    }

    @Test
    fun lastProjectOffersRun() {
        val c = HomeModel.runCard(running = null, last = "demo")
        assertEquals("demo", c.title)
        assertEquals("运行", c.action)
        assertEquals(UiKit.Tone.SUCCESS, c.tone)
        assertFalse(c.running)
    }

    @Test
    fun withoutAProjectTheActionIsChooseNotRun() {
        val c = HomeModel.runCard(running = null, last = null)
        assertEquals("选择", c.action)
        assertEquals(UiKit.Tone.PRIMARY, c.tone)
        assertFalse(c.running)
    }

    @Test
    fun sameStateGivesAnEqualCard() {
        // refresh() runs every 1.5 s; equal cards mean setText/paint see no change and the idle screen is not redrawn.
        assertEquals(HomeModel.runCard(null, "demo"), HomeModel.runCard(null, "demo"))
    }

    @Test
    fun permissionSummary() {
        assertEquals("已开启 3/7", HomeModel.permissionSummary(3, 7))
        assertEquals("全部已开启", HomeModel.permissionSummary(7, 7))
        assertEquals("已开启 0/7", HomeModel.permissionSummary(0, 7))
    }
}
