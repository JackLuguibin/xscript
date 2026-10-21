package com.xscript.app.capture

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureGrantTest {
    private class Mem(override var wasGranted: Boolean = false) : CaptureGrant.Store

    @Test
    fun systemStopAfterGrantIsReportedOnce() {
        val g = CaptureGrant(Mem())
        g.onGranted()
        assertTrue(g.onSystemStopped())
        assertTrue(g.lost)
        assertFalse(g.onSystemStopped())
    }

    @Test
    fun neverGrantedIsNotALoss() {
        val g = CaptureGrant(Mem())
        assertFalse(g.onSystemStopped())
        assertFalse(g.onProcessStart(grantedNow = false))
        assertFalse(g.lost)
    }

    @Test
    fun restartAfterGrantIsALoss() {
        val store = Mem()
        CaptureGrant(store).onGranted()
        val afterReboot = CaptureGrant(store)
        assertTrue(afterReboot.onProcessStart(grantedNow = false))
        assertTrue(afterReboot.lost)
    }

    @Test
    fun appStopAndRegrantClearLoss() {
        val store = Mem()
        val g = CaptureGrant(store)
        g.onGranted()
        g.onAppStopped()
        assertFalse(g.onSystemStopped())
        assertFalse(CaptureGrant(store).onProcessStart(grantedNow = false))
        g.onGranted()
        g.onSystemStopped()
        g.onGranted()
        assertFalse(g.lost)
    }
}
