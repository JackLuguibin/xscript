package com.xscript.app.project

import com.xscript.app.project.PermissionNeeds.Kind
import org.junit.Assert.assertEquals
import org.junit.Test

class PermissionNeedsTest {
    private fun kinds(vararg files: Pair<String, String>) = PermissionNeeds.scan(mapOf(*files)).map { it.kind }

    @Test
    fun printsOnlyNeedsNothing() {
        assertEquals(emptyList<Kind>(), kinds("__init__.py" to "print('hi')\nimport time\n"))
    }

    @Test
    fun tapAndFindImage() {
        val src = """
            from xscript.android import action, screen
            w, h = screen.size()
            hit = screen.find_image("res/img/a.png")
            action.click(hit["center_x"], hit["center_y"])
        """.trimIndent()
        val needs = PermissionNeeds.scan(mapOf("__init__.py" to src))
        assertEquals(listOf(Kind.ACCESSIBILITY, Kind.CAPTURE), needs.map { it.kind })
        assertEquals("__init__.py:4", needs[0].where)
        assertEquals("__init__.py:3", needs[1].where)
    }

    @Test
    fun sizeAndCaptureStatusDoNotCapture() {
        assertEquals(emptyList<Kind>(), kinds("a.py" to "screen.size()\nst = screen.capture_status()\n"))
    }

    @Test
    fun commentsAndNonPythonFilesAreIgnored() {
        assertEquals(emptyList<Kind>(), kinds("a.py" to "# action.click(1, 2)\n", "notes.md" to "screen.ocr()"))
    }

    @Test
    fun overlayNotificationsStorageAndAscript() {
        val src = """
            ui.float_show()
            event.on("notification", handler)
            open("/sdcard/Download/out.txt", "w")
            FindColors.find("#ffffff")
            Selector().text("确定").click()
        """.trimIndent()
        assertEquals(
            listOf(Kind.ACCESSIBILITY, Kind.CAPTURE, Kind.OVERLAY, Kind.NOTIFICATIONS, Kind.STORAGE),
            kinds("lib/x.py" to src),
        )
    }

    @Test
    fun entryFileIsReportedFirst() {
        val needs = PermissionNeeds.scan(mapOf("a/util.py" to "action.click(1, 1)", "__init__.py" to "\naction.swipe(1, 1, 2, 2)"))
        assertEquals("__init__.py:2", needs.single().where)
    }
}
