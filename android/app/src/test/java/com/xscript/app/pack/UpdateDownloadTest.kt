package com.xscript.app.pack

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URL
import org.junit.Assert.*
import org.junit.Test

class UpdateDownloadTest {
    private fun rejects(block: () -> Unit) {
        try { block(); fail("must reject") } catch (_: IllegalArgumentException) { }
    }

    @Test fun privateStorageRedirectsAllowHttpsUpgradeAndRejectDowngradeOrOtherProtocols() {
        assertEquals("https://bucket.example.com/object.zip?signature=abc", UpdateDownload.redirect(
            URL("http://backend.example.com/pub/bundle/channel/1.zip"),
            "https://bucket.example.com/object.zip?signature=abc",
        ).toString())
        assertEquals("https://a.example.com/next", UpdateDownload.redirect(URL("https://a.example.com/pub/x"), "/next").toString())
        rejects { UpdateDownload.redirect(URL("https://a.example.com/x"), "http://b.example.com/x") }
        rejects { UpdateDownload.redirect(URL("http://a.example.com/x"), "file:///tmp/x") }
        rejects { UpdateDownload.redirect(URL("http://a.example.com/x"), "https://user:password@a.example.com/x") }
        rejects { UpdateDownload.redirect(URL("http://a.example.com/x"), "") }
    }

    @Test fun followsRedirectsAndStillBoundsTheDownloadedBytes() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/bundle") { ex ->
            ex.responseHeaders.add("Location", "/object?signature=abc")
            ex.sendResponseHeaders(302, -1); ex.close()
        }
        server.createContext("/object") { ex ->
            val body = "bundle-content".toByteArray()
            ex.sendResponseHeaders(200, body.size.toLong())
            ex.responseBody.use { it.write(body) }
        }
        server.createContext("/loop") { ex ->
            ex.responseHeaders.add("Location", "/loop")
            ex.sendResponseHeaders(302, -1); ex.close()
        }
        server.start()
        try {
            val base = "http://127.0.0.1:${server.address.port}"
            assertArrayEquals("bundle-content".toByteArray(), UpdateDownload.get("$base/bundle", 100))
            rejects { UpdateDownload.get("$base/bundle", 3) }
            rejects { UpdateDownload.get("$base/loop", 100) }
        } finally { server.stop(0) }
    }
}
