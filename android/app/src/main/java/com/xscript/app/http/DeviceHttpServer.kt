package com.xscript.app.http

import android.content.Context
import com.xscript.app.net.NetworkInfo
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** LAN HTTP server on :9096. All logic lives in [ApiRouter]. */
class DeviceHttpServer(
    context: Context,
    port: Int = NetworkInfo.PORT,
) : NanoHTTPD("0.0.0.0", port) {

    private val router = ApiRouter(context)

    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.OPTIONS) {
            return cors(newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, ""))
        }
        val body = readBody(session)
        val query = session.parms ?: emptyMap()
        val headers = session.headers ?: emptyMap()
        val req = ApiRouter.Request(
            method = session.method.name,
            path = session.uri,
            query = query,
            body = body,
            client = headers["x-xscript-client"].orEmpty(),
            remote = headers["remote-addr"].orEmpty(),
        )
        val reply = router.handle(req)
        val status = Response.Status.lookup(reply.status) ?: Response.Status.INTERNAL_ERROR
        return cors(
            newFixedLengthResponse(status, reply.mime, ByteArrayInputStream(reply.body), reply.body.size.toLong()),
        )
    }

    /** Raw body bytes. NanoHTTPD's parseBody would mangle binary uploads like zip files. */
    private fun readBody(session: IHTTPSession): ByteArray {
        val len = session.headers?.get("content-length")?.toLongOrNull() ?: 0L
        if (len <= 0L) return ByteArray(0)
        require(len <= MAX_BODY) { "body too large" }
        val out = ByteArrayOutputStream(len.toInt())
        val buf = ByteArray(64 * 1024)
        var remaining = len
        val input = session.inputStream
        while (remaining > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
            if (n <= 0) break
            out.write(buf, 0, n)
            remaining -= n
        }
        return out.toByteArray()
    }

    private fun cors(response: Response): Response {
        response.addHeader("Access-Control-Allow-Origin", "*")
        response.addHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        response.addHeader("Access-Control-Allow-Headers", "Content-Type,X-XScript-Client")
        return response
    }

    companion object {
        private const val MAX_BODY = 200L * 1024 * 1024
    }
}
