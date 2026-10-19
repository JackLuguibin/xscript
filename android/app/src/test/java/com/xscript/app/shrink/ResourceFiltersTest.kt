package com.xscript.app.shrink

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The release APK keeps only English and Chinese library strings (androidResources.localeFilters). */
class ResourceFiltersTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }

    private fun localeFilters(): List<String> {
        val gradle = File(module, "build.gradle.kts").readText()
        val call = Regex("""localeFilters\s*\+=\s*listOf\(([^)]*)\)""").find(gradle) ?: return emptyList()
        return Regex("\"([^\"]+)\"").findAll(call.groupValues[1]).map { it.groupValues[1] }.toList()
    }

    @Test
    fun chineseRegionsAreKept() {
        val filters = localeFilters()
        assertTrue("localeFilters = $filters", filters.containsAll(listOf("en", "zh-rCN", "zh-rTW", "zh-rHK")))
        // "zh" alone keeps no library's Chinese strings: they are all region-qualified.
        assertFalse(filters.contains("zh"))
    }

    @Test
    fun appTranslationsSurviveTheFilter() {
        val filters = localeFilters().toSet()
        val locale = Regex("""^values-([a-z]{2,3}(?:-r[A-Z]{2})?)(?:-.*)?$""")
        val translated = File(module, "src/main/res").listFiles().orEmpty()
            .mapNotNull { locale.find(it.name)?.groupValues?.get(1) }
        translated.forEach { assertTrue("res/values-$it would be dropped by localeFilters $filters", it in filters) }
    }
}
