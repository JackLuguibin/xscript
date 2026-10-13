package com.xscript.app.license

import android.content.Context
import com.xscript.app.BuildConfig
import com.xscript.app.cloud.CloudClient
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.PublicKey
import kotlin.concurrent.thread

/**
 * 卡密授权 for packaged apps.
 *
 * A license is a token `base64url(payload JSON) "." base64url(ECDSA P-256 / SHA-256 DER signature)`
 * signed by the developer's private key; the app only holds the public key
 * ([BuildConfig.LICENSE_PUBKEY]). Payload:
 *   {"card": "XS-...", "device": "<ANDROID_ID>" | "*", "app": "<applicationId>" | "*",
 *    "exp": <epoch seconds, 0 = never>, "iat": <epoch seconds>}
 *
 * Activation: the user types a short card code; the app posts it with its device id to
 * `<LICENSE_SERVER>/license/activate`, which binds the card and returns a signed token.
 * Pasting a full token works offline (管理后台 → 卡密管理 → 离线授权码).
 * With a server configured the token is re-verified every 6 hours, so revoked cards stop
 * working; a network error keeps the current license.
 *
 * This is client-side enforcement: it stops ordinary copying, not a determined attacker
 * who patches the APK.
 */
object LicenseManager {
    class Result(val ok: Boolean, val message: String)

    private const val PREFS = "xscript_license"
    private const val REVERIFY_MS = 6 * 3600_000L
    private const val CLOCK_SLACK_S = 86_400L

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun required(): Boolean = BuildConfig.LICENSE_REQUIRED && BuildConfig.LICENSE_PUBKEY.isNotEmpty()

    private val publicKey: PublicKey? by lazy { LicenseToken.publicKey(BuildConfig.LICENSE_PUBKEY) }

    /** null when scripts may run, otherwise a user-facing reason. */
    fun check(context: Context): String? {
        if (!required()) return null
        val token = prefs(context).getString("token", null) ?: return "未激活，请输入卡密"
        val payload = verify(context, token) ?: return "授权无效，请重新激活"
        val exp = payload.optLong("exp", 0L)
        if (exp in 1..now(context)) return "卡密已过期"
        reverifyLater(context, token)
        return null
    }

    fun status(context: Context): JSONObject {
        val out = JSONObject().put("required", required()).put("server", BuildConfig.LICENSE_SERVER)
        val token = prefs(context).getString("token", null)
        val payload = token?.let { verify(context, it) }
        out.put("activated", payload != null)
        if (payload != null) {
            val card = payload.optString("card")
            out.put("card", mask(card))
            out.put("expires", payload.optLong("exp", 0L))
        }
        out.put("error", check(context) ?: "")
        out.put("device_id", CloudClient.deviceId(context))
        return out
    }

    /** Full card code of the current license (AScript R.get_card()). */
    fun card(context: Context): String? =
        prefs(context).getString("token", null)?.let { verify(context, it) }?.optString("card")?.ifEmpty { null }

    private fun mask(card: String): String = if (card.length <= 8) card else card.take(4) + "****" + card.takeLast(4)

    /** Card code (online) or full token (offline). Blocking: call off the UI thread. */
    fun activate(context: Context, input: String): Result {
        val code = input.trim()
        if (code.isEmpty()) return Result(false, "请输入卡密")
        if (code.count { it == '.' } == 1 && code.length > 80) return store(context, code)
        val server = BuildConfig.LICENSE_SERVER.trimEnd('/')
        if (server.isEmpty()) return Result(false, "此应用未配置授权服务器，请粘贴完整授权码")
        return try {
            val reply = post(
                "$server/license/activate",
                JSONObject()
                    .put("card", code)
                    .put("device_id", CloudClient.deviceId(context))
                    .put("app", context.packageName)
                    .put("model", android.os.Build.MODEL ?: ""),
            )
            val token = reply.optString("token")
            if (token.isEmpty()) Result(false, reply.optString("error").ifEmpty { "激活失败" }) else store(context, token)
        } catch (t: Throwable) {
            Result(false, "无法连接授权服务器: ${t.message ?: t}")
        }
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }

    private fun store(context: Context, token: String): Result {
        val payload = verify(context, token) ?: return Result(false, "授权码无效或不属于本设备")
        val exp = payload.optLong("exp", 0L)
        if (exp in 1..now(context)) return Result(false, "卡密已过期")
        prefs(context).edit()
            .putString("token", token)
            .putLong("checked", System.currentTimeMillis())
            .apply()
        return Result(true, if (exp == 0L) "已激活（永久）" else "已激活")
    }

    /** Payload when the signature, device and app match; null otherwise. */
    fun verify(context: Context, token: String): JSONObject? {
        val key = publicKey ?: return null
        val payload = LicenseToken.verify(key, token) ?: return null
        return if (LicenseToken.matches(payload, CloudClient.deviceId(context), context.packageName)) payload else null
    }

    /** Wall clock, but never earlier than the latest time seen (defeats winding the clock back). */
    private fun now(context: Context): Long {
        val p = prefs(context)
        val wall = System.currentTimeMillis() / 1000
        val seen = p.getLong("seen", 0L)
        if (wall > seen) p.edit().putLong("seen", wall).apply()
        return if (wall + CLOCK_SLACK_S < seen) seen else wall
    }

    @Volatile
    private var verifying = false

    private fun reverifyLater(context: Context, token: String) {
        val server = BuildConfig.LICENSE_SERVER.trimEnd('/')
        if (server.isEmpty() || verifying) return
        val p = prefs(context)
        if (System.currentTimeMillis() - p.getLong("checked", 0L) < REVERIFY_MS) return
        verifying = true
        thread(name = "xscript-license") {
            try {
                val reply = post("$server/license/verify", JSONObject().put("token", token).put("device_id", CloudClient.deviceId(context)))
                if (reply.optBoolean("revoked") || reply.optString("status") == "revoked") {
                    p.edit().remove("token").apply()
                } else {
                    p.edit().putLong("checked", System.currentTimeMillis()).apply()
                }
            } catch (_: Throwable) {
                // Offline: keep the license; try again next time.
            } finally {
                verifying = false
            }
        }
    }

    private fun post(url: String, body: JSONObject): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            return if (text.isBlank()) JSONObject().put("error", "HTTP ${conn.responseCode}") else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }
}
