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
}
