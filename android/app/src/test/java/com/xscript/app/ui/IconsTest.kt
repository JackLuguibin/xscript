package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** One icon set: Material Symbols Rounded vectors (res/drawable/ic_sym_*), only the ones the app uses. */
class IconsTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
    private val drawables = File(module, "src/main/res/drawable")
    private val sources = File(module, "src/main/java").walk().filter { it.extension == "kt" }.associate { it.name to it.readText() }

    private fun symbols(): Set<String> =
        drawables.listFiles().orEmpty().map { it.nameWithoutExtension }.filter { it.startsWith("ic_sym_") }.toSet()

    @Test
    fun everyBundledSymbolIsUsedAndEveryUsedOneExists() {
        val used = sources.values.flatMap { Regex("""R\.drawable\.(ic_sym_\w+)""").findAll(it).map { m -> m.groupValues[1] } }.toSet()
        assertEquals("bundled but unused (APK cost) or used but missing", used, symbols())
    }

    @Test
    fun symbolsAreRoundedVectorsTintedAtRuntime() {
        for (name in symbols()) {
            val xml = File(drawables, "$name.xml").readText()
            assertTrue("$name: Material Symbols Rounded", xml.contains("Material Symbols Rounded"))
            assertTrue("$name: 960 viewport", xml.contains("android:viewportWidth=\"960\""))
            assertFalse("$name: tinted by the code, not by a theme attribute", xml.contains("android:tint="))
        }
    }

    @Test
    fun noOtherIconStyles() {
        assertFalse(drawables.listFiles().orEmpty().any { it.name.startsWith("ic_float_") || it.name.startsWith("ic_ui_") })
        // Rows take a drawable: a text or emoji glyph ("☁", ">_", "A") as an icon does not compile any more, and
        // this keeps a string from coming back through another helper.
        for ((name, text) in sources) {
            assertFalse("$name passes a glyph to a row", Regex("""UiKit\.(row|switchRow)\([^,()]+, "[^"]*"""").containsMatchIn(text))
        }
    }
}
