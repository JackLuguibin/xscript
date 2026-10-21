package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class TemplatesTest {
    @Test fun sameSetAsVsCode() {
        assertEquals(listOf("empty", "hello", "ascript", "checkin", "findImage", "ocr", "floatUi"), Templates.all.map { it.id })
        for (t in Templates.all) assertTrue(t.id, "__init__.py" in t.files)
    }

    @Test fun names() {
        assertNull(Templates.validateName("my_script"))
        assertNull(Templates.validateName("脚本1"))
        assertNull(Templates.validateName("_x"))
        for (bad in listOf("", "1abc", "a-b", "a b", "../x")) assertTrue(bad, Templates.validateName(bad) != null)
    }

    @Test fun createWritesFilesWithTheName() {
        val ws = Files.createTempDirectory("xs-new-")
        val dir = Templates.create(ws, "demo_1", Templates.all.first { it.id == "floatUi" })
        assertEquals("{\"name\":\"demo_1\",\"version\":\"1.0.0\",\"entry\":\"__init__.py\"}\n", Files.readString(dir.resolve("build.as")))
        assertTrue(Files.readString(dir.resolve("res/ui/main.html")).contains("<h3>Settings</h3>"))
        assertTrue(LocalProject.isProjectDir(dir))
        assertEquals(listOf("__init__.py", "build.as", "res/ui/main.html"), LocalProject.collectFiles(dir).map { it.path })
        assertThrows(IllegalArgumentException::class.java) { Templates.create(ws, "demo_1", Templates.all[0]) }
        assertThrows(IllegalArgumentException::class.java) { Templates.create(ws, "bad-name", Templates.all[0]) }
        ws.toFile().deleteRecursively()
    }
}
