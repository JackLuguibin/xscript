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
    fun `warning names each permission and offers the button only for accessibility`() {
        assertNull(missingWarning(emptyList(), fake))
        val (text, a11y) = missingWarning(listOf(MissingPerm("无障碍", "perm.py:3"), MissingPerm("自定义", "")), fake)!!
        assertEquals("missing.warn[missing.item[missing.label.a11y,perm.py:3]missing.sep自定义]", text)
        assertTrue(a11y)
        assertFalse(missingWarning(listOf(MissingPerm("悬浮窗权限", "")), fake)!!.second)
    }

    @Test
    fun `both bundles read naturally`() {
        val list = listOf(MissingPerm("无障碍", "perm.py:3"), MissingPerm("悬浮窗权限", ""))
        assertEquals("The phone is missing Accessibility (perm.py:3), Overlay; those calls will fail (the script started). Grant it on the project page in the phone app.",
            missingWarning(list, bundle("XScriptBundle.properties"))!!.first)
        assertEquals("手机上还缺 无障碍（perm.py:3）、悬浮窗权限，相关操作会失败（脚本已启动）。请在手机上的小程序详情页开启。",
            missingWarning(list, bundle("XScriptBundle_zh_CN.properties"))!!.first)
        for (name in listOf("XScriptBundle.properties", "XScriptBundle_zh_CN.properties")) {
            val m = bundle(name)
            for (k in listOf("missing.open", "missing.opened", "missing.on")) assertTrue(m(k, emptyArray()).isNotBlank())
            assertTrue(m("missing.failed", arrayOf("timeout")).contains("timeout"))
        }
        assertTrue(A11Y_CODE.contains("permission.ACCESSIBILITY_SERVICE"))
    }
}
