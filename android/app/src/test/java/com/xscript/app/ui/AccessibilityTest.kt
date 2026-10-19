package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Touch targets, icons and text scaling of the UiKit building blocks. */
class AccessibilityTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
    private val kit = File(module, "src/main/java/com/xscript/app/ui/UiKit.kt").readText()

    @Test
    fun touchTargetsAreAtLeast48dp() {
        assertEquals(48f, UiKit.MIN_TOUCH_DP)
        // The back arrow is MIN_TOUCH_DP square; title bar actions and buttons are at least that tall.
        assertTrue(kit.contains("LinearLayout.LayoutParams(dp(ctx, MIN_TOUCH_DP), dp(ctx, MIN_TOUCH_DP))"))
        assertEquals(2, Regex("""minHeight = dp\(ctx, MIN_TOUCH_DP\)""").findAll(kit).count())
        assertFalse(kit.contains("dp(ctx, 44f)"))
    }

    @Test
    fun iconsAreVectorsNotTextGlyphs() {
        // "‹" and "›" text glyphs scaled with the font and sat off the baseline; vectors are tinted per theme.
        assertFalse(kit.contains("\"‹\""))
        assertFalse(kit.contains("\"›\""))
        for (name in listOf("ic_ui_back", "ic_ui_chevron")) {
            val xml = File(module, "src/main/res/drawable/$name.xml").readText()
            assertTrue("$name mirrors for RTL", xml.contains("android:autoMirrored=\"true\""))
        }
        assertTrue(kit.contains("contentDescription = \"返回\""))
    }

    @Test
    fun rowValuesWrapInsteadOfTruncating() {
        assertEquals(486, UiKit.valueMaxWidth(1080))
        assertEquals(0, UiKit.valueMaxWidth(0))
        assertFalse("values wrap to two lines at large font scales", kit.contains("TruncateAt.MIDDLE"))
        assertFalse(kit.contains("isSingleLine = true"))
    }

    @Test
    fun titlesAndSectionsAreHeadings() {
        assertEquals(2, Regex("""ViewCompat\.setAccessibilityHeading\(this, true\)""").findAll(kit).count())
    }
}
