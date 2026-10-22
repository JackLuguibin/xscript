package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files

class LintRulesTest {
    @Test
    fun plainMessageDropsTheWebIdeQuickFixHints() {
        assertEquals("未定义的名字 totl（是不是 total？）", LintRules.plainMessage("未定义的名字 totl（是不是 total？Ctrl+. 改正）"))
        assertEquals("未定义的名字 sleep（可以从 time 导入）", LintRules.plainMessage("未定义的名字 sleep（Ctrl+. 从 time 导入）"))
        assertEquals("未定义的名字 x", LintRules.plainMessage("未定义的名字 x（Ctrl+. 选择要导入的模块）"))
        assertEquals("重复定义函数 login，会覆盖第 4 行的函数", LintRules.plainMessage("重复定义函数 login，会覆盖第 4 行的函数（Ctrl+. 跳过去）"))
    }

    @Test
    fun parseKeepsWarningsOnly() {
        val json = """[{"line":3,"col":6,"length":4,"message":"未定义的名字 totl（是不是 total？Ctrl+. 改正）","severity":"warning"},
            {"line":1,"col":7,"length":2,"message":"未使用的 import os（Ctrl+. 删除）","severity":"unused"},
            {"line":9,"col":4,"length":0,"message":"load 是 async 函数，这样调用不会执行，前面要加 await","severity":"warning"}]"""
        assertEquals(
            listOf(LintProblem(3, 6, 4, "未定义的名字 totl（是不是 total？）"), LintProblem(9, 4, 1, "load 是 async 函数，这样调用不会执行，前面要加 await")),
            LintRules.parse(json),
        )
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
