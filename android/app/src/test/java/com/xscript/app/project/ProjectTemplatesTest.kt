package com.xscript.app.project

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ProjectTemplatesTest {
    private val asset = File("src/main/assets/templates/projects.json")

    @Test
    fun bundledTemplatesParseAndHaveChineseLabels() {
        val t = ProjectTemplates(asset.readText())
        assertEquals(listOf("empty", "hello", "ascript", "checkin", "findImage", "ocr", "floatUi"), t.all.map { it.id })
        assertTrue(t.find(ProjectTemplates.DEFAULT) != null)
        for (x in t.all) {
            assertTrue(x.id, x.label.isNotBlank() && x.label.any { it.code > 0x2E80 })
            assertTrue(x.id, x.files.containsKey("__init__.py"))
            assertTrue(x.id, x.files.containsKey("build.as"))
        }
        assertEquals(t.all.size, t.describe().length())
    }

    @Test
    fun renderSubstitutesTheName() {
        val files = ProjectTemplates(asset.readText()).render("empty", "签到")
        assertTrue(files.getValue("build.as").contains("\"name\":\"签到\""))
        assertFalse(files.values.any { it.contains("{{name}}") })
    }

    @Test(expected = IllegalArgumentException::class)
    fun unknownTemplate() {
        ProjectTemplates(asset.readText()).render("nope", "demo")
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsPathsOutsideTheProject() {
        ProjectTemplates("""{"templates":[{"id":"x","label":"x","files":{"__init__.py":"","../evil.py":""}}]}""")
    }
}
