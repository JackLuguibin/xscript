package com.xscript.app.runtime

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class LogBufferTailTest {
    private lateinit var file: File

    @Before
    fun setUp() {
        file = File.createTempFile("log", ".jsonl")
    }

    @After
    fun tearDown() {
        file.delete()
    }

    private fun write(seqs: LongRange, lineText: (Long) -> String = { "line $it\n" }) {
        file.appendText(
            seqs.joinToString("") {
                JSONObject().put("seq", it).put("ts", it).put("stream", "stdout").put("line", lineText(it)).toString() + "\n"
            },
        )
    }

    private fun tail(since: Long, limit: Int = 2000) = RandomAccessFile(file, "r").use { LogBuffer.readTail(it, since, limit) }

    @Test
    fun emptyFileKeepsCursor() {
        val (entries, next) = tail(7)
        assertTrue(entries.isEmpty())
        assertEquals(7, next)
    }

    @Test
    fun returnsOnlyNewEntriesInOrder() {
        write(1L..10L)
        val (entries, next) = tail(6)
        assertEquals(listOf(7L, 8L, 9L, 10L), entries.map { it.seq })
        assertEquals("line 7\n", entries.first().line)
        assertEquals(10, next)
    }

    @Test
    fun upToDateCallerGetsNothing() {
        write(1L..3L)
        val (entries, next) = tail(3)
        assertTrue(entries.isEmpty())
        assertEquals(3, next)
    }

    @Test
    fun limitKeepsNewest() {
        write(1L..50L)
        val (entries, next) = tail(0, limit = 5)
        assertEquals(listOf(46L, 47L, 48L, 49L, 50L), entries.map { it.seq })
        assertEquals(50, next)
    }

    @Test
    fun spansChunkBoundaries() {
        // ~1 KB lines so 400 entries cross several 64 KB chunks.
        val pad = "x".repeat(1000)
        write(1L..400L) { "$pad $it\n" }
        val (entries, next) = tail(0)
        assertEquals((1L..400L).toList(), entries.map { it.seq })
        assertEquals("$pad 123\n", entries[122].line)
        assertEquals(400, next)
    }

    @Test
    fun sequenceResetRestartsFromLatest() {
        // App data cleared: file restarted at 1 while the client still holds 500.
        write(1L..3L)
        val (entries, next) = tail(500)
        assertEquals(listOf(1L, 2L, 3L), entries.map { it.seq })
        assertEquals(3, next)
    }

    @Test
    fun skipsPartialTrailingLine() {
        write(1L..2L)
        file.appendText("{\"seq\":3,\"ts\"") // writer mid-append
        val (entries, next) = tail(0)
        assertEquals(listOf(1L, 2L), entries.map { it.seq })
        assertEquals(2, next)
    }

    @Test
    fun keepsUtf8Intact() {
        val pad = "中".repeat(30_000) // multi-byte chars straddling a chunk boundary
        write(1L..3L) { "$pad$it\n" }
        val (entries, _) = tail(0)
        assertEquals("$pad" + "2\n", entries[1].line)
    }
}
