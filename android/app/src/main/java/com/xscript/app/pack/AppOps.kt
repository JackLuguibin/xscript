package com.xscript.app.pack

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import com.xscript.app.BuildConfig
import com.xscript.app.runtime.LogBuffer
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * 公告 and APK 强制更新 for packaged apps. The app asks the 管理后台 (`/pub/app-notices`,
 * `/pub/app-update`) when its home screen opens (at most once a minute): notices are shown once
 * each; a newer APK is offered; when the installed versionCode is below the server's minimum the
 * app refuses to start scripts and the home screen shows a blocking update dialog that downloads
 * the APK (sha256 checked) and hands it to the system installer.
 *
 * Never a lock-out: the server answers `update: false` when its APK is gone, which lifts the
 * block at the next check; a version at or above the minimum is never blocked, whatever was cached.
 */
object AppOps {
    private const val PREFS = "xscript_appops"
    private const val MIN_INTERVAL_MS = 60_000L
    private const val MAX_APK = 600L * 1024 * 1024

    @Volatile
    private var busy = false

    /** The server that serves the public /pub endpoints: dedicated, else the 热更新 server, else the 卡密 server. */
    fun server(): String = listOf(BuildConfig.OPS_SERVER, BuildConfig.UPDATE_SERVER, BuildConfig.LICENSE_SERVER)
        .firstOrNull { it.isNotBlank() }?.trim()?.trimEnd('/') ?: ""

    fun enabled(): Boolean = PackInstaller.isPacked() && server().isNotEmpty()

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun installedCode(context: Context): Long = PackInstaller.versionCode(context)

    /** Last answer of /pub/app-update, or null (never checked / not enabled / lifted). */
    fun update(context: Context): AppOpsModel.Update? =
        prefs(context).getString("update", null)?.let { runCatching { AppOpsModel.parseUpdate(it) }.getOrNull() }

    fun notices(context: Context): List<AppOpsModel.Notice> =
        prefs(context).getString("notices", null)?.let { runCatching { AppOpsModel.parseNotices(it) }.getOrNull() }.orEmpty()

    fun unseenNotices(context: Context): List<AppOpsModel.Notice> {
        val seen = prefs(context).getStringSet("seen", emptySet()).orEmpty()
        return notices(context).filter { it.id.toString() !in seen }
    }

    fun markSeen(context: Context, ns: List<AppOpsModel.Notice>) {
        val p = prefs(context)
        val seen = (p.getStringSet("seen", emptySet()).orEmpty() + ns.map { it.id.toString() }).toList().takeLast(200).toSet()
        p.edit().putStringSet("seen", seen).apply()
    }

    fun mustUpdate(context: Context): Boolean = enabled() && AppOpsModel.mustUpdate(update(context), installedCode(context), server())

    fun offerUpdate(context: Context): Boolean = enabled() && AppOpsModel.offerUpdate(update(context), installedCode(context), server())

    fun dismissedCode(context: Context): Int = prefs(context).getInt("dismissed_code", 0)

    fun dismissUpdate(context: Context, code: Int) {
        prefs(context).edit().putInt("dismissed_code", code).apply()
    }

    /** null = scripts may start; otherwise the reason (forced update pending). */
    fun gate(context: Context): String? {
        if (!mustUpdate(context)) return null
        val u = update(context)!!
        return "需要先更新到 ${u.latestName.ifEmpty { "v" + u.latestCode }} 才能使用"
    }

    fun status(context: Context): JSONObject {
        val p = prefs(context)
        return JSONObject().put("enabled", enabled()).put("server", server())
            .put("installed_code", installedCode(context)).put("must_update", mustUpdate(context))
            .put("offer_update", offerUpdate(context)).put("notices", notices(context).size)
            .put("checked", p.getLong("checked", 0L)).put("error", p.getString("error", "") ?: "")
    }

    /** Ask the server. [done] runs on the checking thread when the check finished (also after an error). */
    fun checkAsync(context: Context, force: Boolean = false, done: (() -> Unit)? = null) {
        if (!enabled() || busy) return
        val p = prefs(context)
        if (!force && System.currentTimeMillis() - p.getLong("checked", 0L) < MIN_INTERVAL_MS) return
        busy = true
        val app = context.applicationContext
        thread(name = "xscript-appops") {
            try {
                val srv = server()
                val q = "app=" + enc(app.packageName) + "&version_code=" + installedCode(app)
                val notices = String(get("$srv/pub/app-notices?$q", 256 * 1024), Charsets.UTF_8)
                AppOpsModel.parseNotices(notices) // validate before it replaces the cache
                val upd = String(get("$srv/pub/app-update?$q", 256 * 1024), Charsets.UTF_8)
                val parsed = AppOpsModel.parseUpdate(upd)
                // A "no update" answer replaces the cached policy, which lifts a forced update the server withdrew.
                p.edit().putString("notices", notices).putString("update", parsed.toJson())
                    .putLong("checked", System.currentTimeMillis()).putString("error", "").apply()
                if (AppOpsModel.mustUpdate(parsed, installedCode(app), srv)) {
                    LogBuffer.append(app, "stderr", "xscript: 需要强制更新到 ${parsed.latestName}\n")
                }
            } catch (t: Throwable) {
                p.edit().putLong("checked", System.currentTimeMillis()).putString("error", t.message ?: t.toString()).apply()
            } finally {
                busy = false
                done?.invoke()
            }
        }
    }

    class Download(val file: File?, val error: String?)

    /** Download the APK of [u] into the cache (blocking), verify size and sha256 when given. */
    fun download(context: Context, u: AppOpsModel.Update, progress: (Int) -> Unit): Download {
        val url = AppOpsModel.resolveUrl(server(), u.url) ?: return Download(null, "没有可用的下载地址")
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, "update-${u.latestCode}.apk")
        val tmp = File(dir, out.name + ".part")
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            try {
                conn.connectTimeout = 10_000
                conn.readTimeout = 60_000
                if (conn.responseCode != 200) return Download(null, "服务器返回 HTTP ${conn.responseCode}")
                val total = conn.contentLengthLong.takeIf { it > 0 } ?: u.size
                val md = MessageDigest.getInstance("SHA-256")
                var got = 0L
                var lastPct = -1
                conn.inputStream.use { input ->
                    tmp.outputStream().use { o ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            o.write(buf, 0, n)
                            md.update(buf, 0, n)
                            got += n
                            require(got <= MAX_APK) { "文件过大" }
                            if (total > 0) {
                                val pct = (got * 100 / total).toInt().coerceAtMost(100)
                                if (pct != lastPct) { lastPct = pct; progress(pct) }
                            }
                        }
                    }
                }
                if (u.size > 0 && got != u.size) return Download(null, "文件大小不符（$got / ${u.size}）")
                val sha = md.digest().joinToString("") { "%02x".format(it) }
                if (u.sha256.isNotEmpty() && sha != u.sha256) { tmp.delete(); return Download(null, "文件校验失败（sha256 不符）") }
                if (!tmp.renameTo(out)) return Download(null, "无法保存文件")
                Download(out, null)
            } finally {
                conn.disconnect()
            }
        } catch (t: Throwable) {
            tmp.delete()
            Download(null, "下载失败: ${t.message ?: t}")
        }
    }

    /** Hand [apk] to the system installer. Returns a user-facing problem, or null when the installer was opened. */
    fun install(activity: Activity, apk: File): String? {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)),
            )
            return "请先允许本应用安装未知应用，然后再点「下载并安装」"
        }
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
        activity.startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )
        return null
    }

    /** No in-app download (external link): open it in the browser. */
    fun openExternal(activity: Activity, u: AppOpsModel.Update) {
        val url = AppOpsModel.resolveUrl(server(), u.url) ?: return
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

    private fun get(url: String, limit: Int): ByteArray {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8_000
            conn.readTimeout = 15_000
            require(conn.responseCode == 200) { "HTTP ${conn.responseCode}" }
            val bytes = conn.inputStream.use { it.readBytes() }
            require(bytes.size <= limit) { "response too large" }
            return bytes
        } finally {
            conn.disconnect()
        }
    }
}
