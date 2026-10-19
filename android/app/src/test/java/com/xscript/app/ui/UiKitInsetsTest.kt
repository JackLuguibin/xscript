package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Edge-to-edge screens pad for the system bars, cutout and keyboard, and cap their width on large windows. */
class UiKitInsetsTest {
    @Test
    fun barsAndCutoutPadTheScreenTopAndSides() {
        // Portrait: status bar on top, gesture bar at the bottom (the content handles the bottom).
        assertEquals(UiKit.Edges(0, 63, 0, 0), UiKit.screenPadding(UiKit.Edges(0, 63, 0, 126)))
        // Landscape with the cutout on the left and three-button navigation on the right.
        assertEquals(UiKit.Edges(84, 63, 126, 0), UiKit.screenPadding(UiKit.Edges(84, 63, 126, 0)))
    }

    @Test
    fun contentClearsTheNavigationBarOrTheKeyboard() {
        assertEquals(63 + 126, UiKit.contentBottom(63, UiKit.Edges(0, 63, 0, 126), imeBottom = 0))
        // The keyboard includes the navigation bar below it: the taller one counts, they do not add up.
        assertEquals(63 + 900, UiKit.contentBottom(63, UiKit.Edges(0, 63, 0, 126), imeBottom = 900))
        assertEquals(63, UiKit.contentBottom(63, UiKit.Edges(0, 0, 0, 0), imeBottom = 0))
    }

    @Test
    fun columnWidthIsCappedOnLargeWindows() {
        assertEquals(1080, UiKit.cappedWidth(1080, 1680))  // phone: full width
        assertEquals(1680, UiKit.cappedWidth(2560, 1680))  // tablet or landscape: centered column
        assertTrue(UiKit.MAX_CONTENT_DP in 560f..720f)
    }

    @Test
    fun scaffoldDrawsEdgeToEdge() {
        val module = generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
        val kit = File(module, "src/main/java/com/xscript/app/ui/UiKit.kt").readText()
        assertTrue(kit.contains("enableEdgeToEdge("))
        assertTrue(kit.contains("WindowInsetsCompat.Type.ime()"))
        assertFalse("insets are applied explicitly, not with fitsSystemWindows", kit.contains("fitsSystemWindows"))
    }
}
