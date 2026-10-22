package com.xscript.app.tools

import org.junit.Assert.assertFalse
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
}
