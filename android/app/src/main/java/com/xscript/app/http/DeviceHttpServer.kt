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
 * concerns: request checks ([HttpGuard] + [Pairing]), body spooling and streaming file replies.
 *
 * No CORS headers are sent. Native clients (desktop, VS Code, MCP, curl) present the pairing
 * code as a bearer token; the device's own web tools carry it in a SameSite=Strict cookie set by
 * `/pair`. Cross-origin browser requests and foreign Host headers (DNS rebinding) are refused.
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
        val remote = headers["remote-addr"].orEmpty()
        val required = Pairing.required
        val code = if (required) Pairing.code else ""
        val verdict = HttpGuard.verdict(HttpGuard.Check(method, path, headers, code, required))
        // A locked-out address gets nothing but public routes, so it cannot keep guessing (a right guess included).
        if (required && verdict != HttpGuard.Verdict.BAD_HOST && verdict != HttpGuard.Verdict.BAD_ORIGIN &&
            !HttpGuard.isPublic(method, path) && Pairing.Throttle.blocked(remote, System.currentTimeMillis())
        ) return error(Response.Status.TOO_MANY_REQUESTS, "too many wrong pairing codes, retry in a minute")
        when (verdict) {
            HttpGuard.Verdict.BAD_HOST -> return error(Response.Status.FORBIDDEN, "host not allowed")
            HttpGuard.Verdict.BAD_ORIGIN -> return error(Response.Status.FORBIDDEN, "cross-origin request refused")
            HttpGuard.Verdict.UNAUTHORIZED -> return unauthorized(method, path, session.queryParameterString, headers, remote)
            HttpGuard.Verdict.OK -> Unit
        }
        val authed = !required || HttpGuard.matches(HttpGuard.presented(headers), code)
        if (path.trimEnd('/') == "/pair") return pair(session, method, headers, remote, required, code)
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
                remote = remote,
                contentType = headers["content-type"].orEmpty(),
                authed = authed,
                ifNoneMatch = headers["if-none-match"],
            )
            val reply = router.handle(req)
            // Unchanged page asset: no body (and a non-text type, so the server does not gzip an empty 304).
            if (reply.status == 304) return newFixedLengthResponse(Response.Status.NOT_MODIFIED, "application/octet-stream", "").apply { cache(reply.etag) }
            val status = Response.Status.lookup(reply.status) ?: Response.Status.INTERNAL_ERROR
            val file = reply.file
            if (file != null) {
                val stream = FileInputStream(file)
                val size = file.length()
                // Unix keeps the inode alive while the stream is open, so a temp file can go now.
                if (reply.deleteFile) file.delete()
                return newFixedLengthResponse(status, reply.mime, stream, size)
            }
            return newFixedLengthResponse(status, reply.mime, reply.body.inputStream(), reply.body.size.toLong()).apply { cache(reply.etag) }
        } finally {
            body.release()
        }
    }

    /** Page assets: the browser keeps them but asks every time (If-None-Match), so an updated app is never stale. */
    private fun Response.cache(etag: String?) {
        if (etag == null) return
        addHeader("ETag", etag)
        addHeader("Cache-Control", "no-cache")
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

    private fun unauthorized(method: String, path: String, query: String?, headers: Map<String, String>, remote: String): Response {
        val now = System.currentTimeMillis()
        if (Pairing.Throttle.blocked(remote, now)) return error(Response.Status.TOO_MANY_REQUESTS, "too many wrong pairing codes, retry in a minute")
        if (HttpGuard.presented(headers).isNotEmpty()) Pairing.Throttle.fail(remote, now)
        if (HttpGuard.isPage(method, path)) return redirect(HttpGuard.pairRedirect(path, query))
        return newFixedLengthResponse(
            Response.Status.UNAUTHORIZED, JSON,
            JSONObject().put("error", "pairing required").put("pairing", true)
                .put("hint", "enter the pairing code shown on the phone (XScript → 开发与连接 → 配对码)").toString(),
        ).apply { addHeader("WWW-Authenticate", "Bearer realm=\"xscript\"") }
    }

    /**
     * `GET /pair` the pairing page (or `?code=…` to pair from a link), `POST /pair {"code": …}`.
     * Success sets the `xs_pair` cookie for the device's own web tools.
     */
    private fun pair(session: IHTTPSession, method: String, headers: Map<String, String>, remote: String, required: Boolean, code: String): Response {
        val parms = session.parms ?: emptyMap()
        val next = parms["next"]?.takeIf { it.startsWith("/") && !it.startsWith("//") && !it.startsWith("/\\") } ?: "/tools/"
        val given = when (method) {
            "POST" -> {
                if (!HttpGuard.isJson(headers["content-type"])) return error(Response.Status.UNSUPPORTED_MEDIA_TYPE, "expected application/json")
                val len = headers["content-length"]?.toLongOrNull() ?: 0L
                if (len > 4096) return error(Response.Status.PAYLOAD_TOO_LARGE, "body too large")
                val text = String(readBody(session.inputStream, len).bytes(), Charsets.UTF_8)
                try { JSONObject(text.ifBlank { "{}" }).optString("code") } catch (_: Exception) { return error(Response.Status.BAD_REQUEST, "invalid json") }
            }
            else -> parms["code"]
        }
        if (!required) {
            return if (method == "POST") json(Response.Status.OK, JSONObject().put("ok", true).put("pairing", false)) else redirect(next)
        }
        if (given == null) {
            if (HttpGuard.matches(HttpGuard.presented(headers), code)) return redirect(next)
            return router.handle(ApiRouter.Request("GET", "/tools/ui/pair.html", emptyMap(), ApiRouter.Body.EMPTY)).let {
                newFixedLengthResponse(Response.Status.OK, it.mime, it.body.inputStream(), it.body.size.toLong())
                    .apply { addHeader("Cache-Control", "no-store") }
            }
        }
        val now = System.currentTimeMillis()
        if (Pairing.Throttle.blocked(remote, now)) return error(Response.Status.TOO_MANY_REQUESTS, "too many wrong pairing codes, retry in a minute")
        if (!HttpGuard.matches(given, code)) {
            Pairing.Throttle.fail(remote, now)
            return if (method == "POST") error(Response.Status.UNAUTHORIZED, "invalid code") else redirect("/pair?next=" + java.net.URLEncoder.encode(next, "UTF-8"))
        }
        val reply = if (method == "POST") json(Response.Status.OK, JSONObject().put("ok", true).put("pairing", true)) else redirect(next)
        reply.addHeader("Set-Cookie", "${HttpGuard.COOKIE}=$code; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000")
        return reply
    }

    private fun redirect(to: String): Response =
        newFixedLengthResponse(Response.Status.REDIRECT_SEE_OTHER, "text/plain", "").apply {
            addHeader("Location", to)
            addHeader("Cache-Control", "no-store")
        }

    private fun json(status: Response.Status, body: JSONObject): Response = newFixedLengthResponse(status, JSON, body.toString())

    private fun error(status: Response.Status, message: String): Response =
        newFixedLengthResponse(status, JSON, JSONObject().put("error", message).toString())

    companion object {
        private const val JSON = "application/json; charset=utf-8"
        private const val MAX_BODY = 200L * 1024 * 1024
        private const val MEMORY_LIMIT = 4L * 1024 * 1024
    }
}
