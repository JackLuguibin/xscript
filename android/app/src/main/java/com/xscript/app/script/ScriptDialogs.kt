package com.xscript.app.script

import org.json.JSONArray
import org.json.JSONObject

/**
 * The script dialog contract (ui.alert / confirm / prompt / select in python-runtime xscript/android/ui.py and the
 * AScript shim): how the arguments are read and the JSON each answer returns. Kept free of views so the JVM tests
 * pin it; ScriptUi only draws the dialog.
 */
object ScriptDialogs {
    class Spec(
        val title: String?,
        val msg: String,
        val submit: String,
        val cancel: String,
        val value: String,
        val hint: String,
        val items: List<String>,
    )

    fun parse(kind: String, a: JSONObject): Spec {
        val msg = a.optString("msg")
        var title = a.optString("title").takeIf { it.isNotEmpty() }
        // select shows its message as the title when the script gave no title.
        if (kind == "select" && title == null && msg.isNotEmpty()) title = msg
        val arr = a.optJSONArray("items") ?: JSONArray()
        return Spec(
            title = title,
            msg = msg,
            submit = a.optString("submit", "确认"),
            cancel = a.optString("cancel", "取消"),
            value = a.optString("value"),
            hint = a.optString("hint"),
            items = List(arr.length()) { arr.optString(it) },
        )
    }

    fun alerted(): JSONObject = JSONObject().put("ok", true)
    fun confirmed(yes: Boolean): JSONObject = JSONObject().put("ok", true).put("value", yes)
    fun prompted(text: String): JSONObject = JSONObject().put("ok", true).put("value", text)
    fun selected(index: Int): JSONObject = JSONObject().put("ok", true).put("value", index)

    /** Back, outside tap, or the cancel button of prompt / select. */
    fun cancelled(): JSONObject = JSONObject().put("ok", false)
    fun noPermission(): JSONObject = JSONObject().put("ok", false).put("error", "overlay_permission")
    fun failed(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)
}
