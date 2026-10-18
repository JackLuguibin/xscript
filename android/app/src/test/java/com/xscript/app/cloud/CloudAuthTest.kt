package com.xscript.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Test

class CloudAuthTest {
    @Test
    fun movesTokenOutOfTheQuery() {
        assertEquals(CloudAuth.Target("wss://h/ws", "xsd_abc"), CloudAuth.split("wss://h/ws?token=xsd_abc"))
        assertEquals(CloudAuth.Target("ws://h:8765/ws?group=g1", "xsd_a-b"), CloudAuth.split("ws://h:8765/ws?group=g1&token=xsd_a-b"))
        assertEquals(CloudAuth.Target("ws://h/ws?a=1&b=2", "t%2B/"), CloudAuth.split("ws://h/ws?a=1&token=t%252B%2F&b=2"))
    }

    @Test
    fun leavesOtherUrlsAlone() {
        assertEquals(CloudAuth.Target("ws://h/ws", null), CloudAuth.split("ws://h/ws"))
        assertEquals(CloudAuth.Target("ws://h/ws?tokens=1", null), CloudAuth.split("ws://h/ws?tokens=1"))
        assertEquals(CloudAuth.Target("ws://h/ws?token=", null), CloudAuth.split("ws://h/ws?token="))
    }
}
