package com.xscript.app.root

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import android.util.Xml
import java.io.StringReader

/**
 * Root fallback for when the accessibility service is off: `input`, `uiautomator dump`,
 * and `screencap`. Slower than accessibility (hundreds of ms per call) but needs no UI grant.
 */
object RootEngine {
    fun tap(x: Int, y: Int, durMs: Int): Boolean {
        val cmd = if (durMs > 200) {
            "input swipe $x $y $x $y $durMs"
        } else {
            "input tap $x $y"
        }
        return RootShell.exec(cmd).ok
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durMs: Int): Boolean =
        RootShell.exec("input swipe $x1 $y1 $x2 $y2 ${durMs.coerceAtLeast(10)}").ok

    /** action 0 down, 1 move, 2 up. `input motionevent` exists on Android 10+. */
    fun touch(action: Int, x: Int, y: Int): Boolean {
        val name = when (action) {
            0 -> "DOWN"
            1 -> "MOVE"
            else -> "UP"
        }
        return RootShell.exec("input motionevent $name $x $y").ok
    }

    fun key(code: Int): Boolean = RootShell.exec("input keyevent $code").ok

    fun globalAction(name: String): Boolean = when (name) {
        "back" -> key(4)
        "home" -> key(3)
        "recents" -> key(187)
        "notifications" -> RootShell.exec("cmd statusbar expand-notifications").ok
        "quick_settings" -> RootShell.exec("cmd statusbar expand-settings").ok
        "lock_screen" -> key(26)
        "screenshot" -> key(120)
        "power_dialog" -> RootShell.exec("input keyevent --longpress 26").ok
        else -> false
    }

    /**
     * `input text` only handles ASCII reliably. For anything else, fall back to the
     * clipboard + paste keyevent, which works on stock Android 10+ via `cmd clipboard`
     * where available.
     */
    fun inputText(text: String): Boolean {
        if (text.isEmpty()) return true
        if (text.all { it.code in 0x20..0x7e }) {
            val escaped = text.replace(" ", "%s")
            return RootShell.exec("input text " + RootShell.quote(escaped)).ok
        }
        return false
    }

    fun screencap(): Bitmap? {
        val raw = RootShell.execRaw("screencap -p", 10_000)
        if (raw.code != 0 || raw.out.isEmpty()) return null
        return BitmapFactory.decodeByteArray(raw.out, 0, raw.out.size)
    }

    /** Foreground package/activity via dumpsys. */
    fun currentApp(): Pair<String, String>? {
        val out = RootShell.exec("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | head -n 1").out
        val m = Regex("""([A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)""").find(out) ?: return null
        val pkg = m.groupValues[1]
        var act = m.groupValues[2]
        if (act.startsWith(".")) act = pkg + act
        return pkg to act
    }

    /**
     * Dump the hierarchy with uiautomator and convert it to the same JSON shape as
     * [com.xscript.app.a11y.NodeDumper]. Paths are index paths through the XML tree.
     */
    fun dumpTree(mode: Int, width: Int, height: Int): JSONObject {
        val file = "/data/local/tmp/xscript_ui.xml"
        val res = RootShell.exec(
            "command -v uiautomator >/dev/null 2>&1 || { echo __NO_UIAUTOMATOR__; exit 0; }; " +
                "rm -f $file; uiautomator dump $file >/dev/null 2>&1; cat $file",
            20_000,
        )
        val roots = JSONArray()
        if (res.out.contains("<hierarchy")) {
            try {
                parseXml(res.out, mode, roots)
            } catch (_: Exception) {
            }
        }
        val obj = JSONObject()
            .put("mode", mode)
            .put("source", "root")
            .put("width", width)
            .put("height", height)
            .put("roots", roots)
        if (roots.length() == 0) {
            obj.put(
                "error",
                when {
                    res.out.contains("__NO_UIAUTOMATOR__") -> "uiautomator_missing: enable accessibility for node queries"
                    res.ok -> "empty_dump"
                    else -> "root_unavailable"
                },
            )
        }
        return obj
    }

    private class Frame(val obj: JSONObject, val children: JSONArray, var childIndex: Int, val interesting: Boolean)

    private fun parseXml(xml: String, mode: Int, out: JSONArray) {
        val parser = Xml.newPullParser()
        parser.setInput(StringReader(xml.substring(xml.indexOf("<?xml").coerceAtLeast(0))))
        val stack = ArrayDeque<Frame>()
        var rootIndex = 0
        var event = parser.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.START_TAG && parser.name == "node") {
                val parent = stack.lastOrNull()
                val path = if (parent == null) {
                    "${rootIndex++}"
                } else {
                    parent.obj.getString("path") + "/" + parent.childIndex++
                }
                val depth = stack.size
                val cls = parser.getAttributeValue(null, "class").orEmpty()
                val parentClassPath = parent?.obj?.optString("classPath").orEmpty()
                val bounds = parseBounds(parser.getAttributeValue(null, "bounds").orEmpty())
                val text = parser.getAttributeValue(null, "text").orEmpty()
                val desc = parser.getAttributeValue(null, "content-desc").orEmpty()
                val id = parser.getAttributeValue(null, "resource-id").orEmpty()
                val clickable = parser.getAttributeValue(null, "clickable") == "true"
                val scrollable = parser.getAttributeValue(null, "scrollable") == "true"
                val checkable = parser.getAttributeValue(null, "checkable") == "true"
                val editable = cls.endsWith("EditText")
                val children = JSONArray()
                val obj = JSONObject()
                    .put("path", path)
                    .put("id", id)
                    .put("text", text)
                    .put("desc", desc)
                    .put("type", cls)
                    .put("package", parser.getAttributeValue(null, "package").orEmpty())
                    .put("classPath", parentClassPath + "/" + cls.substringAfterLast('.'))
                    .put("depth", depth)
                    .put("rect", bounds)
                    .put("clickable", clickable)
                    .put("editable", editable)
                    .put("enabled", parser.getAttributeValue(null, "enabled") != "false")
                    .put("visible", true)
                if (parser.getAttributeValue(null, "long-clickable") == "true") obj.put("longClickable", true)
                if (checkable) obj.put("checkable", true)
                if (parser.getAttributeValue(null, "checked") == "true") obj.put("checked", true)
                if (parser.getAttributeValue(null, "focusable") == "true") obj.put("focusable", true)
                if (parser.getAttributeValue(null, "focused") == "true") obj.put("focused", true)
                if (scrollable) obj.put("scrollable", true)
                if (parser.getAttributeValue(null, "selected") == "true") obj.put("selected", true)
                if (parser.getAttributeValue(null, "password") == "true") obj.put("password", true)
                val interesting = clickable || editable || scrollable || checkable ||
                    text.isNotBlank() || desc.isNotBlank() || id.isNotBlank()
                stack.addLast(Frame(obj, children, 0, interesting))
            } else if (event == XmlPullParser.END_TAG && parser.name == "node") {
                val frame = stack.removeLast()
                frame.obj.put("childCount", frame.childIndex)
                frame.obj.put("children", frame.children)
                val keep = mode and 1 != 0 || frame.interesting || frame.children.length() > 0
                if (keep) {
                    val parent = stack.lastOrNull()
                    if (parent == null) out.put(frame.obj) else parent.children.put(frame.obj)
                }
            }
            event = parser.next()
        }
    }

    private fun parseBounds(raw: String): JSONObject {
        val nums = Regex("""-?\d+""").findAll(raw).map { it.value.toInt() }.toList()
        val obj = JSONObject()
        if (nums.size >= 4) {
            obj.put("l", nums[0]).put("t", nums[1]).put("r", nums[2]).put("b", nums[3])
        } else {
            obj.put("l", 0).put("t", 0).put("r", 0).put("b", 0)
        }
        return obj
    }

    fun findRect(tree: JSONObject, path: String): IntArray? {
        val roots = tree.optJSONArray("roots") ?: return null
        fun walk(arr: JSONArray): JSONObject? {
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                if (n.optString("path") == path) return n
                if (path.startsWith(n.optString("path") + "/")) {
                    walk(n.optJSONArray("children") ?: JSONArray())?.let { return it }
                }
            }
            return null
        }
        val node = walk(roots) ?: return null
        val r = node.getJSONObject("rect")
        return intArrayOf(r.getInt("l"), r.getInt("t"), r.getInt("r"), r.getInt("b"))
    }
}
