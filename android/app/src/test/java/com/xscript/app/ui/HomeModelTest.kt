package com.xscript.app.ui

import com.xscript.app.net.NetworkInfo
import com.xscript.app.net.NetworkInfo.Server

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

    @Test
    fun endpointShowsTheServersRealState() {
        HomeModel.endpoint(Server.RUNNING, "192.168.1.5", 9861).let {
            assertEquals("http://192.168.1.5:9861/", it.value)
            assertFalse(it.warn)
            assertEquals(HomeModel.Tap.COPY, it.tap)
        }
        HomeModel.endpoint(Server.RUNNING, "127.0.0.1", 9860).let {
            assertTrue(it.value.contains("仅 USB"))
            assertTrue(it.warn)
            assertTrue(it.hint!!.contains("adb forward tcp:9860 tcp:9860"))
            assertEquals(HomeModel.Tap.USB_HELP, it.tap)
            assertEquals("adb forward tcp:9860 tcp:9860", HomeModel.forwardCommand(9860))
        }
        HomeModel.endpoint(Server.NO_FREE_PORT, "192.168.1.5", 9860).let {
            assertTrue(it.value.contains("9860–9869"))
            assertTrue(it.warn)
            assertEquals(HomeModel.Tap.RETRY, it.tap)
        }
        HomeModel.endpoint(Server.NOT_STARTED, "192.168.1.5", 9860).let {
            assertEquals(HomeModel.Tap.START, it.tap)
            assertTrue(it.warn)
            assertFalse("never shows an address nobody listens on", it.value.contains("http://"))
        }
        HomeModel.endpoint(Server.STARTING, "192.168.1.5", 9860).let {
            assertFalse(it.warn)
            assertEquals(HomeModel.Tap.NONE, it.tap)
        }
        HomeModel.endpoint(Server.DISABLED, "192.168.1.5", 9860).let {
            assertEquals(HomeModel.Tap.NONE, it.tap)
            assertFalse(it.value.contains("http://"))
        }
    }
}
