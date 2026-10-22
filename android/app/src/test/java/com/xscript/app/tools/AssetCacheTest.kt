package com.xscript.app.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetCacheTest {
    @Test
    fun ifNoneMatch() {
        val tag = "\"xs-abc\""
        assertTrue(ToolsRouter.etagMatches(tag, tag))
        assertTrue(ToolsRouter.etagMatches("W/\"xs-abc\"", tag))
        assertTrue(ToolsRouter.etagMatches("\"old\", \"xs-abc\"", tag))
        assertTrue(ToolsRouter.etagMatches("*", tag))
        // another install (or none sent): send the file
        assertFalse(ToolsRouter.etagMatches("\"xs-abd\"", tag))
        assertFalse(ToolsRouter.etagMatches(null, tag))
        assertFalse(ToolsRouter.etagMatches("", tag))
    }

    @Test
    fun comboNames() {
        assertEquals(listOf("common.js", "editor-model.js", "a_b.c.js"), ToolsRouter.comboNames("common.js,editor-model.js,a_b.c.js"))
        for (bad in listOf("", "../x.js", "sub/x.js", ".hidden.js", "a.js,a.js", "tools.css", "a.js,", (1..41).joinToString(",") { "f$it.js" }))
            assertNull(bad, ToolsRouter.comboNames(bad))
    }
}
