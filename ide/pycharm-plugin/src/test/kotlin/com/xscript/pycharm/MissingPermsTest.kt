package com.xscript.pycharm

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.MessageFormat
import java.util.Properties

class MissingPermsTest {
    private fun json(s: String) = JsonParser.parseString(s).asJsonObject
    private val fake: (String, Array<out Any>) -> String = { k, a -> if (a.isEmpty()) k else "$k[${a.joinToString(",")}]" }
    private fun bundle(name: String): (String, Array<out Any>) -> String {
        val p = Properties().apply { MissingPermsTest::class.java.getResourceAsStream("/messages/$name")!!.reader(Charsets.UTF_8).use { load(it) } }
        return { k, a -> MessageFormat.format(p.getProperty(k)!!, *a) }
    }

    @Test
    fun `parses the missing list of a run reply`() {
        assertEquals(emptyList<MissingPerm>(), missingPerms(json("""{"ok": true}""")))
        assertEquals(emptyList<MissingPerm>(), missingPerms(null))
        assertEquals(emptyList<MissingPerm>(), missingPerms(json("""{"missing": "x"}""")))
        val list = missingPerms(json("""{"missing": [{"label": "无障碍", "why": "w", "where": "perm.py:3"}, {"label": "悬浮窗权限"}, {"where": "a.py:1"}, 3]}"""))
        assertEquals(listOf(MissingPerm("无障碍", "perm.py:3"), MissingPerm("悬浮窗权限", "")), list)
    }

    @Test
    fun `warning names each permission and offers the accessibility fix first`() {
        assertNull(missingWarning(emptyList(), fake))
        val w = missingWarning(listOf(MissingPerm("悬浮窗权限", ""), MissingPerm("无障碍", "perm.py:3"), MissingPerm("自定义", "")), fake)!!
        assertEquals("missing.warn[missing.label.overlaymissing.sepmissing.item[missing.label.a11y,perm.py:3]missing.sep自定义]", w.text)
        assertTrue(w.a11y)
        assertEquals(PermFix("无障碍", "missing.fix.a11y.button", A11Y_CODE, "missing.fix.a11y.opened", "missing.fix.a11y.on", "missing.fix.a11y.where"), w.fix)
    }

    @Test
    fun `per-permission fix - the first one with a fix, same codes as the Web IDE`() {
        val w = missingWarning(listOf(MissingPerm("自定义", ""), MissingPerm("悬浮窗权限", "a.py:2")), fake)!!
        assertFalse(w.a11y)
        assertEquals("from xscript.android import permission\n_result = permission.request(permission.OVERLAY, 1)", w.fix!!.code)
        assertTrue(permFix("通知使用权", fake)!!.code!!.endsWith("permission.NOTIFICATION_LISTENER, 1)"))
        assertTrue(permFix("文件访问权限", fake)!!.code!!.endsWith("permission.MANAGE_EXTERNAL_STORAGE, 1)"))
        val cap = permFix("图色权限（截图）", fake)!!
        assertTrue(cap.capture)
        assertNull(cap.code)
        assertNull(permFix("自定义", fake))
        assertNull(missingWarning(listOf(MissingPerm("自定义", "")), fake)!!.fix)
    }

    @Test
    fun `both bundles read naturally`() {
        val list = listOf(MissingPerm("无障碍", "perm.py:3"), MissingPerm("悬浮窗权限", ""))
        assertEquals("The phone is missing Accessibility (perm.py:3), Overlay; those calls will fail (the script started). Grant it on the project page in the phone app.",
            missingWarning(list, bundle("XScriptBundle.properties"))!!.text)
        assertEquals("手机上还缺 无障碍（perm.py:3）、悬浮窗权限，相关操作会失败（脚本已启动）。请在手机上的小程序详情页开启。",
            missingWarning(list, bundle("XScriptBundle_zh_CN.properties"))!!.text)
        assertEquals("Open Notification Access on Phone", permFix("通知使用权", bundle("XScriptBundle.properties"))!!.button)
        assertEquals("打开手机通知使用权设置", permFix("通知使用权", bundle("XScriptBundle_zh_CN.properties"))!!.button)
        for (name in listOf("XScriptBundle.properties", "XScriptBundle_zh_CN.properties")) {
            val m = bundle(name)
            for (label in listOf("无障碍", "悬浮窗权限", "通知使用权", "文件访问权限", "图色权限（截图）")) {
                val f = permFix(label, m)!!
                assertTrue("$name $label", listOf(f.button, f.opened, f.on, f.where).all { it.isNotBlank() })
            }
            assertEquals(true, m("missing.failed", arrayOf("timeout", "X")).let { it.contains("timeout") && it.contains("X") })
            assertTrue(m("missing.oldApp", emptyArray()).isNotBlank())
        }
        assertTrue(A11Y_CODE.contains("permission.ACCESSIBILITY_SERVICE"))
        // same table as protocol/permission-fix.json (shared with the Web IDE and VS Code)
        val shared = JsonParser.parseString(java.io.File("../../protocol/permission-fix.json").readText()).asJsonObject.getAsJsonArray("permissions")
        assertEquals(5, shared.size())
        for (e in shared.map { it.asJsonObject }) {
            val label = e.get("label").asString
            for ((lang, name) in listOf("en" to "XScriptBundle.properties", "zh" to "XScriptBundle_zh_CN.properties")) {
                val t = e.getAsJsonObject(lang)
                val f = permFix(label, bundle(name))!!
                assertEquals("$label $lang", listOf("button", "opened", "on", "where").map { t.get(it).asString }, listOf(f.button, f.opened, f.on, f.where))
                assertTrue("$label name $lang", missingWarning(listOf(MissingPerm(label, "")), bundle(name))!!.text.contains(t.get("name").asString))
            }
            val f = permFix(label, fake)!!
            val key = e.get("permission")?.asString
            if (key != null) assertEquals("from xscript.android import permission\n_result = permission.request(permission.$key, 1)", f.code)
            else assertTrue(e.get("captureRequest").asBoolean && f.capture)
        }
    }
}
