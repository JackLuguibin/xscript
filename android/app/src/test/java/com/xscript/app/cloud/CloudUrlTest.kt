package com.xscript.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Test

class CloudUrlTest {
    @Test
    fun masksTheTokenValue() {
        assertEquals("wss://h/ws?token=***", CloudUrl.redact("wss://h/ws?token=xsd_abc"))
        assertEquals("ws://h:8765/ws?group=g1&token=***", CloudUrl.redact("ws://h:8765/ws?group=g1&token=xsd_a-b"))
        assertEquals("ws://h/ws?token=***&b=2#frag", CloudUrl.redact("ws://h/ws?token=t%2B%2F&b=2#frag"))
        assertEquals("ws://h/ws?token=***&token=***", CloudUrl.redact("ws://h/ws?token=a&token=b"))
    }

    @Test
    fun leavesOtherUrlsAlone() {
        for (u in listOf("", "ws://h/ws", "ws://h/ws?group=g1", "ws://h/ws?tokens=1&mytoken=2", "ws://h/ws?token=", "ws://h/ws#token=x")) {
            assertEquals(u, CloudUrl.redact(u))
        }
    }
}
