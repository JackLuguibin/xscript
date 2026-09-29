package com.xscript.app.runtime

import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.root.RootEngine
import com.xscript.app.root.RootShell
import com.xscript.app.settings.Settings
import org.json.JSONObject

/**
 * Main-process routing between the accessibility engine and the root fallback, based on
 * the "运行模式" setting. Every entry point used by HTTP and the script binder goes here.
 */
object Automation {
    enum class Channel { ACCESSIBILITY, ROOT, NONE }

    fun channel(): Channel {
        val mode = Settings.runMode
        val a11y = AccessibilityEngine.isOn()
        val root = RootShell.known() == true
        return when (mode) {
            Settings.MODE_ACCESSIBILITY -> if (a11y) Channel.ACCESSIBILITY else Channel.NONE
            Settings.MODE_ROOT -> if (root) Channel.ROOT else Channel.NONE
            else -> when {
                a11y -> Channel.ACCESSIBILITY
                root -> Channel.ROOT
                else -> Channel.NONE
            }
        }
    }

    fun ready(): Boolean = channel() != Channel.NONE

    private fun metrics() = com.xscript.app.XscriptApp.instance.resources.displayMetrics

    /**
     * Node trees come from accessibility whenever the service is on, even in root mode:
     * it is faster, richer and supports node actions. `uiautomator dump` is the fallback
     * (and is missing on some ROMs/emulators, e.g. MuMu).
     */
    private fun nodeChannel(): Channel =
        if (AccessibilityEngine.isOn()) Channel.ACCESSIBILITY else channel()

    fun dumpTree(mode: Int): JSONObject = when (nodeChannel()) {
        Channel.ACCESSIBILITY -> AccessibilityEngine.dump(mode)
        Channel.ROOT -> RootEngine.dumpTree(mode, metrics().widthPixels, metrics().heightPixels)
        Channel.NONE -> JSONObject()
            .put("mode", mode)
            .put("width", metrics().widthPixels)
            .put("height", metrics().heightPixels)
            .put("roots", org.json.JSONArray())
            .put("error", "no_channel")
    }

    fun click(x: Int, y: Int, durMs: Int): Boolean = when (channel()) {
        Channel.ACCESSIBILITY -> AccessibilityEngine.click(x, y, durMs)
        Channel.ROOT -> RootEngine.tap(x, y, durMs)
        Channel.NONE -> false
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durMs: Int): Boolean = when (channel()) {
        Channel.ACCESSIBILITY -> AccessibilityEngine.swipe(x1, y1, x2, y2, durMs)
        Channel.ROOT -> RootEngine.swipe(x1, y1, x2, y2, durMs)
        Channel.NONE -> false
    }

    fun gesture(strokesJson: String): Boolean = when (channel()) {
        Channel.ACCESSIBILITY -> AccessibilityEngine.gesture(strokesJson)
        Channel.ROOT -> rootGesture(strokesJson)
        Channel.NONE -> false
    }

    /** Root has no multi-touch injection without sendevent; replay the first stroke as a swipe. */
    private fun rootGesture(strokesJson: String): Boolean {
        val arr = org.json.JSONArray(strokesJson)
        if (arr.length() == 0) return false
        val s = arr.getJSONObject(0)
        val pts = s.getJSONArray("points")
        if (pts.length() == 0) return false
        val first = pts.getJSONArray(0)
        val last = pts.getJSONArray(pts.length() - 1)
        val dur = s.optInt("duration", 300)
        return if (pts.length() == 1) {
            RootEngine.tap(first.getInt(0), first.getInt(1), dur)
        } else if (pts.length() == 2) {
            RootEngine.swipe(first.getInt(0), first.getInt(1), last.getInt(0), last.getInt(1), dur)
        } else {
            val step = (dur / (pts.length() - 1)).coerceAtLeast(1)
            var ok = RootEngine.touch(0, first.getInt(0), first.getInt(1))
            for (i in 1 until pts.length()) {
                val p = pts.getJSONArray(i)
                Thread.sleep(step.toLong())
                ok = RootEngine.touch(1, p.getInt(0), p.getInt(1)) && ok
            }
            RootEngine.touch(2, last.getInt(0), last.getInt(1)) && ok
        }
    }

    fun touch(action: Int, x: Int, y: Int, durMs: Int): Boolean = when (channel()) {
        Channel.ACCESSIBILITY -> AccessibilityEngine.touch(action, x, y, durMs)
        Channel.ROOT -> RootEngine.touch(action, x, y)
        Channel.NONE -> false
    }

    fun nodeAction(path: String, action: String, arg: String): Boolean = when (nodeChannel()) {
        Channel.ACCESSIBILITY -> AccessibilityEngine.nodeAction(path, action, arg)
        Channel.ROOT -> rootNodeAction(path, action, arg)
        Channel.NONE -> false
    }

    private fun rootNodeAction(path: String, action: String, arg: String): Boolean {
        val m = metrics()
        val tree = RootEngine.dumpTree(1, m.widthPixels, m.heightPixels)
        val r = RootEngine.findRect(tree, path) ?: return false
        val cx = (r[0] + r[2]) / 2
        val cy = (r[1] + r[3]) / 2
        return when (action) {
            "click" -> RootEngine.tap(cx, cy, 20)
            "long_click" -> RootEngine.tap(cx, cy, 700)
            "set_text" -> RootEngine.tap(cx, cy, 20) && RootEngine.inputText(arg)
            "scroll_forward" -> RootEngine.swipe(cx, r[1] + (r[3] - r[1]) * 3 / 4, cx, r[1] + (r[3] - r[1]) / 4, 300)
            "scroll_backward" -> RootEngine.swipe(cx, r[1] + (r[3] - r[1]) / 4, cx, r[1] + (r[3] - r[1]) * 3 / 4, 300)
            else -> false
        }
    }

    fun inputText(text: String): Boolean = when (channel()) {
        Channel.ACCESSIBILITY -> AccessibilityEngine.inputText(text)
        Channel.ROOT -> RootEngine.inputText(text)
        Channel.NONE -> false
    }

    fun globalAction(name: String): Boolean {
        if (name.startsWith("key:")) {
            val code = name.removePrefix("key:").toIntOrNull() ?: return false
            return RootShell.known() == true && RootEngine.key(code)
        }
        return when (channel()) {
            Channel.ACCESSIBILITY -> AccessibilityEngine.globalAction(name) ||
                (RootShell.known() == true && RootEngine.globalAction(name))
            Channel.ROOT -> RootEngine.globalAction(name)
            Channel.NONE -> false
        }
    }

    /** {"packageName": "...", "activity": "..."} for the foreground app. */
    fun currentApp(): JSONObject {
        var pkg = AccessibilityEngine.foregroundPackage
        var act = AccessibilityEngine.foregroundActivity
        if ((pkg.isEmpty() || channel() == Channel.ROOT) && RootShell.known() == true) {
            RootEngine.currentApp()?.let {
                pkg = it.first
                act = it.second
            }
        }
        return JSONObject().put("packageName", pkg).put("activity", act)
    }
}
