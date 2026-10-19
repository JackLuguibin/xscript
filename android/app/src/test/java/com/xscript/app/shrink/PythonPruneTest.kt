package com.xscript.app.shrink

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** python-prune.txt drops files from the pip packages; it must never reach code that runs on a device. */
class PythonPruneTest {
    private val module = generateSequence(File("").absoluteFile) { it.parentFile }
        .first { File(it, "python-prune.txt").isFile && File(it, "build.gradle.kts").isFile }
    private val patterns = File(module, "python-prune.txt").readLines().map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") }.map { Regex(it) }

    private fun pruned(path: String) = patterns.any { it.containsMatchIn(path) }

    @Test
    fun dropsTestsSourcesAndForeignBinaries() {
        listOf(
            "numpy/core/tests/test_api.pyc",
            "numpy/tests/test_public_api.pyc",
            "numpy/random/tests/data/mt19937-testset-1.csv",
            "debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_cython.c",
            "debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_cython.pyx",
            "debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_cython.cpython-310-darwin.so",
            "debugpy/_vendored/pydevd/pydevd_attach_to_process/winappdbg/process.pyc",
            "debugpy/_vendored/pydevd/pydevd_attach_to_process/windows/attach.cpp",
            "debugpy/_vendored/pydevd/pydevd_attach_to_process/linux_and_mac/attach.cpp",
            "debugpy/_vendored/pydevd/_pydevd_frame_eval/vendored/bytecode/tests/test_cfg.pyc",
        ).forEach { assertTrue("$it should be pruned", pruned(it)) }
    }

    @Test
    fun keepsWhatScriptsAndTheDebuggerUse() {
        listOf(
            "numpy/__init__.pyc",
            "numpy/core/_multiarray_umath.so",
            "numpy/testing/__init__.pyc",
            "numpy/testing/_private/utils.pyc",
            "numpy/random/_generator.so",
            "cv2/cv2.so",
            "cv2/__init__.pyc",
            "cv2/data/haarcascade_frontalface_default.xml",
            "PIL/_imaging.so",
            "yaml/_yaml.so",
            "requests/__init__.pyc",
            "certifi/cacert.pem",
            "chaquopy/lib/libopenblas.so",
            "chaquopy/lib/libc++_shared.so",
            "debugpy/__init__.pyc",
            "debugpy/server/api.pyc",
            "debugpy/_vendored/pydevd/pydevd.pyc",
            "debugpy/_vendored/pydevd/_pydevd_bundle/pydevd_comm.pyc",
            "debugpy/_vendored/pydevd/_pydevd_frame_eval/vendored/bytecode/__init__.pyc",
        ).forEach { assertFalse("$it must stay in the APK", pruned(it)) }
    }

    @Test
    fun gradleAppliesTheListAndSkipsRuntimeTests() {
        val gradle = File(module, "build.gradle.kts").readText()
        assertTrue(gradle.contains("file(\"python-prune.txt\")"))
        assertTrue(gradle.contains("inputs.file(\"python-prune.txt\")"))
        assertTrue(Regex("""srcDir\("\.\./python-runtime"\)\s*(//[^\n]*\n\s*)*exclude\("tests/\*\*"\)""").containsMatchIn(gradle))
    }
}
