package com.xscript.app.capture

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer

class FrameRowsTest {
    @Test
    fun packDropsRowPadding() {
        val rowBytes = 12
        val stride = 16
        val h = 3
        val src = ByteBuffer.allocate(stride * h)
        for (i in 0 until stride * h) src.put(i, (if (i % stride < rowBytes) i else 0x7f).toByte())
        val dst = ByteBuffer.allocateDirect(rowBytes * h)
        FrameRows.pack(src, stride, rowBytes, h, dst)
        assertEquals(0, dst.position())
        assertEquals(rowBytes * h, dst.limit())
        val out = ByteArray(rowBytes * h)
        dst.get(out)
        val want = ByteArray(rowBytes * h) { (it / rowBytes * stride + it % rowBytes).toByte() }
        assertArrayEquals(want, out)
        assertEquals(0, src.position())
    }

    @Test
    fun packReusesDestination() {
        val src = ByteBuffer.wrap(ByteArray(8) { it.toByte() })
        val dst = ByteBuffer.allocate(4)
        FrameRows.pack(src, 4, 2, 2, dst)
        FrameRows.pack(src, 4, 2, 2, dst)
        val out = ByteArray(4)
        dst.get(out)
        assertArrayEquals(byteArrayOf(0, 1, 4, 5), out)
    }

    @Test(expected = IllegalArgumentException::class)
    fun packRejectsSmallDestination() {
        FrameRows.pack(ByteBuffer.allocate(16), 8, 8, 2, ByteBuffer.allocate(8))
    }
}
