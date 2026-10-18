package com.xscript.app.cloud

import java.net.URLDecoder

/**
 * 云控 URLs carry the device key as `?token=…` (that is what the console hands out). Sending it in the
 * query string puts it in every access log on the way (uvicorn, nginx, Caddy), so the client moves it
 * into an `Authorization: Bearer` header and dials the URL without it. The server accepts both.
 */
internal object CloudAuth {
    data class Target(val url: String, val token: String?)

    fun split(url: String): Target {
        val q = url.indexOf('?')
        if (q < 0) return Target(url, null)
        val hash = url.indexOf('#', q).let { if (it < 0) url.length else it }
        var token: String? = null
        val keep = url.substring(q + 1, hash).split('&').filter { part ->
            val key = part.substringBefore('=')
            if (key == "token" && part.contains('=')) {
                if (token == null) token = URLDecoder.decode(part.substringAfter('='), "UTF-8").ifEmpty { null }
                false
            } else {
                part.isNotEmpty()
            }
        }
        if (token == null) return Target(url, null)
        val base = url.substring(0, q) + (if (keep.isEmpty()) "" else "?" + keep.joinToString("&"))
        return Target(base + url.substring(hash), token)
    }
}
