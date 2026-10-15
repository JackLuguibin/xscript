package com.xscript.app.runtime

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.TimeUnit

/** /debug/connect, /debug/request, /debug/messages and DELETE /debug against a fake debugpy. */
class DapTransportTest {
    private lateinit var server: ServerSocket
    private var peer: Socket? = null

    @Before
    fun setUp() {
        DapTransport.disconnect()
        server = ServerSocket(0)
        DapTransport.port = server.localPort
    }

    @After
    fun tearDown() {
        DapTransport.disconnect()
        peer?.close()
        server.close()
        DapTransport.port = 5678
    }

    private fun connect(): Socket {
        val accept = java.util.concurrent.Executors.newSingleThreadExecutor().submit<Socket> { server.accept() }
        assertTrue(DapTransport.connect().getBoolean("ok"))
        return accept.get(5, TimeUnit.SECONDS).also { peer = it }
    }

    private fun waitFor(timeoutMs: Long = 5000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!cond()) {
            check(System.currentTimeMillis() < end) { "condition not met" }
            Thread.sleep(10)
        }
    }

    @Test
    fun notReadyWhenNothingListens() {
        val port = server.localPort
        server.close()
        DapTransport.port = port
        val e = assertThrows(IllegalStateException::class.java) { DapTransport.connect() }
        assertTrue(e.message!!.startsWith("debugger not ready"))
        assertFalse(DapTransport.status().getBoolean("connected"))
        server = ServerSocket(0)
    }

    @Test
    fun requestsAreValidatedAndFramed() {
        val debuggee = connect()
        assertThrows(IllegalStateException::class.java) { DapTransport.connect() } // 409: already connected
        assertThrows(IllegalArgumentException::class.java) { DapTransport.send(JSONObject().put("type", "event")) }
        assertThrows(IllegalArgumentException::class.java) { DapTransport.send(JSONObject().put("type", "request").put("command", "x")) }
        assertThrows(IllegalArgumentException::class.java) { DapTransport.send(JSONObject().put("type", "request").put("seq", 1)) }
        DapTransport.send(JSONObject().put("type", "request").put("seq", 1).put("command", "initialize").put("t", "中文"))
        val got = DapFrames.read(debuggee.getInputStream())
        assertEquals("initialize", got.getString("command"))
        assertEquals("中文", got.getString("t"))
    }

    @Test
    fun messagesCursorAndRingBuffer() {
        val debuggee = connect()
        val out = debuggee.getOutputStream()
        for (i in 1..3) DapFrames.write(out, JSONObject().put("type", "event").put("n", i))
        waitFor { DapTransport.messages(0).getLong("next") == 3L }
        val all = DapTransport.messages(0)
        assertEquals(3, all.getJSONArray("messages").length())
        assertEquals(0L, all.getLong("dropped_before"))
        assertTrue(all.getBoolean("connected"))
        val tail = DapTransport.messages(2).getJSONArray("messages")
        assertEquals(1, tail.length())
        assertEquals(3, tail.getJSONObject(0).getJSONObject("message").getInt("n"))
        assertEquals(0, DapTransport.messages(3).getJSONArray("messages").length())
        assertThrows(IllegalArgumentException::class.java) { DapTransport.messages(-1) }
        // Past 512 messages the oldest are dropped and reported.
        for (i in 4..600) DapFrames.write(out, JSONObject().put("type", "event").put("n", i))
        waitFor { DapTransport.messages(0).getLong("next") == 600L }
        val ring = DapTransport.messages(0)
        assertEquals(512, ring.getJSONArray("messages").length())
        assertEquals(88L, ring.getLong("dropped_before"))
        assertEquals(89, ring.getJSONArray("messages").getJSONObject(0).getJSONObject("message").getInt("n"))
    }

    @Test
    fun debuggeeExitAndManualDisconnect() {
        val debuggee = connect()
        debuggee.close()
        waitFor { !DapTransport.status().getBoolean("connected") }
        assertEquals("clean EOF is not an error", "", DapTransport.status().getString("error"))
        assertThrows(IllegalStateException::class.java) {
            DapTransport.send(JSONObject().put("type", "request").put("seq", 1).put("command", "threads"))
        }
        // Reconnect starts a fresh cursor; a manual disconnect drops the socket.
        val again = connect()
        assertEquals(0L, DapTransport.messages(0).getLong("next"))
        DapTransport.disconnect()
        assertFalse(DapTransport.status().getBoolean("connected"))
        waitFor { again.getInputStream().read() == -1 }
    }
}
