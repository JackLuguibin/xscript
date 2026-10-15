package com.xscript.app.ui

import com.xscript.app.ui.FloatLogic.Dock
import com.xscript.app.ui.FloatLogic.Event
import com.xscript.app.ui.FloatLogic.Reason
import com.xscript.app.ui.FloatLogic.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FloatLogicTest {
    private fun decide(
        permitted: Boolean = true,
        enabled: Boolean = true,
        always: Boolean = false,
        running: Boolean = true,
        foreground: Boolean = false,
        force: Boolean? = null,
    ) = FloatLogic.decide(permitted, enabled, always, running, foreground, force)

    // ---- visibility ----

    @Test fun shownWhileRunningInBackground() {
        val d = decide()
        assertTrue(d.show)
        assertNull(d.reason)
    }

    @Test fun hiddenWhileAppIsOnScreen() {
        val d = decide(foreground = true)
        assertFalse(d.show)
        assertEquals(Reason.FOREGROUND, d.reason)
    }

    @Test fun hiddenWhenScriptEndsUnlessAlways() {
        assertEquals(Reason.IDLE, decide(running = false).reason)
        assertTrue(decide(running = false, always = true).show)
        // "always" still never shows over our own screens
        assertFalse(decide(running = false, always = true, foreground = true).show)
    }

    @Test fun disabledSettingHidesEvenWhileRunning() {
        val d = decide(enabled = false, always = true)
        assertFalse(d.show)
        assertEquals(Reason.DISABLED, d.reason)
    }

    @Test fun deniedPermissionIsAlwaysAQuietNoOp() {
        for (force in listOf(null, true, false)) {
            val d = decide(permitted = false, force = force)
            assertFalse(d.show)
            assertEquals(Reason.NO_PERMISSION, d.reason)
        }
    }

    @Test fun scriptOverridesApplyForTheRun() {
        // ui.float_show(): visible even in the foreground / with the setting off
        assertTrue(decide(force = true, foreground = true, enabled = false).show)
        // ui.float_hide(): hidden although everything else says show
        val d = decide(force = false, always = true)
        assertFalse(d.show)
        assertEquals(Reason.SCRIPT_HIDDEN, d.reason)
    }

    // ---- panel state machine ----

    @Test fun tapTogglesPanelOnlyWhileVisible() {
        var s = State()
        assertEquals(s, FloatLogic.next(s, Event.TAP))
        s = FloatLogic.next(s, Event.SHOW)
        assertTrue(s.visible)
        s = FloatLogic.next(s, Event.TAP)
        assertTrue(s.expanded)
        s = FloatLogic.next(s, Event.TAP)
        assertFalse(s.expanded)
    }

    @Test fun actionCollapsesAndHideResets() {
        var s = State(visible = true, expanded = true)
        s = FloatLogic.next(s, Event.ACTION)
        assertEquals(State(visible = true, expanded = false), s)
        s = FloatLogic.next(State(visible = true, expanded = true), Event.HIDE)
        assertEquals(State(visible = false, expanded = false), s)
        // showing again starts collapsed
        assertFalse(FloatLogic.next(s, Event.SHOW).expanded)
    }

    // ---- position ----

    @Test fun clampKeepsWindowOnScreen() {
        assertEquals(0, FloatLogic.clampY(-50, 100, 2000))
        assertEquals(1900, FloatLogic.clampY(5000, 100, 2000))
        assertEquals(700, FloatLogic.clampY(700, 100, 2000))
        // window taller than the screen: pin to the top instead of crashing
        assertEquals(0, FloatLogic.clampY(300, 3000, 2000))
        assertEquals(0, FloatLogic.clamp(5, 0, -3))
    }

    @Test fun snapsToTheNearerEdge() {
        assertFalse(FloatLogic.snapRight(100, 200, 1080)) // centre at 200 < 540
        assertTrue(FloatLogic.snapRight(700, 200, 1080))
        assertTrue(FloatLogic.snapRight(440, 200, 1080)) // centre exactly in the middle → right
        assertEquals(0, FloatLogic.dockX(false, 200, 1080))
        assertEquals(880, FloatLogic.dockX(true, 200, 1080))
        assertEquals(0, FloatLogic.dockX(true, 2000, 1080))
    }

    @Test fun dropAndRestoreRoundTrip() {
        val w = 300; val h = 120; val sw = 1080; val sh = 2400
        val dock = FloatLogic.dockFor(x = 800, y = 1140, w = w, h = h, screenW = sw, screenH = sh)
        assertTrue(dock.right)
        assertEquals(0.5f, dock.yFrac, 0.001f)
        val (x, y) = FloatLogic.place(dock, w, h, sw, sh)
        assertEquals(sw - w, x)
        assertEquals(1140, y)
    }

    @Test fun placeAdaptsToAnotherScreenSize() {
        val dock = Dock(right = false, yFrac = 0.25f)
        assertEquals(0 to 570, FloatLogic.place(dock, 300, 120, 1080, 2400))
        // after rotating to landscape the fraction keeps it on screen
        val (x, y) = FloatLogic.place(dock, 300, 120, 2400, 1080)
        assertEquals(0, x)
        assertTrue(y in 0..(1080 - 120))
    }

    @Test fun dropOutsideTheScreenIsClamped() {
        val dock = FloatLogic.dockFor(x = -400, y = -90, w = 300, h = 120, screenW = 1080, screenH = 2400)
        assertFalse(dock.right)
        assertEquals(0f, dock.yFrac, 0f)
        val low = FloatLogic.dockFor(x = 5000, y = 9000, w = 300, h = 120, screenW = 1080, screenH = 2400)
        assertTrue(low.right)
        assertEquals(1f, low.yFrac, 0f)
    }

    @Test fun badStoredFractionFallsBack() {
        assertEquals(FloatLogic.DEFAULT_DOCK.yFrac, FloatLogic.clampFrac(Float.NaN), 0f)
        assertEquals(1f, FloatLogic.clampFrac(7f), 0f)
        assertEquals(0f, FloatLogic.clampFrac(-1f), 0f)
    }

    // ---- AScript FloatWindow.show(x, y) ----

    private val cur = Dock(right = false, yFrac = 0.3f)

    private fun resolve(x: Float?, y: Float?) = FloatLogic.resolve(x, y, cur, 300, 100, 1000, 2000)

    @Test fun resolveKeepsTheCurrentDockForNull() {
        assertEquals(cur, resolve(null, null))
        assertEquals(Dock(true, 0.3f), resolve(-1f, null))
        assertEquals(Dock(false, 1f), resolve(null, -1f))
    }

    @Test fun resolveMinusOneIsRightBottomAndZeroIsLeftTop() {
        assertEquals(Dock(true, 1f), resolve(-1f, -1f))
        assertEquals(Dock(false, 0f), resolve(0f, 0f))
    }

    @Test fun resolveFractionsAreShareOfTheScreen() {
        // x = 20% → window centre at 350 of 1000: left half
        assertFalse(resolve(0.2f, 0.4f).right)
        assertTrue(resolve(0.9f, 0.4f).right)
        // y = 40% of 2000 = 800 → 800 / (2000 - 100)
        assertEquals(800f / 1900f, resolve(0.2f, 0.4f).yFrac, 0.001f)
    }

    @Test fun resolvePixelsAreClamped() {
        assertTrue(resolve(900f, 1000f).right)
        assertEquals(1000f / 1900f, resolve(900f, 1000f).yFrac, 0.001f)
        assertEquals(1f, resolve(50f, 99999f).yFrac, 0f)
        assertFalse(resolve(50f, 10f).right)
    }

    // ---- text ----

    @Test fun elapsedFormat() {
        assertEquals("0:00", FloatLogic.formatElapsed(0))
        assertEquals("0:00", FloatLogic.formatElapsed(-5000))
        assertEquals("0:59", FloatLogic.formatElapsed(59_999))
        assertEquals("1:05", FloatLogic.formatElapsed(65_000))
        assertEquals("59:59", FloatLogic.formatElapsed(3_599_000))
        assertEquals("1:00:00", FloatLogic.formatElapsed(3_600_000))
        assertEquals("25:01:02", FloatLogic.formatElapsed((25 * 3600 + 62) * 1000L))
    }
}
