package com.xscript.app.script

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RecordFormatTest {
    @Test fun extensionsMapToFormats() {
        assertEquals(RecordFormat.AAC_M4A, RecordFormat.forPath("/sdcard/a.m4a"))
        assertEquals(RecordFormat.AAC_M4A, RecordFormat.forPath("/sdcard/A.MP4"))
        assertEquals(RecordFormat.AAC_M4A, RecordFormat.forPath("x.aac"))
        assertEquals(RecordFormat.AMR_NB, RecordFormat.forPath("/d/v.amr"))
        assertEquals(RecordFormat.AMR_NB, RecordFormat.forPath("/d/v.3gp"))
        assertEquals(RecordFormat.OGG_OPUS, RecordFormat.forPath("/d/v.ogg"))
    }

    @Test fun unsupportedOrMissingExtension() {
        assertNull(RecordFormat.forPath("/sdcard/a.mp3"))
        assertNull(RecordFormat.forPath("/sdcard/a.wav"))
        assertNull(RecordFormat.forPath("/sdcard/noext"))
        assertNull(RecordFormat.forPath("/sdcard/dir.m4a/noext"))
    }
}
