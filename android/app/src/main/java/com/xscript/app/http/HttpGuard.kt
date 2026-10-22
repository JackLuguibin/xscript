package com.xscript.app.http

import java.security.MessageDigest

/**
 * Request checks for the LAN HTTP server, kept free of Android types so they are unit tested on the JVM.
 *
 *  - Host allowlist: only IP literals and `localhost`. A DNS-rebinding page reaches the device under its
 *    own host name, so it is refused before any route runs.
 *  - Origin: a browser request must come from the device's own pages (Origin == Host). Native clients
 *    send no Origin header.
 *  - Pairing token: `Authorization: Bearer <code>`, `X-XScript-Token`, or the `xs_pair` cookie that the
 *    pairing page sets for the device's own web tools. Only [isPublic] routes skip it.
 *  - JSON bodies must be sent as `application/json` (see [ApiRouter.Request.json]).
 */
object HttpGuard {
    const val COOKIE = "xs_pair"
    const val TOKEN_HEADER = "x-xscript-token"

    enum class Verdict { OK, BAD_HOST, BAD_ORIGIN, UNAUTHORIZED }

    class Check(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val token: String,
        val required: Boolean,
    )

    fun verdict(c: Check): Verdict {
        val host = c.headers["host"]
        if (!hostAllowed(host)) return Verdict.BAD_HOST
        if (!originAllowed(c.headers["origin"], host)) return Verdict.BAD_ORIGIN
        if (!c.required || isPublic(c.method, c.path)) return Verdict.OK
        return if (matches(presented(c.headers), c.token)) Verdict.OK else Verdict.UNAUTHORIZED
    }

    /** Routes that work before pairing: the device's identity (desktop scan) and the pairing page itself. */
    fun isPublic(method: String, path: String): Boolean {
        val p = path.trimEnd('/').ifEmpty { "/" }
        return when {
            p == "/status" && method == "GET" -> true
            p == "/pair" && (method == "GET" || method == "POST") -> true
            p == "/favicon.ico" && method == "GET" -> true
            // Page scripts and styles carry no data; the HTML pages themselves need pairing.
            method == "GET" && p.startsWith("/tools/ui/") && (p.endsWith(".js") || p.endsWith(".css")) -> true
            else -> false
        }
    }

    /** Pages a browser opens directly: unpaired, they redirect to the pairing page instead of a JSON 401. */
    /** Pairing page that comes back to [path] with its [query] (e.g. the Web IDE's ?project=…&file=… link). */
    fun pairRedirect(path: String, query: String?): String =
        "/pair?next=" + java.net.URLEncoder.encode(path + (query?.takeIf { it.isNotEmpty() }?.let { "?$it" } ?: ""), "UTF-8")

    fun isPage(method: String, path: String): Boolean {
        if (method != "GET") return false
        val p = path.trimEnd('/').ifEmpty { "/" }
        return p == "/" || p == "/tools" || p.endsWith(".html") || p.startsWith("/website/")
    }

    fun hostAllowed(host: String?): Boolean {
        if (host.isNullOrBlank()) return true // HTTP/1.0 tools; every browser sends Host
        val name = hostName(host.trim()) ?: return false
        return name.equals("localhost", ignoreCase = true) || isIpLiteral(name)
    }

    fun originAllowed(origin: String?, host: String?): Boolean {
        if (origin == null) return true
        val o = origin.trim()
        if (o.isEmpty()) return true
        if (host.isNullOrBlank()) return false
        val authority = o.substringAfter("://", "").trimEnd('/')
        if (!o.startsWith("http://") || authority.isEmpty()) return false
        return authority.equals(host.trim(), ignoreCase = true)
    }

    /** Token the client presented, or "" if none. */
    fun presented(headers: Map<String, String>): String {
        headers["authorization"]?.trim()?.let { a ->
            if (a.startsWith("Bearer ", ignoreCase = true)) return a.substring(7).trim()
        }
        headers[TOKEN_HEADER]?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return cookie(headers["cookie"], COOKIE) ?: ""
    }

    fun cookie(header: String?, name: String): String? {
        if (header.isNullOrEmpty()) return null
        for (part in header.split(';')) {
            val kv = part.trim()
            val i = kv.indexOf('=')
            if (i > 0 && kv.substring(0, i) == name) return kv.substring(i + 1).trim()
        }
        return null
    }

    /** Constant-time compare of normalized codes ("abcd-efgh" == "ABCDEFGH"). */
    fun matches(given: String, expected: String): Boolean {
        val a = normalize(given)
        val b = normalize(expected)
        if (a.isEmpty() || b.isEmpty()) return false
        return MessageDigest.isEqual(a.toByteArray(), b.toByteArray())
    }

    fun normalize(code: String): String = code.filter { it.isLetterOrDigit() }.uppercase()

    fun isJson(contentType: String?): Boolean {
        val t = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return false
        return t == "application/json" || (t.startsWith("application/") && t.endsWith("+json"))
    }

    private fun hostName(host: String): String? {
        if (host.startsWith("[")) {
            val end = host.indexOf(']')
            if (end < 0) return null
            val rest = host.substring(end + 1)
            if (rest.isNotEmpty() && !(rest.startsWith(":") && rest.drop(1).all { it.isDigit() })) return null
            return host.substring(0, end + 1)
        }
        val i = host.lastIndexOf(':')
        if (i < 0) return host
        val port = host.substring(i + 1)
        if (port.isEmpty() || !port.all { it.isDigit() }) return null
        return host.substring(0, i)
    }

    private fun isIpLiteral(name: String): Boolean {
        if (name.startsWith("[") && name.endsWith("]")) {
            val v6 = name.substring(1, name.length - 1).substringBefore('%')
            return v6.contains(':') && v6.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == ':' || it == '.' }
        }
        val parts = name.split('.')
        return parts.size == 4 && parts.all { p -> p.isNotEmpty() && p.length <= 3 && p.all { it.isDigit() } && p.toInt() <= 255 }
    }
}
