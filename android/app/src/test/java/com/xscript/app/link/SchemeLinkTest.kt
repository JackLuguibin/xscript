package com.xscript.app.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SchemeLinkTest {
    private fun p(url: String?, bundled: String = "", scheme: String = "xscript") = SchemeLink.parse(url, scheme, bundled)
    private fun invalid(l: SchemeLink) = (l as SchemeLink.Invalid).reason

    @Test
    fun runLinks() {
        assertEquals(SchemeLink.Run("demo", "{}"), p("xscript://run?name=demo"))
        assertEquals("scheme and action are case-insensitive", SchemeLink.Run("demo", "{}"), p("XScript://RUN?name=demo"))
        assertEquals("trailing slash", SchemeLink.Run("demo", "{}"), p("xscript://run/?name=demo"))
        assertEquals("unicode name, percent-encoded", SchemeLink.Run("测试", "{}"), p("xscript://run?name=%E6%B5%8B%E8%AF%95"))
        assertEquals("fragment ignored", SchemeLink.Run("demo", "{}"), p("xscript://run?name=demo#x"))
        assertEquals("first duplicate wins", SchemeLink.Run("a", "{}"), p("xscript://run?name=a&name=b"))
        assertEquals(SchemeLink.Run("demo", """{"k":"v w","n":1}"""), p("xscript://run?name=demo&params=%7B%22k%22%3A%22v%20w%22%2C%22n%22%3A1%7D"))
    }

    @Test
    fun badLinksAreInvalid() {
        assertTrue(invalid(p(null)).isNotEmpty())
        assertTrue(invalid(p("")).isNotEmpty())
        assertEquals("不支持的链接", invalid(p("http://run?name=demo")))
        assertEquals("不支持的链接", invalid(p("ascript://run?name=demo")))
        assertEquals("缺少 name 参数", invalid(p("xscript://run")))
        assertEquals("缺少 name 参数", invalid(p("xscript://run?name=")))
        assertTrue(invalid(p("xscript://run?name=../etc")).startsWith("工程名不合法"))
        assertTrue(invalid(p("xscript://run?name=a%2Fb")).startsWith("工程名不合法"))
        assertTrue(invalid(p("xscript://run?name=1abc")).startsWith("工程名不合法"))
        assertTrue(invalid(p("xscript://run?name=%00")).startsWith("工程名不合法"))
        assertEquals("链接参数格式错误", invalid(p("xscript://run?name=%zz")))
        assertTrue(invalid(p("xscript://delete?name=demo")).startsWith("未知操作"))
        assertEquals("bare link means run (AScript)", SchemeLink.Run("demo", "{}"), p("xscript://?name=demo"))
        assertEquals("params 必须是 JSON 对象", invalid(p("xscript://run?name=d&params=not-json")))
        assertEquals("params 必须是 JSON 对象", invalid(p("xscript://run?name=d&params=%5B1%5D")))
        assertTrue(invalid(p("xscript://run?name=d&params=" + "a".repeat(5000))).startsWith("params 过长"))
    }

    @Test
    fun stopLink() {
        assertEquals(SchemeLink.Stop, p("xscript://stop"))
        assertEquals(SchemeLink.Stop, p("xscript://stop?x=1"))
    }

    @Test
    fun packagedAppsOnlyRunTheirBundledProject() {
        val s = "com.acme.app"
        assertEquals(SchemeLink.Run("main", "{}"), p("com.acme.app://run", "main", s))
        assertEquals(SchemeLink.Run("main", "{}"), p("com.acme.app://run?name=main", "main", s))
        assertEquals("此应用只能运行 main", invalid(p("com.acme.app://run?name=other", "main", s)))
        assertEquals("不支持的链接", invalid(p("xscript://run?name=main", "main", s)))
    }

    @Test
    fun securityPolicy() {
        val run = SchemeLink.Run("d", "{}")
        assertEquals("ask", SchemeLink.decide(run, SchemeLink.MODE_CONFIRM))
        assertEquals("run", SchemeLink.decide(run, SchemeLink.MODE_ALLOW))
        assertEquals("refuse", SchemeLink.decide(run, SchemeLink.MODE_OFF))
        assertEquals("unknown mode fails closed", "refuse", SchemeLink.decide(run, "bogus"))
        assertEquals("run", SchemeLink.decide(SchemeLink.Stop, SchemeLink.MODE_CONFIRM))
        assertEquals("refuse", SchemeLink.decide(SchemeLink.Stop, SchemeLink.MODE_OFF))
        assertEquals("refuse", SchemeLink.decide(SchemeLink.Invalid("x"), SchemeLink.MODE_ALLOW))
    }

    private fun m(url: String, bundled: String = "") = SchemeLink.parse(url, SchemeLink.MAIN_SCHEMES, bundled)

    @Test
    fun ascriptAliasesInTheMainApp() {
        assertEquals(SchemeLink.Run("demo", "{}"), m("ascript://run?name=demo"))
        assertEquals("local= is AScript's name=", SchemeLink.Run("我的脚本", "{}"), m("ascript://run?local=%E6%88%91%E7%9A%84%E8%84%9A%E6%9C%AC"))
        assertEquals("name wins over local", SchemeLink.Run("a", "{}"), m("ascript://run?name=a&local=b"))
        assertEquals(SchemeLink.Run("demo", """{"n":1}"""), m("ASCRIPT://run?local=demo&params=%7B%22n%22%3A1%7D"))
        assertEquals(SchemeLink.Stop, m("ascript://stop"))
        assertEquals(SchemeLink.Open("demo"), m("ascript://open?local=demo"))
        assertEquals(SchemeLink.Open("demo"), m("xscript://open?name=demo"))
        assertEquals("缺少 name 参数", invalid(m("ascript://")))
        assertTrue(invalid(m("ascript://run?id=123")).startsWith("不支持按 id"))
        assertTrue(invalid(m("ascript://open?local=../x")).startsWith("工程名不合法"))
        assertEquals("不支持的链接", invalid(m("airscript://run?local=demo")))
        assertEquals("不支持的链接", invalid(m("://run?local=demo")))
    }

    @Test
    fun packagedSchemesFollowAScriptRule() {
        assertEquals(listOf("com.acme.myapp", "myapp"), SchemeLink.packedSchemes("com.Acme.MyApp"))
        assertEquals(listOf("solo"), SchemeLink.packedSchemes("solo"))
        val s = SchemeLink.packedSchemes("com.acme.myapp")
        assertEquals(SchemeLink.Run("main", "{}"), SchemeLink.parse("myapp://run", s, "main"))
        assertEquals("bare short scheme runs itself", SchemeLink.Run("main", "{}"), SchemeLink.parse("myapp://", s, "main"))
        assertEquals("id / local ignored like AScript", SchemeLink.Run("main", "{}"), SchemeLink.parse("com.acme.myapp://run?id=9&local=other", s, "main"))
        assertEquals(SchemeLink.Open("main"), SchemeLink.parse("myapp://open?id=9", s, "main"))
        assertEquals("此应用只能运行 main", invalid(SchemeLink.parse("myapp://run?name=other", s, "main")))
        assertEquals("不支持的链接", invalid(SchemeLink.parse("ascript://run", s, "main")))
    }

    @Test
    fun openNeverAsksButRespectsOff() {
        val open = SchemeLink.Open("d")
        assertEquals("run", SchemeLink.decide(open, SchemeLink.MODE_CONFIRM))
        assertEquals("refuse", SchemeLink.decide(open, SchemeLink.MODE_OFF))
    }
}
