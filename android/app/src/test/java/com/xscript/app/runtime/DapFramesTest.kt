package com.xscript.app.runtime

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.FilterInputStream

class DapFramesTest {
    @Test fun unicodeAndFragmentedFrames() {
        val out = ByteArrayOutputStream()
        val first = JSONObject().put("type", "event").put("text", "中文🙂")
        DapFrames.write(out, first)
        DapFrames.write(out, JSONObject().put("seq", 2))
        val input = object : FilterInputStream(ByteArrayInputStream(out.toByteArray())) {
            override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, minOf(1, len))
        }
        assertEquals("中文🙂", DapFrames.read(input).getString("text"))
        assertEquals(2, DapFrames.read(input).getInt("seq"))
    }

    @Test fun rejectsUnboundedOrAmbiguousHeaders() {
        for (header in listOf("Content-Length: -1", "Content-Length: 4194305", "Other: 5",
            "Content-Length: 2\r\nContent-Length: 2")) {
            try {
                DapFrames.read(ByteArrayInputStream("$header\r\n\r\n{}".toByteArray()))
                fail("accepted $header")
            } catch (_: IllegalArgumentException) { }
        }
    }

    @Test(expected = EOFException::class) fun rejectsTruncatedPayload() {
        DapFrames.read(ByteArrayInputStream("Content-Length: 10\r\n\r\n{}".toByteArray()))
    }
}
