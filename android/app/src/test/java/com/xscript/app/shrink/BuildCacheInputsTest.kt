package com.xscript.app.shrink

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The build cache is on; tests that read files outside their classpath must declare them, or a stale result replays. */
class BuildCacheInputsTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }

    @Test
    fun buildCacheIsOn() {
        val props = File(module, "../gradle.properties").readLines().map { it.trim() }
        assertTrue(props.contains("org.gradle.caching=true"))
    }

    @Test
    fun filesReadByTestsAreTaskInputs() {
        val gradle = File(module, "build.gradle.kts").readText()
        val block = gradle.substringAfter("tasks.withType<Test>().configureEach {").substringBefore("\n}")
        listOf(
            "inputs.file(\"proguard-rules.pro\")",
            "inputs.file(\"build.gradle.kts\")",
            "inputs.file(\"python-prune.txt\")",
            "inputs.dir(\"../python-runtime\")",
            "inputs.dir(\"src/main/res\")",
            "inputs.dir(\"src/main/java\")",
        ).forEach { assertTrue("$it missing from the Test task inputs", block.contains(it)) }
    }
}
