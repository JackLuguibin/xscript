package com.xscript.app.runtime

import org.junit.Assert.assertArrayEquals
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class PipesReadFrameTest {
    private fun frame(w: Int, h: Int): ByteArray {
        val b = ByteBuffer.allocate(8 + w * h * 4).order(ByteOrder.LITTLE_ENDIAN)
        b.putInt(w).putInt(h)
        for (i in 0 until w * h * 4) b.put((i * 7).toByte())
        return b.array()
    }

    /** Hands out at most [chunk] bytes per read, like a pipe. */
    private class Trickle(data: ByteArray, private val chunk: Int) : InputStream() {
        private val inner = ByteArrayInputStream(data)
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, minOf(len, chunk))
    }

    @Test
    fun readsExactFrameAcrossShortReads() {
        val f = frame(33, 17)
        assertArrayEquals(f, Pipes.readFrame(Trickle(f, 1000)))
    }

    @Test
    fun emptyAndShortStreams() {
        assertArrayEquals(ByteArray(0), Pipes.readFrame(ByteArrayInputStream(ByteArray(0))))
        assertArrayEquals(byteArrayOf(1, 2, 3), Pipes.readFrame(ByteArrayInputStream(byteArrayOf(1, 2, 3))))
    }

    @Test
    fun truncatedFrameKeepsWhatArrived() {
        val f = frame(4, 4)
        val cut = f.copyOf(30)
        assertArrayEquals(cut, Pipes.readFrame(ByteArrayInputStream(cut)))
    }

    @Test
    fun nonFrameHeaderFallsBackToReadAll() {
        val data = ByteArray(20) { (-1).toByte() } // w = h = -1
        assertArrayEquals(data, Pipes.readFrame(ByteArrayInputStream(data)))
    }
}
