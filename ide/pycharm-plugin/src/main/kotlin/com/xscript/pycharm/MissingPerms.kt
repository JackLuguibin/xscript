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

/** The phone names permissions in Chinese (PermissionNeeds.Kind.label); bundle ids so the English UI shows English names. */
private val LABEL_ID = mapOf(
    A11Y_LABEL to "a11y",
    "图色权限（截图）" to "capture",
    "悬浮窗权限" to "overlay",
    "通知使用权" to "notification",
    "文件访问权限" to "files",
)

private fun request(key: String) = "from xscript.android import permission\n_result = permission.request(permission.$key, 1)"

/** `/eval` code that opens the phone's settings page for each permission; screen capture has none (it asks the phone instead). */
private val FIX_CODE = mapOf(
    "a11y" to A11Y_CODE,
    "overlay" to request("OVERLAY"),
    "notification" to request("NOTIFICATION_LISTENER"),
    "files" to request("MANAGE_EXTERNAL_STORAGE"),
)

/**
 * One-tap fix for a missing permission (same table as the Web IDE's): [code] runs through /eval and opens the phone's
 * settings page (`_result` "1": already granted), or, when null, the phone is asked for the screen-capture grant.
 */
data class PermFix(val label: String, val button: String, val code: String?, val opened: String, val on: String, val where: String) {
    val capture get() = code == null
}

fun permFix(label: String, msg: (String, Array<out Any>) -> String): PermFix? {
    val id = LABEL_ID[label] ?: return null
    fun m(k: String) = msg("missing.fix.$id.$k", emptyArray())
    return PermFix(label, m("button"), FIX_CODE[id], m("opened"), m("on"), m("where"))
}

data class MissingWarning(val text: String, val a11y: Boolean, val fix: PermFix?, val fixes: List<PermFix> = listOfNotNull(fix))

/** Warning after a run and the fix to offer (accessibility first, else the first one that has a fix); null when nothing is missing. */
fun missingWarning(list: List<MissingPerm>, msg: (String, Array<out Any>) -> String): MissingWarning? {
    if (list.isEmpty()) return null
    val names = list.joinToString(msg("missing.sep", emptyArray())) { m ->
        val name = LABEL_ID[m.label]?.let { msg("missing.label.$it", emptyArray()) } ?: m.label
        if (m.where.isEmpty()) name else msg("missing.item", arrayOf(name, m.where))
    }
    val a11y = list.any { it.label == A11Y_LABEL }
    // every missing permission with a fix, accessibility first, no repeats: offered one after another (Next)
    val labels = ((if (a11y) listOf(A11Y_LABEL) else emptyList()) + list.map { it.label }).distinct().filter { it in LABEL_ID }
    val fixes = labels.map { permFix(it, msg)!! }
    return MissingWarning(msg("missing.warn", arrayOf(names)), a11y, fixes.firstOrNull(), fixes)
}

/** After one fix: its result plus how many are left and the Next button; after the last one, the Run Again button. */
fun fixDone(text: String, rest: List<PermFix>, msg: (String, Array<out Any>) -> String): Pair<String, String> =
    if (rest.isEmpty()) msg("missing.again", arrayOf<Any>(text)) to msg("missing.againButton", arrayOf<Any>())
    else msg("missing.left", arrayOf<Any>(text, rest.size)) to msg("missing.next", arrayOf(rest[0].button))
