package com.xscript.app.a11y

import org.junit.Assert.assertEquals
import org.junit.Test

class NodeDumperTest {
    @Test
    fun filteredPathsStillIdentifyTheSameWindow() {
        // System window 0 is omitted from the export; application root 1 keeps its path.
        assertEquals(0, NodeDumper.resolveRootIndex(listOf(1, 3), 1))
        assertEquals(1, NodeDumper.resolveRootIndex(listOf(1, 3), 3))
        // nodeAction collects the unfiltered roots again.
        assertEquals(1, NodeDumper.resolveRootIndex(listOf(0, 1, 2, 3), 1))
        assertEquals(3, NodeDumper.resolveRootIndex(listOf(0, 1, 2, 3), 3))
        assertEquals(-1, NodeDumper.resolveRootIndex(listOf(1, 3), 0))
    }

    @Test
    fun legacyRootsUseTheirListPositionAndRejectInvalidPaths() {
        assertEquals(1, NodeDumper.resolveRootIndex(listOf(-1, -1), 1))
        assertEquals(-1, NodeDumper.resolveRootIndex(listOf(-1), 2))
        assertEquals(-1, NodeDumper.resolveRootIndex(emptyList(), 0))
        assertEquals(-1, NodeDumper.resolveRootIndex(listOf(0), -1))
    }
}
