package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorLimitTest {
    @Test
    fun smallFilesAreEditable() {
        assertFalse(EditorLimit.tooBig(""))
        assertFalse(EditorLimit.tooBig("x = 1\n".repeat(EditorLimit.MAX_LINES)))
    }

    @Test
    fun manyLinesOrManyCharsAreReadOnly() {
        assertTrue(EditorLimit.tooBig("x = 1\n".repeat(EditorLimit.MAX_LINES + 1)))
        assertTrue(EditorLimit.tooBig("y".repeat(EditorLimit.MAX_CHARS + 1)))
    }

    @Test
    fun lineCountIgnoresTheTrailingNewline() {
        assertEquals(1, EditorLimit.lines(""))
        assertEquals(2, EditorLimit.lines("a\nb\n"))
        assertEquals(3, EditorLimit.lines("a\nb\nc"))
    }

    @Test
    fun previewKeepsTheFirstLinesAndCapsLongOnes() {
        val p = EditorLimit.preview((1..5000).joinToString("\n") { "line $it" })
        assertEquals(EditorLimit.PREVIEW_LINES, p.lines().size)
        assertTrue(p.startsWith("line 1\nline 2\n"))
        assertEquals("z".repeat(500) + " …", EditorLimit.preview("z".repeat(900)))
    }
}
