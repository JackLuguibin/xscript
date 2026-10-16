package com.xscript.app.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeIdsTest {
    private val ours = "com.xscript.app/.ime.XscriptIme"

    @Test fun parsesEnabledList() {
        val s = "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME;1234;5678:com.xscript.app/com.xscript.app.ime.XscriptIme"
        assertEquals(listOf("com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME", "com.xscript.app/com.xscript.app.ime.XscriptIme"), ImeIds.enabled(s))
        assertTrue(ImeIds.isEnabled(s, ours))
        assertFalse(ImeIds.isEnabled("a/.B", ours))
        assertFalse(ImeIds.isEnabled(null, ours))
        assertEquals(emptyList<String>(), ImeIds.enabled(""))
    }

    @Test fun shortAndLongIdsMatch() {
        assertTrue(ImeIds.same(ours, "com.xscript.app/com.xscript.app.ime.XscriptIme"))
        assertFalse(ImeIds.same(ours, "com.xscript.app/.other.Ime"))
        assertFalse(ImeIds.same(null, ours))
    }

    @Test fun clearAndRootCommands() {
        assertEquals(3 to 2, ImeIds.clearCounts("abc", "de"))
        assertEquals(0 to 0, ImeIds.clearCounts(null, null))
        assertEquals(listOf("ime enable 'x/.Y'", "ime set 'x/.Y'"), ImeIds.rootSwitch("x/.Y") { "'$it'" })
    }
}
