package com.xscript.app.license

import org.json.JSONObject

/**
 * 按次卡: what a `/license/use` (or `/license/verify`) reply means for the app. Free of android.* for the JVM tests.
 *
 * Contract (backend `routes/cards.py`): POST /license/use {"token", "device_id"} →
 * {"status": "ok"|"exhausted"|"expired"|"revoked"|"unknown", "revoked": bool, "uses_left": int}; non-count cards answer -1.
 * Only "ok" may run. A reply without a known status (old server, HTTP error body) is treated like a network failure.
 */
object LicenseUse {
    const val EXHAUSTED = "次数已用完"
    const val EXPIRED = "卡密已过期"
    const val REVOKED = "授权已被停用，请重新激活"

    /**
     * [allow]: the run may start. [block]: message to show (and remember) when it may not. [dropToken]: forget the license
     * (revoked / unknown card) so the activation dialog comes back. [usesLeft]: remaining uses, -1 when unlimited / unknown.
     */
    data class Outcome(val allow: Boolean, val block: String?, val dropToken: Boolean, val usesLeft: Int, val offline: Boolean = false)

    val OFFLINE = Outcome(allow = true, block = null, dropToken = false, usesLeft = -1, offline = true)

    fun decide(reply: JSONObject): Outcome {
        val left = if (reply.has("uses_left")) reply.optInt("uses_left", -1) else -1
        val status = reply.optString("status")
        if (reply.optBoolean("revoked") || status == "revoked" || status == "unknown") return Outcome(false, REVOKED, true, 0)
        return when (status) {
            "ok" -> Outcome(true, null, false, left)
            "exhausted" -> Outcome(false, EXHAUSTED, false, 0)
            "expired" -> Outcome(false, EXPIRED, false, left)
            else -> OFFLINE // unrecognised reply: keep the existing "network error keeps the license" behaviour
        }
    }

    /** Line logged when a count card was used. */
    fun describe(o: Outcome): String? = if (o.allow && o.usesLeft >= 0) "剩余 ${o.usesLeft} 次" else null
}
