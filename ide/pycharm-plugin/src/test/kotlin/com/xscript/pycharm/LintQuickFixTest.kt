package com.xscript.pycharm

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * Applies the Alt+Enter quick fixes in a headless IDE editor (the parts after the checks: offsets from
 * [LintRules.parse] turned into document edits, undo-able, and refused once the document changed).
 */
class LintQuickFixTest : BasePlatformTestCase() {
    private val text = "import os\ntotal = 1\nprint(totl)\nwait()\ntap(540)\n"
    private val json = """{"importLine":2,"problems":[
        {"line":3,"col":6,"length":4,"message":"未定义的名字 totl（是不是 total？Ctrl+. 改正）","severity":"warning","suggest":"total"},
        {"line":4,"col":0,"length":4,"message":"未定义的名字 wait（Ctrl+. 从 util 导入）","severity":"warning","fix":["util"],"name":"wait"},
        {"line":5,"col":0,"length":3,"message":"缺少参数 y（Ctrl+. 补上）","severity":"warning","edit":{"line":5,"col":7,"length":0,"text":", y=...","label":"补上参数 y"}},
        {"line":5,"col":0,"length":3,"message":"重复定义函数 tap（Ctrl+. 跳过去）","severity":"warning","jump":{"line":2,"col":2}}]}"""

    private fun fix(i: Int): LintQuickFix {
        myFixture.configureByText("demo.py", text)
        return LintQuickFix(LintRules.parse(json, text)[i].fixes.first(), myFixture.editor.document.modificationStamp)
    }

    fun testRenameReplacesTheMisspelledName() {
        val f = fix(0)
        assertEquals("改为 total", f.text)
        myFixture.launchAction(f)
        myFixture.checkResult("import os\ntotal = 1\nprint(total)\nwait()\ntap(540)\n")
    }

    fun testImportGoesAfterTheImports() {
        myFixture.launchAction(fix(1))
        myFixture.checkResult("import os\nfrom util import wait\ntotal = 1\nprint(totl)\nwait()\ntap(540)\n")
    }

    fun testMissingArgumentsAreFilledIn() {
        myFixture.launchAction(fix(2))
        myFixture.checkResult("import os\ntotal = 1\nprint(totl)\nwait()\ntap(540, y=...)\n")
    }

    fun testJumpMovesTheCaretWithoutEditing() {
        val f = fix(3)
        myFixture.launchAction(f)
        myFixture.checkResult(text)
        assertEquals(text.indexOf("total") + 2, myFixture.editor.caretModel.offset)
    }

    fun testAFixIsWithdrawnOnceTheDocumentChanged() {
        val f = fix(0)
        WriteCommandAction.runWriteCommandAction(project) { myFixture.editor.document.insertString(0, "# edited\n") }
        assertFalse(f.isAvailable(project, myFixture.editor, myFixture.file))
        assertTrue(myFixture.availableIntentions.none { it.text == "改为 total" })
    }
}
