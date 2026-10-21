package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** A server that drops the first [drops] connections without answering, then answers `{"projects":["a"],"running":true}`. */
private class FlakyServer(private val drops: Int) : AutoCloseable {
    private val socket = ServerSocket(0, 10, InetAddress.getLoopbackAddress())
    val port get() = socket.localPort
    val accepted = AtomicInteger()

    init {
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val c = try { socket.accept() } catch (_: IOException) { break }
                c.use {
                    // read the request head (and any body that came with it) before deciding
                    val buf = ByteArray(65536)
                    it.getInputStream().read(buf)
                    if (accepted.incrementAndGet() <= drops) return@use
                    val body = """{"projects":["a"],"running":true}"""
                    it.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n" +
                        "Content-Length: ${body.length}\r\n\r\n$body").toByteArray(StandardCharsets.UTF_8))
                }
            }
        }
    }

    override fun close() = socket.close()
}

class DeviceClientRetryTest {
    @Test fun putIsRetriedOnceAfterADroppedConnection() {
        // the upload is a PUT, which the JDK client does not retry by itself (it only retries GET)
        FlakyServer(drops = 1).use { s ->
            val r = DeviceClient(DeviceTarget("127.0.0.1", s.port)).uploadFiles("a", listOf(UploadFile("__init__.py", "x\n", "utf-8")))
            assertTrue(r.get("running").asBoolean)
            assertEquals(2, s.accepted.get())
        }
    }

    @Test fun aServerThatAlwaysDropsStillFailsAfterAFewTries() {
        FlakyServer(drops = 100).use { s ->
            try {
                DeviceClient(DeviceTarget("127.0.0.1", s.port)).uploadFiles("a", emptyList())
                fail("expected an IOException")
            } catch (_: IOException) {
            }
            Thread.sleep(200)
            assertEquals(2, s.accepted.get())
            try {
                DeviceClient(DeviceTarget("127.0.0.1", s.port)).listProjects()
                fail("expected an IOException")
            } catch (_: IOException) {
            }
            Thread.sleep(200)
            assertTrue("GET: at most the JDK's own retry plus ours, twice", s.accepted.get() - 2 <= 4)
        }
    }

    @Test fun postIsNeverRepeated() {
        FlakyServer(drops = 1).use { s ->
            try {
                DeviceClient(DeviceTarget("127.0.0.1", s.port)).run("a")
                fail("expected an IOException")
            } catch (_: IOException) {
            }
            Thread.sleep(200)
            assertEquals(1, s.accepted.get())
            assertTrue("POST" !in RETRYABLE)
        }
    }
}
