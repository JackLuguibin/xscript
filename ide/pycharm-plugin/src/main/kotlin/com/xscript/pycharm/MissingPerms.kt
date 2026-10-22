package com.xscript.pycharm

import com.google.gson.JsonObject

/** One permission the project's code uses but the phone has not granted: `missing` in the POST /projects/<name>/run reply. */
data class MissingPerm(val label: String, val where: String)

/** Same code the Web IDE uses: opens the phone's accessibility settings (nonblocking); `_result` is "1" when it is already on. */
const val A11Y_CODE = "from xscript.android import permission\n_result = permission.request(permission.ACCESSIBILITY_SERVICE, 1)"

const val A11Y_LABEL = "无障碍"

fun missingPerms(reply: JsonObject?): List<MissingPerm> {
    val arr = reply?.get("missing")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
    return arr.mapNotNull { e ->
        val o = e.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
        fun s(k: String) = o.get(k)?.takeIf { it.isJsonPrimitive }?.asString ?: ""
        MissingPerm(s("label"), s("where")).takeIf { it.label.isNotEmpty() }
    }
}

/** The phone names permissions in Chinese (PermissionNeeds.Kind.label); bundle keys so the English UI shows English names. */
private val LABEL_KEY = mapOf(
    A11Y_LABEL to "missing.label.a11y",
    "图色权限（截图）" to "missing.label.capture",
    "悬浮窗权限" to "missing.label.overlay",
    "通知使用权" to "missing.label.notification",
    "文件访问权限" to "missing.label.files",
)

/** Warning after a run and whether to offer the one-tap accessibility fix; null when nothing is missing. */
fun missingWarning(list: List<MissingPerm>, msg: (String, Array<out Any>) -> String): Pair<String, Boolean>? {
    if (list.isEmpty()) return null
    val names = list.joinToString(msg("missing.sep", emptyArray())) { m ->
        val name = LABEL_KEY[m.label]?.let { msg(it, emptyArray()) } ?: m.label
        if (m.where.isEmpty()) name else msg("missing.item", arrayOf(name, m.where))
    }
    return msg("missing.warn", arrayOf(names)) to list.any { it.label == A11Y_LABEL }
}
