package com.xscript.app.project

import com.xscript.app.project.PermissionNeeds.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PermissionGuideTest {
    @Test
    fun `walks the missing permissions in order, accessibility first`() {
        val granted = mutableSetOf(Kind.STORAGE)
        val ok = { k: Kind -> k in granted }
        val g = PermissionGuide(listOf(Kind.OVERLAY, Kind.CAPTURE, Kind.STORAGE, Kind.ACCESSIBILITY), ok)
        assertEquals(3, g.total)
        assertEquals(Kind.ACCESSIBILITY, g.next(ok))
        assertEquals(1, g.stepNumber())
        g.opened(Kind.ACCESSIBILITY)
        granted += Kind.ACCESSIBILITY
        assertEquals(Kind.CAPTURE, g.next(ok))
        assertEquals(2, g.stepNumber())
        g.opened(Kind.CAPTURE)
        granted += Kind.CAPTURE
        assertEquals(Kind.OVERLAY, g.next(ok))
        g.opened(Kind.OVERLAY)
        granted += Kind.OVERLAY
        assertNull(g.next(ok))
        assertEquals(emptyList<Kind>(), g.remaining(ok))
    }

    @Test
    fun `a step granted meanwhile drops out (accessibility also enables capture)`() {
        val granted = mutableSetOf<Kind>()
        val ok = { k: Kind -> k in granted || (k == Kind.CAPTURE && Kind.ACCESSIBILITY in granted) }
        val g = PermissionGuide(listOf(Kind.CAPTURE, Kind.ACCESSIBILITY, Kind.NOTIFICATIONS), ok)
        assertEquals(3, g.total)
        g.opened(g.next(ok)!!)
        granted += Kind.ACCESSIBILITY
        assertEquals(Kind.NOTIFICATIONS, g.next(ok))
    }

    @Test
    fun `skipped or still denied steps are offered once and reported at the end`() {
        val ok = { _: Kind -> false }
        val g = PermissionGuide(listOf(Kind.ACCESSIBILITY, Kind.OVERLAY), ok)
        g.skip(g.next(ok)!!)
        g.opened(g.next(ok)!!) // came back without granting
        assertNull(g.next(ok))
        assertEquals(listOf(Kind.ACCESSIBILITY), g.skipped())
        assertEquals(listOf(Kind.ACCESSIBILITY, Kind.OVERLAY), g.remaining(ok))
        assertEquals(2, g.stepNumber())
    }

    @Test
    fun `nothing missing`() {
        val g = PermissionGuide(listOf(Kind.ACCESSIBILITY), { true })
        assertEquals(0, g.total)
        assertNull(g.next { true })
    }
}
