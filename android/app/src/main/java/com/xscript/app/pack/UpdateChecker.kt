package com.xscript.app.pack

import android.content.Context
import com.xscript.app.BuildConfig
import com.xscript.app.license.LicenseToken
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.LogBuffer
import com.xscript.app.runtime.RunState
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * 热更新 for packaged apps: fetch the newest published version of the bundled 小程序 from
 * the 管理后台 (`/pub/update`), check the signed manifest and the zip's sha256, and swap the
 * project in. Runs at app start and at most every 30 minutes; never while the script runs,
 * so the next start picks the update up. Rolling back on the server rolls devices back too.
 */
object UpdateChecker {
    private const val PREFS = "xscript_update"
    private const val INTERVAL_MS = 30 * 60_000L
    private const val MAX_BYTES = 64L * 1024 * 1024

    @Volatile
    private var busy = false

    fun enabled(): Boolean =
        PackInstaller.isPacked() && BuildConfig.UPDATE_SERVER.isNotEmpty() && BuildConfig.UPDATE_CHANNEL.isNotEmpty() &&
            BuildConfig.UPDATE_PUBKEY.isNotEmpty()

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Version code of the installed project (bundled one until the first update). */
    fun installedCode(context: Context): Int = prefs(context).getInt("code", BuildConfig.PACK_SCRIPT_CODE)

    fun status(context: Context): JSONObject = JSONObject()
        .put("enabled", enabled())
        .put("code", installedCode(context))
        .put("version", prefs(context).getString("version", "") ?: "")
        .put("checked", prefs(context).getLong("checked", 0L))
        .put("error", prefs(context).getString("error", "") ?: "")

    /** Called when the bundled project is (re)installed from the APK, e.g. after an app update. */
    fun resetToBundled(context: Context) {
        prefs(context).edit().clear().apply()
    }

    private var timer: java.util.concurrent.ScheduledExecutorService? = null

    /** Main process: check now, then every [INTERVAL_MS] while the app is alive. */
    @Synchronized
    fun start(context: Context) {
        if (!enabled() || timer != null) return
        val app = context.applicationContext
        timer = java.util.concurrent.Executors.newSingleThreadScheduledExecutor().apply {
            scheduleWithFixedDelay({ checkAsync(app) }, 5, INTERVAL_MS / 1000, java.util.concurrent.TimeUnit.SECONDS)
        }
    }

    fun checkAsync(context: Context, force: Boolean = false) {
        if (!enabled() || busy) return
        val p = prefs(context)
        if (!force && System.currentTimeMillis() - p.getLong("checked", 0L) < INTERVAL_MS) return
        busy = true
        thread(name = "xscript-update") {
            try {
                val msg = check(context.applicationContext)
                p.edit().putLong("checked", System.currentTimeMillis()).putString("error", "").apply()
                if (msg != null) LogBuffer.append(context, "stdout", "xscript: $msg\n")
            } catch (t: Throwable) {
                p.edit().putLong("checked", System.currentTimeMillis()).putString("error", t.message ?: t.toString()).apply()
            } finally {
                busy = false
            }
        }
    }

    /** One check; returns a log line when something was installed. Blocking. */
    private fun check(context: Context): String? {
        val project = PackInstaller.project
        if (RunState.current(context) == project) return null // retry after the run
        val server = BuildConfig.UPDATE_SERVER.trimEnd('/')
        val code = installedCode(context)
        val url = "$server/pub/update?channel=${enc(BuildConfig.UPDATE_CHANNEL)}&code=$code"
        val reply = JSONObject(String(get(url, 1024 * 1024), Charsets.UTF_8))
        if (!reply.optBoolean("update")) return null
        val key = LicenseToken.publicKey(BuildConfig.UPDATE_PUBKEY) ?: error("bad update key")
        val info = UpdateManifest.verify(key, reply.optString("manifest"), BuildConfig.UPDATE_CHANNEL, project)
            ?: error("update manifest signature invalid")
        if (info.code == code) return null
        val path = reply.optString("url")
        require(path.startsWith("/pub/bundle/")) { "unexpected bundle url" }
        val zip = get(server + path, MAX_BYTES)
        require(UpdateManifest.sha256(zip) == info.sha256) { "bundle checksum mismatch" }
        if (RunState.current(context) == project) return null
        ProjectStore(context).importZip(project, ByteArrayInputStream(zip), replace = true)
        prefs(context).edit().putInt("code", info.code).putString("version", info.version).apply()
        return "热更新 $project → ${info.version}（${if (info.code < code) "回滚" else "更新"}）"
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

    private fun get(url: String, limit: Long): ByteArray {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 60_000
            val codeHttp = conn.responseCode
            require(codeHttp == 200) { "HTTP $codeHttp" }
            val out = ByteArrayOutputStream()
            conn.inputStream.use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    require(out.size() <= limit) { "response too large" }
                }
            }
            return out.toByteArray()
        } finally {
            conn.disconnect()
        }
    }
}
