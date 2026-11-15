package com.xscript.app.pack

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Follow private OSS/COS download links, including a local HTTP server redirecting to HTTPS. */
internal object UpdateDownload {
    internal fun redirect(current: URL, location: String): URL {
        require(location.isNotBlank()) { "missing download redirect" }
        val next = URL(current, location)
        require(next.protocol == "https" || next.protocol == "http") { "unexpected download protocol" }
        require(current.protocol != "https" || next.protocol == "https") { "insecure download redirect" }
        require(next.userInfo == null) { "unexpected download credentials" }
        return next
    }

    fun get(address: String, limit: Long): ByteArray {
        var url = URL(address)
        require(url.protocol == "http" || url.protocol == "https") { "unexpected download protocol" }
        for (hop in 0..5) {
            val conn = url.openConnection() as HttpURLConnection
            try {
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 10_000
                conn.readTimeout = 60_000
                val status = conn.responseCode
                if (status in listOf(301, 302, 303, 307, 308)) {
                    require(hop < 5) { "too many download redirects" }
                    url = redirect(url, conn.getHeaderField("Location") ?: "")
                    continue
                }
                require(status == 200) { "HTTP $status" }
                require(conn.contentLengthLong <= limit) { "response too large" }
                val out = ByteArrayOutputStream()
                conn.inputStream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        require(out.size().toLong() + n <= limit) { "response too large" }
                        out.write(buf, 0, n)
                    }
                }
                return out.toByteArray()
            } finally {
                conn.disconnect()
            }
        }
        error("too many download redirects")
    }
}
