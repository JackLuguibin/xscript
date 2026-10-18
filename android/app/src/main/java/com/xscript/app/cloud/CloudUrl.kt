package com.xscript.app.cloud

/**
 * The stored 云控 URL may carry the device key as `?token=…` (that is what the console hands out, and
 * the client still needs it to authenticate). Anything that *reports* the URL — cloud status (HTTP API
 * and scripts), the device info sent to the server, GET /api/settings — shows it via [redact], so the
 * key can't be read back out of those fields. The stored value and the on-device edit field keep it.
 */
internal object CloudUrl {
    const val MASK = "***"

    /** `ws://h/ws?group=g&token=xsd_…` → `ws://h/ws?group=g&token=***`; URLs without a token come back unchanged. */
    fun redact(url: String): String {
        val q = url.indexOf('?')
        if (q < 0) return url
        val hash = url.indexOf('#', q).let { if (it < 0) url.length else it }
        val parts = url.substring(q + 1, hash).split('&')
        if (parts.none { it.substringBefore('=') == "token" && it.length > "token=".length }) return url
        val masked = parts.joinToString("&") { if (it.substringBefore('=') == "token" && it.length > "token=".length) "token=$MASK" else it }
        return url.substring(0, q + 1) + masked + url.substring(hash)
    }
}
