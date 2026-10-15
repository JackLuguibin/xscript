package com.xscript.app.license

import org.json.JSONObject
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * Pure-JVM half of [LicenseManager]: parse a public key and check a token's signature.
 * Kept free of android.* so the JVM unit tests verify tokens made by backend/xscript_server/licensing.py.
 */
object LicenseToken {
    fun publicKey(b64: String): PublicKey? = try {
        KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getMimeDecoder().decode(b64.trim())))
    } catch (_: Exception) {
        null
    }

    /** Payload when the ECDSA P-256 / SHA-256 signature is valid, else null. */
    fun verify(key: PublicKey, token: String): JSONObject? {
        val parts = token.trim().split('.')
        if (parts.size != 2) return null
        return try {
            val dec = Base64.getUrlDecoder()
            val body = dec.decode(parts[0])
            val sig = dec.decode(parts[1])
            val v = Signature.getInstance("SHA256withECDSA")
            v.initVerify(key)
            v.update(body)
            if (!v.verify(sig)) null else JSONObject(String(body, Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    /** Device / app binding: "*" matches anything. */
    fun matches(payload: JSONObject, deviceId: String, appId: String): Boolean {
        val device = payload.optString("device")
        val app = payload.optString("app")
        return (device == "*" || device == deviceId) && (app == "*" || app == appId)
    }

    /**
     * User-facing result of storing a license that expires at [exp] (epoch seconds, 0 = never) while the app
     * held one expiring at [before] (null = none or invalid): activation, or 续期 when time was added on top.
     */
    fun describeActivation(before: Long?, exp: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
        if (exp == 0L) return if (before != null && before != 0L) "续期成功，已升级为永久" else "已激活（永久）"
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.CHINA).apply { timeZone = zone }
        val until = fmt.format(java.util.Date(exp * 1000))
        if (before == null) return "已激活，有效至 $until"
        if (before == 0L) return "已激活，有效至 $until（原授权是永久的）"
        if (exp <= before) return "已激活，有效至 $until"
        val days = (exp - before + 43200) / 86400
        return "续期成功，有效至 $until（延长 $days 天）"
    }
}
