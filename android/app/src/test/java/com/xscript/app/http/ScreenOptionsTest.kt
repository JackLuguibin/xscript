package com.xscript.app.http

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenOptionsTest {
    private fun p(vararg kv: Pair<String, String>, w: Int = 1080, h: Int = 2400) = ScreenOptions.parse(mapOf(*kv), w, h)

    @Test
    fun formatAndQuality() {
        assertEquals(ScreenOptions(false, 100, 1080, 2400), p())
        assertEquals("image/png", p().mime)
        assertEquals(ScreenOptions(true, 80, 1080, 2400), p("format" to "jpg"))
        assertEquals("image/jpeg", p("format" to "JPEG").mime)
        assertEquals(50, p("format" to "jpeg", "quality" to "50").quality)
        assertEquals(1, p("format" to "jpg", "quality" to "-5").quality)
        assertEquals(100, p("format" to "jpg", "quality" to "500").quality)
        assertEquals(80, p("format" to "jpg", "quality" to "abc").quality)
        assertEquals("PNG ignores quality", 100, p("quality" to "10").quality)
        assertFalse(p("format" to "webp").jpeg)
    }

    @Test
    fun longestSideLimitKeepsAspectAndNeverUpscales() {
        val s = p("max" to "480")
        assertEquals(216, s.width)
        assertEquals(480, s.height)
        val landscape = p("max" to "480", w = 2400, h = 1080)
        assertEquals(480 to 216, landscape.width to landscape.height)
        assertEquals(1080 to 2400, p("max" to "4096").let { it.width to it.height })
        assertEquals("max is clamped to >= 64", 64, p("max" to "1").height)
        assertEquals(2400, p("max" to "nope").height)
        val tiny = p("max" to "64", w = 10000, h = 50)
        assertEquals(64, tiny.width)
        assertTrue("never 0 px", tiny.height >= 1)
        assertEquals(0 to 0, p("max" to "100", w = 0, h = 0).let { it.width to it.height })
    }
}
