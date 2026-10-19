package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** The color tokens give a Material 3 day/night theme whose text stays readable (WCAG AA) in both modes. */
class ThemeTokensTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
    private val res = File(module, "src/main/res")

    private fun colors(dir: String): Map<String, Long> =
        Regex("""<color name="([^"]+)">#([0-9A-Fa-f]{8})</color>""").findAll(File(res, "$dir/colors.xml").readText())
            .associate { it.groupValues[1] to it.groupValues[2].toLong(16) }

    private fun luminance(argb: Long): Double {
        fun ch(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF) / 255.0
            return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0)
    }

    private fun contrast(a: Long, b: Long): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    @Test
    fun nightDefinesEveryToken() {
        assertEquals(colors("values").keys, colors("values-night").keys)
        val bools = Regex("""<bool name="([^"]+)">""")
        assertEquals(
            bools.findAll(File(res, "values/colors.xml").readText()).map { it.groupValues[1] }.toSet(),
            bools.findAll(File(res, "values-night/colors.xml").readText()).map { it.groupValues[1] }.toSet(),
        )
    }

    @Test
    fun textKeepsAaContrastInBothModes() {
        // (foreground, background): body text, secondary text, status values and links on the page and card
        // backgrounds, and the label of each filled button on its container. AA for normal text is 4.5:1.
        val pairs = listOf(
            "text" to "bg", "text" to "card", "muted" to "bg", "muted" to "card",
            "accent" to "bg", "accent" to "card", "success" to "card", "danger" to "card",
            "on_accent" to "accent", "on_success" to "success", "on_danger" to "danger", "on_neutral" to "neutral",
        )
        for (mode in listOf("values", "values-night")) {
            val c = colors(mode)
            for ((fg, bg) in pairs) {
                val ratio = contrast(c.getValue("xscript_$fg"), c.getValue("xscript_$bg"))
                assertTrue("$mode: $fg on $bg is %.2f:1, below 4.5:1".format(ratio), ratio >= 4.5)
            }
        }
    }

    @Test
    fun darkModeIsDark() {
        val day = colors("values")
        val night = colors("values-night")
        assertTrue(luminance(day.getValue("xscript_bg")) > 0.8)
        assertTrue(luminance(night.getValue("xscript_bg")) < 0.02)
        assertTrue(luminance(night.getValue("xscript_card")) > luminance(night.getValue("xscript_bg")))
    }

    @Test
    fun themeIsMaterial3DayNight() {
        val themes = File(res, "values/themes.xml").readText()
        assertTrue(themes, Regex("""name="Theme.Xscript" parent="Theme.Material3.DayNight""").containsMatchIn(themes))
        assertFalse("status bar icons must follow the mode", themes.contains("windowLightStatusBar\">true"))
    }

    @Test
    fun screensUseTokensAndMaterialDialogs() {
        val src = File(module, "src/main/java/com/xscript/app")
        val kit = File(src, "ui/UiKit.kt").readText()
        assertFalse("UiKit hardcodes a color", Regex("0x[0-9A-Fa-f]{8}").containsMatchIn(kit))
        // Screens of the app's own theme; ScriptUi (script dialogs) and SchemeActivity (translucent) are not.
        val screens = listOf("MainActivity.kt", "ui/ProjectsActivity.kt", "ui/ProjectActivity.kt", "ui/PackActivity.kt",
            "ui/EditorActivity.kt", "ui/LogActivity.kt", "ui/FloatControl.kt")
        for (name in screens) {
            val text = File(src, name).readText()
            assertFalse("$name uses android.app.AlertDialog", text.contains("import android.app.AlertDialog"))
            assertFalse("$name builds a non-Material dialog", Regex("""(?<!Material)AlertDialog\.Builder\(""").containsMatchIn(text))
        }
    }
}
