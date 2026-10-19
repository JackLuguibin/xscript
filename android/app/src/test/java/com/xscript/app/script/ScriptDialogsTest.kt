package com.xscript.app.script

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the script dialog API: python-runtime xscript/android/ui.py reads exactly these answers
 * (alert -> True, confirm -> value, prompt -> value or None, select -> index or None).
 */
class ScriptDialogsTest {
    private fun json(o: JSONObject) = o.toString()

    @Test
    fun answers() {
        assertEquals("""{"ok":true}""", json(ScriptDialogs.alerted()))
        assertEquals("""{"ok":true,"value":true}""", json(ScriptDialogs.confirmed(true)))
        assertEquals("""{"ok":true,"value":false}""", json(ScriptDialogs.confirmed(false)))
        assertEquals("""{"ok":true,"value":"xscript"}""", json(ScriptDialogs.prompted("xscript")))
        assertEquals("""{"ok":true,"value":""}""", json(ScriptDialogs.prompted("")))
        assertEquals("""{"ok":true,"value":1}""", json(ScriptDialogs.selected(1)))
        assertEquals("""{"ok":false}""", json(ScriptDialogs.cancelled()))
        assertEquals("""{"ok":false,"error":"overlay_permission"}""", json(ScriptDialogs.noPermission()))
        assertEquals("""{"ok":false,"error":"boom"}""", json(ScriptDialogs.failed("boom")))
    }

    @Test
    fun defaults() {
        val s = ScriptDialogs.parse("confirm", JSONObject().put("msg", "继续？"))
        assertNull(s.title)
        assertEquals("继续？", s.msg)
        assertEquals("确认", s.submit)
        assertEquals("取消", s.cancel)
        assertEquals("", s.value)
        assertEquals("", s.hint)
        assertTrue(s.items.isEmpty())
    }

    @Test
    fun scriptValuesArePassedThrough() {
        val a = JSONObject().put("msg", "名字").put("title", "设置").put("submit", "好").put("cancel", "算了")
            .put("value", "x").put("hint", "h").put("items", JSONArray(listOf("a", "b")))
        val s = ScriptDialogs.parse("prompt", a)
        assertEquals("设置", s.title)
        assertEquals("好", s.submit)
        assertEquals("算了", s.cancel)
        assertEquals("x", s.value)
        assertEquals("h", s.hint)
        assertEquals(listOf("a", "b"), s.items)
        // An empty title (ui.py sends "" for None) means no title.
        assertNull(ScriptDialogs.parse("alert", JSONObject().put("title", "").put("msg", "m")).title)
    }

    @Test
    fun selectUsesItsMessageAsTitleWhenUntitled() {
        assertEquals("请选择", ScriptDialogs.parse("select", JSONObject().put("msg", "请选择")).title)
        assertEquals("标题", ScriptDialogs.parse("select", JSONObject().put("msg", "请选择").put("title", "标题")).title)
        assertNull(ScriptDialogs.parse("confirm", JSONObject().put("msg", "m")).title)
    }

    @Test
    fun scriptUiKeepsItsOpsAndWidgets() {
        val module = generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory }
        val src = File(module, "src/main/java/com/xscript/app/script/ScriptUi.kt").readText()
        val ops = Regex("""^\s+"([a-z_]+)" ->""", RegexOption.MULTILINE).findAll(src.substringAfter("fun call(").substringBefore("else ->"))
            .map { it.groupValues[1] }.toList()
        assertEquals(
            listOf("can_overlay", "toast", "alert", "confirm", "prompt", "select", "win_create", "win_show", "win_close",
                "win_js", "win_update", "win_nav", "canvas_show", "canvas_draw", "canvas_remove", "canvas_clear",
                "canvas_close", "image_show"),
            ops,
        )
        // prompt still edits a plain EditText; the dialog shows over other apps.
        assertTrue(src.contains("val et = EditText(themed)"))
        assertTrue(src.contains("d.window?.setType(overlayType())"))
        assertTrue(src.contains("ContextThemeWrapper(ctx, R.style.Theme_Xscript)"))
        assertFalse(src.contains("Theme_DeviceDefault_Light_Dialog_Alert"))
        // Script colors on windows and the canvas are still parsed from the script's arguments.
        assertTrue(src.contains("parseColor(a.optString(\"background\")"))
    }
}
