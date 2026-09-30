package com.xscript.app.http

import android.content.Context
import com.xscript.app.net.NetworkInfo
import com.xscript.app.tools.ScreenStream
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream

/**
 * LAN HTTP server on :9860. All logic lives in [ApiRouter]; this class handles transport
 * concerns: body spooling and streaming file replies. There is no authentication.
 *
 * No CORS headers are sent. Only native clients (MCP, curl, scripts) are expected, and
 * leaving CORS off stops web pages in a developer's browser from reading responses.
 */
class DeviceHttpServer(
    context: Context,
    port: Int = NetworkInfo.PORT,
) : NanoHTTPD("0.0.0.0", port) {

    private val router = ApiRouter(context)
    private val spoolDir = File(context.cacheDir, "http-spool").apply { mkdirs() }

    override fun serve(session: IHTTPSession): Response {
        val headers = session.headers ?: emptyMap()
        val method = session.method?.name ?: "GET"
        val path = session.uri ?: "/"
        if (method == "GET" && path.trimEnd('/') == "/screen/stream") return stream(session)
        val len = headers["content-length"]?.toLongOrNull() ?: 0L
        if (len > MAX_BODY) return error(Response.Status.PAYLOAD_TOO_LARGE, "body too large")
        val body = try {
            readBody(session.inputStream, len)
        } catch (e: Exception) {
            return error(Response.Status.BAD_REQUEST, "body read failed: ${e.message}")
        }
        try {
            val req = ApiRouter.Request(
                method = method,
                path = path,
                query = session.parms ?: emptyMap(),
                body = body,
                client = headers["x-xscript-client"].orEmpty(),
                remote = headers["remote-addr"].orEmpty(),
            )
            val reply = router.handle(req)
            val status = Response.Status.lookup(reply.status) ?: Response.Status.INTERNAL_ERROR
            val file = reply.file
            if (file != null) {
                val stream = FileInputStream(file)
                val size = file.length()
                // Unix keeps the inode alive while the stream is open, so a temp file can go now.
                if (reply.deleteFile) file.delete()
                return newFixedLengthResponse(status, reply.mime, stream, size)
            }
            return newFixedLengthResponse(status, reply.mime, reply.body.inputStream(), reply.body.size.toLong())
        } finally {
            body.release()
        }
    }

    /** Small bodies stay in memory; larger ones are spooled to a temp file and streamed. */
    private fun readBody(input: InputStream, len: Long): ApiRouter.Body {
        if (len <= 0L) return ApiRouter.Body.EMPTY
        if (len <= MEMORY_LIMIT) {
            val buf = ByteArray(len.toInt())
            var off = 0
            while (off < buf.size) {
                val n = input.read(buf, off, buf.size - off)
                if (n <= 0) break
                off += n
            }
            return ApiRouter.Body.of(if (off == buf.size) buf else buf.copyOf(off))
        }
        val file = File.createTempFile("body", ".bin", spoolDir)
        try {
            FileOutputStream(file).use { out ->
                val buf = ByteArray(64 * 1024)
                var remaining = len
                while (remaining > 0) {
                    val n = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    remaining -= n
                }
            }
        } catch (e: Exception) {
            file.delete()
            throw e
        }
        return ApiRouter.Body.ofFile(file)
    }

    /** 投屏 MJPEG stream; see [ScreenStream]. Chunked so it can run until the client leaves. */
    private fun stream(session: IHTTPSession): Response {
        val opts = ScreenStream.Options.from(session.parms ?: emptyMap())
        val input = ScreenStream.open(opts)
            ?: return error(Response.Status.TOO_MANY_REQUESTS, "too many screen streams (max 2)")
        return newChunkedResponse(Response.Status.OK, ScreenStream.MIME, input).apply {
            addHeader("Cache-Control", "no-cache, no-store")
            addHeader("Pragma", "no-cache")
        }
    }

    private fun error(status: Response.Status, message: String): Response =
        newFixedLengthResponse(status, "application/json; charset=utf-8", JSONObject().put("error", message).toString())

    companion object {
        private const val MAX_BODY = 200L * 1024 * 1024
        private const val MEMORY_LIMIT = 4L * 1024 * 1024
    }
}
