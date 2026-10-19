package com.xscript.app.shrink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The release build runs R8. Python (Chaquopy) reaches app classes by name, so a class the bundled runtime
 * imports must survive shrinking with its members; these checks keep proguard-rules.pro in step with the
 * Python sources and the build script.
 */
class R8KeepRulesTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "proguard-rules.pro").isFile && File(it, "build.gradle.kts").isFile }
    private val rules = File(module, "proguard-rules.pro").readLines()
        .map { it.substringBefore('#').trim() }.filter { it.isNotEmpty() }
    private val runtime = File(module, "../python-runtime").canonicalFile
    private val sources = File(module, "src/main/java")

    /** `from com.xscript.app.x import A, B as C` and `jclass("com.xscript.app.x.A")` in the bundled runtime. */
    private fun pythonReferences(): Set<String> {
        val fromImport = Regex("""^\s*from\s+(com\.xscript\.app[\w.]*)\s+import\s+(.+)$""")
        val jclass = Regex("""jclass\(\s*["'](com\.xscript\.app\.[\w.$]+)["']""")
        val refs = sortedSetOf<String>()
        runtime.walkTopDown().filter { it.isFile && it.extension == "py" && "tests" !in it.relativeTo(runtime).path.split(File.separatorChar) }
            .forEach { f ->
                f.readLines().forEach { line ->
                    fromImport.find(line)?.let { m ->
                        m.groupValues[2].trim().trim('(', ')').split(',').map { it.trim().split(Regex("\\s+")).first() }
                            .filter { it.isNotEmpty() }.forEach { refs += "${m.groupValues[1]}.$it" }
                    }
                    jclass.findAll(line).forEach { refs += it.groupValues[1] }
                }
            }
        return refs
    }

    /** Class patterns of `-keep class <pattern> { *; }` rules, the form that keeps every member. */
    private fun fullKeepPatterns(): List<String> {
        val rule = Regex("""^-keep\s+class\s+(\S+)\s*\{\s*\*;\s*\}$""")
        return rules.mapNotNull { rule.find(it)?.groupValues?.get(1) }
    }

    @Test
    fun globMatchesProguardSemantics() {
        assertTrue(matches("com.xscript.app.**", "com.xscript.app.runtime.Bridge"))
        assertTrue(matches("com.xscript.app.*", "com.xscript.app.XscriptApp"))
        assertFalse(matches("com.xscript.app.*", "com.xscript.app.runtime.Bridge"))
        assertFalse(matches("com.xscript.app.**", "com.xscript.other.Bridge"))
    }

    @Test
    fun pythonImportedClassesExistAndAreKept() {
        val refs = pythonReferences()
        assertTrue("python-runtime should import the bridge classes: $refs", "com.xscript.app.runtime.Bridge" in refs)
        assertTrue(refs.containsAll(listOf("com.xscript.app.XscriptApp", "com.xscript.app.plugin.Plugins")))
        val patterns = fullKeepPatterns()
        refs.forEach { fqcn ->
            val pkg = File(sources, fqcn.substringBeforeLast('.').replace('.', '/'))
            val simple = fqcn.substringAfterLast('.')
            val declared = Regex("""\b(class|object|interface)\s+$simple\b""")
            assertTrue("$fqcn is imported from Python but not declared under $pkg",
                pkg.listFiles().orEmpty().any { it.isFile && declared.containsMatchIn(it.readText()) })
            assertTrue("$fqcn is imported from Python but no `-keep class … { *; }` rule covers it",
                patterns.any { matches(it, fqcn) })
        }
    }

    @Test
    fun namesStayReadableForScripts() {
        // Scripts may jclass() any class, and stack traces surface in the IDE log; renaming would break both.
        assertTrue("-dontobfuscate" in rules)
    }

    @Test
    fun webViewBridgesAreKept() {
        val usesJsInterface = sources.walkTopDown().any { it.isFile && it.extension == "kt" && "@JavascriptInterface" in it.readText() }
        assertTrue(usesJsInterface)
        assertTrue(rules.joinToString(" ").contains("@android.webkit.JavascriptInterface <methods>;"))
    }

    @Test
    fun mlKitRegistrarsKeepTheirConstructors() {
        assertTrue(rules.any { it.startsWith("-keep class * implements com.google.firebase.components.ComponentRegistrar") && "<init>()" in it })
    }

    @Test
    fun releaseBuildShrinks() {
        val gradle = File(module, "build.gradle.kts").readText()
        val release = gradle.substringAfter("release {").substringBefore("}")
        assertEquals(listOf("isMinifyEnabled = true", "isShrinkResources = true"),
            Regex("""is(?:MinifyEnabled|ShrinkResources)\s*=\s*\w+""").findAll(release).map { it.value.replace(Regex("\\s+"), " ") }.toList())
        assertTrue(release.contains("proguard-rules.pro"))
    }

    private fun matches(pattern: String, fqcn: String): Boolean {
        val regex = buildString {
            var i = 0
            while (i < pattern.length) {
                val c = pattern[i]
                when {
                    pattern.startsWith("**", i) -> { append(".*"); i++ }
                    c == '*' -> append("[^.]*")
                    c == '?' -> append("[^.]")
                    else -> append(Regex.escape(c.toString()))
                }
                i++
            }
        }
        return Regex(regex).matches(fqcn)
    }
}
