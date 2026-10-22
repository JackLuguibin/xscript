package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class LintRulesTest {
    @Test
    fun plainMessageDropsTheWebIdeQuickFixHints() {
        assertEquals("未定义的名字 totl（是不是 total？）", LintRules.plainMessage("未定义的名字 totl（是不是 total？Ctrl+. 改正）"))
        assertEquals("未定义的名字 sleep（可以从 time 导入）", LintRules.plainMessage("未定义的名字 sleep（Ctrl+. 从 time 导入）"))
        assertEquals("未定义的名字 x", LintRules.plainMessage("未定义的名字 x（Ctrl+. 选择要导入的模块）"))
        assertEquals("重复定义函数 login，会覆盖第 4 行的函数", LintRules.plainMessage("重复定义函数 login，会覆盖第 4 行的函数（Ctrl+. 跳过去）"))
        assertEquals("未定义的名字 totl（是不是 total？Alt+Enter 改正）", LintRules.plainMessage("未定义的名字 totl（是不是 total？Ctrl+. 改正）", true))
    }

    private fun apply(text: String, fix: LintFix): String {
        var t = text
        for (e in fix.edits.sortedByDescending { it.from }) t = t.substring(0, e.from) + e.text + t.substring(e.to)
        return t
    }

    @Test
    fun parseKeepsWarningsOnlyWithTheirQuickFixes() {
        val text = "import os\ntotal = 1\nprint(totl)\nwait()\ntap(540)\n"
        val json = """{"importLine":2,"problems":[
            {"line":3,"col":6,"length":4,"message":"未定义的名字 totl（是不是 total？Ctrl+. 改正）","severity":"warning","suggest":"total"},
            {"line":1,"col":7,"length":2,"message":"未使用的 import os（Ctrl+. 删除）","severity":"unused"},
            {"line":4,"col":0,"length":4,"message":"未定义的名字 wait（Ctrl+. 选择要导入的模块）","severity":"warning","fix":["a","b"],"name":"wait"},
            {"line":5,"col":0,"length":3,"message":"缺少参数 y（Ctrl+. 补上）","severity":"warning","edit":{"line":5,"col":7,"length":0,"text":", y=...","label":"补上参数 y"}},
            {"line":9,"col":4,"length":4,"message":"重复定义函数 load，会覆盖第 2 行的函数（Ctrl+. 跳过去）","severity":"warning","jump":{"line":2,"col":4}},
            {"line":9,"col":4,"length":0,"message":"load 是 async 函数，这样调用不会执行，前面要加 await","severity":"warning"}]}"""
        val got = LintRules.parse(json, text)
        assertEquals(5, got.size)
        assertEquals("未定义的名字 totl（是不是 total？Alt+Enter 改正）", got[0].message)
        assertEquals("import os\ntotal = 1\nprint(total)\nwait()\ntap(540)\n", apply(text, got[0].fixes.single()))
        assertEquals(listOf("从 a 导入 wait", "从 b 导入 wait"), got[1].fixes.map { it.title })
        assertEquals("import os\nfrom b import wait\ntotal = 1\nprint(totl)\nwait()\ntap(540)\n", apply(text, got[1].fixes[1]))
        assertEquals("补上参数 y", got[2].fixes.single().title)
        assertTrue(apply(text, got[2].fixes.single()).endsWith("tap(540, y=...)\n"))
        assertEquals(LintFix("跳到第 2 行的定义", jumpLine = 2, jumpCol = 4), got[3].fixes.single())
        assertEquals(LintProblem(9, 4, 1, "load 是 async 函数，这样调用不会执行，前面要加 await"), got[4])
    }

    @Test
    fun importFixAppendsANewLineWhenTheFileEndsWithoutOne() {
        val json = """{"importLine":2,"problems":[{"line":1,"col":0,"length":6,"message":"x（Ctrl+. 从 util 导入）","severity":"warning","fix":["util"],"name":"helper"}]}"""
        val fix = LintRules.parse(json, "helper()").single().fixes.single()
        assertEquals("helper()\nfrom util import helper\n", apply("helper()", fix))
    }

    @Test
    fun sourcesReadsPythonFilesSkipsCachesAndPrefersUnsavedText() {
        val root = Files.createTempDirectory("xs-lint-")
        try {
            Files.writeString(root.resolve("__init__.py"), "x = 1\n")
            Files.createDirectories(root.resolve("pkg"))
            Files.writeString(root.resolve("pkg/a.py"), "y = 2\n")
            Files.writeString(root.resolve("pkg/notes.txt"), "z")
            for (d in listOf("__pycache__", ".venv")) {
                Files.createDirectories(root.resolve(d))
                Files.writeString(root.resolve("$d/b.py"), "w = 3\n")
            }
            val got = LintRules.sources(root, mapOf(root.resolve("__init__.py").toAbsolutePath().normalize() to "x = 9\n"))
            assertEquals(listOf("__init__.py" to "x = 9\n", "pkg/a.py" to "y = 2\n"), got.sortedBy { it.first })
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun theWebIdeChecksShipInThePlugin() {
        for (name in listOf("editor-parse.js", "editor-symbols.js", "editor-docs.js")) {
            val text = javaClass.getResourceAsStream("/webide/$name")?.use { String(it.readAllBytes()) }
            assert(text != null && text.length > 1000) { "missing /webide/$name" }
        }
    }
}
