package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The run log screen appends new lines instead of re-setting its whole text, and caps it at a line start. */
class LogTrimTest {
    @Test
    fun belowTheCapNothingIsDropped() {
        assertEquals(0, LogText.trimLength("a\nb\n", max = 10, keep = 5))
        assertEquals(0, LogText.trimLength("x".repeat(10), max = 10, keep = 5))
    }

    @Test
    fun overTheCapDropsUpToALineStart() {
        // 4 lines of "1234\n": keep 7 -> cut at 13 (inside line 3), so line 3 goes too and only line 4 remains
        val text = "1234\n".repeat(4)
        val drop = LogText.trimLength(text, max = 15, keep = 7)
        assertEquals(15, drop)
        assertEquals("1234\n", text.substring(drop))
        // cut right at a line start keeps that line whole
        assertEquals(10, LogText.trimLength(text, max = 15, keep = 10))
    }

    @Test
    fun aLongLineWithoutNewlineFallsBackToTheCut() {
        assertEquals(15, LogText.trimLength("y".repeat(20), max = 15, keep = 5))
    }

    @Test
    fun newLinesAreAppendedNotReplacingTheWholeText() {
        val root = generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
        val src = File(root, "src/main/java/com/xscript/app/ui/LogActivity.kt").readText()
        assertTrue(src.contains("setText(\"\", TextView.BufferType.EDITABLE)"))
        assertTrue(src.contains("buffer.append(chunk)"))
        assertFalse("re-setting the whole text re-lays out and redraws all of it on every poll", src.contains("text.text = buffer"))
    }

    @Test
    fun pollingReadsTheLogFileOffTheMainThread() {
        val root = generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
        val src = File(root, "src/main/java/com/xscript/app/ui/LogActivity.kt").readText()
        val poll = src.substringAfter("private fun poll()").substringBefore("override fun onDestroy")
        assertTrue("the read runs on the reader thread", poll.contains("reader.execute {") && poll.contains("LogBuffer.since(app, since)"))
        assertTrue("a read from before 清空 is dropped", poll.contains("gen != generation"))
        assertTrue(src.contains("reader.shutdownNow()"))
    }
}
