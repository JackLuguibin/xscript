package com.xscript.app.link

import com.xscript.app.project.ProjectStore
import org.json.JSONObject
import java.net.URLDecoder

/**
 * `xscript://run?name=<project>[&params=<json object>]` and `xscript://stop`.
 * Packaged apps use their own scheme (the application id) and run their bundled project.
 * Pure JVM so the parsing and the security rules are unit-tested; the Activity only applies them.
 */
sealed class SchemeLink {
    data class Run(val project: String, val params: String) : SchemeLink()
    object Stop : SchemeLink()
    data class Invalid(val reason: String) : SchemeLink()

    companion object {
        const val MODE_CONFIRM = "confirm" // ask every time (default)
        const val MODE_ALLOW = "allow"     // run straight away
        const val MODE_OFF = "off"         // links are ignored
        const val MAX_PARAMS = 4096

        fun isMode(m: String) = m == MODE_CONFIRM || m == MODE_ALLOW || m == MODE_OFF

        /**
         * @param scheme the scheme this build answers to
         * @param bundled non-empty in a packaged app: the only project it may run (name may be omitted)
         */
        fun parse(url: String?, scheme: String, bundled: String = ""): SchemeLink {
            val text = url?.trim().orEmpty()
            if (text.isEmpty()) return Invalid("空链接")
            val head = text.substringBefore("://", "")
            if (!head.equals(scheme, ignoreCase = true)) return Invalid("不支持的链接")
            val rest = text.substringAfter("://").substringBefore('#')
            val action = rest.substringBefore('?').trim('/').lowercase()
            val query = parseQuery(rest.substringAfter('?', ""))
                ?: return Invalid("链接参数格式错误")
            return when (action) {
                "stop" -> Stop
                "run" -> {
                    val given = query["name"].orEmpty().trim()
                    if (bundled.isNotEmpty()) {
                        if (given.isNotEmpty() && given != bundled) return Invalid("此应用只能运行 $bundled")
                    } else {
                        if (given.isEmpty()) return Invalid("缺少 name 参数")
                        if (!ProjectStore.isValidName(given)) return Invalid("工程名不合法: $given")
                    }
                    val params = query["params"].orEmpty()
                    if (params.length > MAX_PARAMS) return Invalid("params 过长（最多 $MAX_PARAMS 字符）")
                    if (params.isNotEmpty() && runCatching { JSONObject(params) }.isFailure) return Invalid("params 必须是 JSON 对象")
                    Run(bundled.ifEmpty { given }, params.ifEmpty { "{}" })
                }
                else -> Invalid("未知操作: ${action.ifEmpty { "(空)" }}，支持 run、stop")
            }
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

        /** What to do with a parsed link under [mode]: "run", "ask" or "refuse" (stop is low-risk, so it never asks). */
        fun decide(link: SchemeLink, mode: String): String = when {
            link is Invalid || mode == MODE_OFF || !isMode(mode) -> "refuse"
            link is Stop -> "run"
            mode == MODE_ALLOW -> "run"
            else -> "ask"
        }
    }
}
