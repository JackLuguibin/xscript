package com.xscript.app.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The style guide (UiKit KDoc, docs/android-ui-style.md): screens take colors, sizes and icons from the tokens only.
 * UiKit.kt and the colors.xml files are the token files; ScriptUi applies the colors and sizes a script asks for.
 */
class StyleTokensTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
    private val src = File(module, "src/main/java/com/xscript/app")

    /** Every file that builds views, except the token file itself. */
    private val screens: List<File> by lazy {
        src.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .filter { f -> f.readText().let { it.contains("import android.widget.") || it.contains("UiKit.") } }
            .filter { it.name != "UiKit.kt" }
            .toList()
    }

    /** Script-driven views: colors and sizes come from the script (ui.overlay, canvas, float menus). */
    private val scriptDriven = setOf("ScriptUi.kt")

    /** Source without comments, so KDoc can mention hex values or arrows. */
    private fun code(f: File): String = f.readText()
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .lines().joinToString("\n") { it.replace(Regex("""(^|\s)//.*$"""), "") }

    private fun violations(rule: Regex, skip: Set<String> = emptySet()): List<String> =
        screens.filter { it.name !in skip }.flatMap { f ->
            code(f).lines().mapIndexedNotNull { i, line -> if (rule.containsMatchIn(line)) "${f.name}:${i + 1}: ${line.trim()}" else null }
        }

    private fun assertNone(what: String, found: List<String>) =
        assertTrue("$what outside the token files:\n" + found.joinToString("\n"), found.isEmpty())

    @Test
    fun scanCoversTheScreens() {
        val names = screens.map { it.name }.toSet()
        for (n in listOf("MainActivity.kt", "PackActivity.kt", "ProjectsActivity.kt", "ProjectActivity.kt", "FloatControl.kt", "SchemeActivity.kt")) {
            assertTrue("$n not scanned: $names", n in names)
        }
    }

    @Test
    fun noHardcodedColors() {
        assertNone("Hardcoded color", violations(Regex("""0x[0-9A-Fa-f]{8}|Color\.(parseColor|rgb|argb)\(|"#[0-9A-Fa-f]{6,8}""""), scriptDriven))
    }

    @Test
    fun noRawDimensions() {
        // A number in a dp / card / radius call or a text size: use UiKit.Space, Radius, Size or Type.
        val raw = Regex("""\b(dp|card|spacer|rounded|panelBackground|ripple)\([^()]*\b[1-9][0-9]*(\.[0-9]+)?f\b|textSize\s*=\s*[0-9]""")
        assertNone("Raw dimension", violations(raw, scriptDriven))
    }

    @Test
    fun noGlyphIcons() {
        // Emoji, dingbats and geometric shapes in a string literal, or a literal that is only an arrow / symbol:
        // icons are ic_sym_* vectors.
        val glyph = Regex("""[\x{2600}-\x{27BF}\x{25A0}-\x{25FF}\x{2B00}-\x{2BFF}\x{1F000}-\x{1FAFF}]|"[\x{2190}-\x{21FF}\x{2039}\x{203A}\x{00BB}\x{00AB}]"""")
        assertNone("Glyph icon", violations(glyph))
    }

    @Test
    fun oneToastStyle() {
        assertNone("Direct Toast", violations(Regex("""Toast\.makeText\("""), scriptDriven))
    }
}
