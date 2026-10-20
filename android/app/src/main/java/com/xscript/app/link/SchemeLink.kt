package com.xscript.app.link

import com.xscript.app.project.ProjectStore
import org.json.JSONObject
import java.net.URLDecoder

/**
 * `xscript://run?name=<project>[&params=<json object>]`, `xscript://open?name=…` and `xscript://stop`.
 * AScript-compatible aliases: the `ascript://` scheme, `local=` for `name=`, a bare `ascript://` meaning run.
 * Packaged apps answer to their application id and its last segment (AScript's rule) and run their bundled
 * project; there, `id=` / `local=` are ignored like in AScript (only a conflicting `name=` is refused).
 * Pure JVM so the parsing and the security rules are unit-tested; the Activity only applies them.
 */
sealed class SchemeLink {
    data class Run(val project: String, val params: String) : SchemeLink()
    object Stop : SchemeLink()
    /** Open the project page without running (AScript `open`). */
    data class Open(val project: String) : SchemeLink()
    data class Invalid(val reason: String) : SchemeLink()

    companion object {
        const val MODE_CONFIRM = "confirm" // ask every time (default)
        const val MODE_ALLOW = "allow"     // run straight away
        const val MODE_OFF = "off"         // links are ignored
        const val MAX_PARAMS = 4096

        fun isMode(m: String) = m == MODE_CONFIRM || m == MODE_ALLOW || m == MODE_OFF

        /** Schemes of the main app: our own plus AScript's, so AScript links work unchanged. */
        val MAIN_SCHEMES = listOf("xscript", "ascript")

        /** Schemes of a packaged app: the full application id and its last segment (AScript's rule). */
        fun packedSchemes(appId: String): List<String> {
            val id = appId.lowercase()
            return listOf(id, id.substringAfterLast('.')).filter { it.isNotEmpty() }.distinct()
        }

        fun parse(url: String?, scheme: String, bundled: String = ""): SchemeLink = parse(url, listOf(scheme), bundled)

        /**
         * @param schemes the schemes this build answers to
         * @param bundled non-empty in a packaged app: the only project it may run (name may be omitted)
         */
        fun parse(url: String?, schemes: List<String>, bundled: String = ""): SchemeLink {
            val text = url?.trim().orEmpty()
            if (text.isEmpty()) return Invalid("空链接")
            val head = text.substringBefore("://", "")
            if (head.isEmpty() || schemes.none { it.equals(head, ignoreCase = true) }) return Invalid("不支持的链接")
            val rest = text.substringAfter("://").substringBefore('#')
            val action = rest.substringBefore('?').trim('/').lowercase()
            val query = parseQuery(rest.substringAfter('?', ""))
                ?: return Invalid("链接参数格式错误")
            return when (action) {
                "stop" -> Stop
                "run", "" -> {
                    val project = target(query, bundled).let { if (it is Invalid) return it else (it as Open).project }
                    val params = query["params"].orEmpty()
                    if (params.length > MAX_PARAMS) return Invalid("params 过长（最多 $MAX_PARAMS 字符）")
                    if (params.isNotEmpty() && runCatching { JSONObject(params) }.isFailure) return Invalid("params 必须是 JSON 对象")
                    Run(project, params.ifEmpty { "{}" })
                }
                "open" -> target(query, bundled)
                else -> Invalid("未知操作: $action，支持 run、open、stop")
            }
        }

        /** The project a run/open link names: `name=`, else AScript's `local=`; a packaged app always its own. */
        private fun target(query: Map<String, String>, bundled: String): SchemeLink {
            val given = query["name"].orEmpty().trim()
            if (bundled.isNotEmpty()) {
                if (given.isNotEmpty() && given != bundled) return Invalid("此应用只能运行 $bundled")
                return Open(bundled)
            }
            val name = given.ifEmpty { query["local"].orEmpty().trim() }
            if (name.isEmpty()) {
                return if (query["id"].orEmpty().isNotBlank()) Invalid("不支持按 id 运行在线小程序，请用 local=工程名 或 name=工程名")
                else Invalid("缺少 name 参数")
            }
            if (!ProjectStore.isValidName(name)) return Invalid("工程名不合法: $name")
            return Open(name)
        }

        private fun parseQuery(q: String): Map<String, String>? {
            val out = LinkedHashMap<String, String>()
            if (q.isEmpty()) return out
            for (pair in q.split('&')) {
                if (pair.isEmpty()) continue
                val k = pair.substringBefore('=')
                val v = pair.substringAfter('=', "")
                try {
                    out.putIfAbsent(URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8"))
                } catch (_: IllegalArgumentException) {
                    return null
                }
            }
            return out
        }

        /** What to do with a parsed link under [mode]: "run", "ask" or "refuse" (stop and open are low-risk, so they never ask). */
        fun decide(link: SchemeLink, mode: String): String = when {
            link is Invalid || mode == MODE_OFF || !isMode(mode) -> "refuse"
            link is Stop || link is Open -> "run"
            mode == MODE_ALLOW -> "run"
            else -> "ask"
        }
    }
}
