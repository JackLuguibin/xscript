package com.xscript.app.pack

import org.json.JSONObject

/**
 * Pure-JVM half of [AppOps]: parses the replies of the 管理后台 public endpoints
 * `/pub/app-notices` (公告) and `/pub/app-update` (APK 更新 / 强制更新).
 */
object AppOpsModel {
    class Notice(val id: Long, val title: String, val body: String, val level: String)

    class Update(
        val update: Boolean,
        val force: Boolean,
        val latestCode: Int,
        val latestName: String,
        val minCode: Int,
        val url: String,
        val sha256: String,
        val size: Long,
        val notes: String,
    ) {
        fun toJson(): String = JSONObject().put("update", update).put("force", force).put("latest_version_code", latestCode)
            .put("latest_version_name", latestName).put("min_version_code", minCode).put("url", url)
            .put("sha256", sha256).put("size", size).put("notes", notes).toString()
    }

    /** At most 5 notices; entries without a title are dropped. Throws on malformed JSON. */
    fun parseNotices(json: String): List<Notice> {
        val arr = JSONObject(json).optJSONArray("items") ?: return emptyList()
        val out = ArrayList<Notice>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val title = o.optString("title").trim()
            if (title.isEmpty()) continue
            val level = o.optString("level").let { if (it == "warning" || it == "urgent") it else "info" }
            out.add(Notice(o.optLong("id"), title, o.optString("body"), level))
            if (out.size >= 5) break
        }
        return out
    }

    fun parseUpdate(json: String): Update {
        val o = JSONObject(json)
        return Update(
            o.optBoolean("update"), o.optBoolean("force"), o.optInt("latest_version_code"),
            o.optString("latest_version_name"), o.optInt("min_version_code"), o.optString("url"),
            o.optString("sha256").lowercase(), o.optLong("size"), o.optString("notes"),
        )
    }

    /** Relative URLs (`/pub/app-update/apk?...`) are served by [server]; only http(s) is accepted. */
    fun resolveUrl(server: String, url: String): String? {
        val u = url.trim()
        if (u.isEmpty()) return null
        if (u.startsWith("/") && !u.startsWith("//")) return if (server.isEmpty()) null else server.trimEnd('/') + u
        return if (u.startsWith("http://") || u.startsWith("https://")) u else null
    }

    /**
     * True when the installed version is below the minimum the server demands AND there is a way to get
     * the update. Without a download address nobody is locked out.
     */
    fun mustUpdate(u: Update?, installedCode: Long, server: String): Boolean =
        u != null && u.minCode > 0 && installedCode < u.minCode && resolveUrl(server, u.url) != null

    /** An optional update is worth offering when a newer version exists and has not been dismissed. */
    fun offerUpdate(u: Update?, installedCode: Long, server: String): Boolean =
        u != null && u.update && u.latestCode.toLong() > installedCode && resolveUrl(server, u.url) != null

    /** The server's own APK endpoint can be downloaded in-app and checked against sha256; other URLs open in a browser. */
    fun inAppDownload(server: String, resolved: String): Boolean =
        server.isNotEmpty() && resolved.startsWith(server.trimEnd('/') + "/pub/app-update/apk")
}
