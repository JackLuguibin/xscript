package com.xscript.app.pack

import com.xscript.app.license.LicenseToken
import org.json.JSONObject
import java.security.MessageDigest
import java.security.PublicKey

/**
 * Pure-JVM half of [UpdateChecker]: the server signs a manifest with the same ECDSA P-256 key
 * as 卡密 tokens ({"channel", "project", "version", "version_code", "sha256", "size", "iat"}).
 */
object UpdateManifest {
    class Info(val project: String, val version: String, val code: Int, val sha256: String, val size: Long)

    /** Parsed manifest when the signature is valid and it belongs to [channel] / [project]. */
    fun verify(key: PublicKey, token: String, channel: String, project: String): Info? {
        val p: JSONObject = LicenseToken.verify(key, token) ?: return null
        if (p.optString("channel") != channel || p.optString("project") != project) return null
        val sha = p.optString("sha256")
        if (!sha.matches(Regex("[0-9a-f]{64}"))) return null
        return Info(project, p.optString("version"), p.optInt("version_code"), sha, p.optLong("size"))
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
