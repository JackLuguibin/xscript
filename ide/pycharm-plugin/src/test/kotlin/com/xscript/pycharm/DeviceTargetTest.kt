package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DeviceTargetTest {
    @Test fun defaults() {
        assertEquals(DeviceTarget("127.0.0.1", 9860), DeviceTarget.parse(""))
        assertEquals(DeviceTarget("192.168.1.5", 9860), DeviceTarget.parse(" 192.168.1.5 "))
    }

    @Test fun portsSchemesAndPaths() {
        assertEquals(DeviceTarget("10.0.0.2", 9000), DeviceTarget.parse("10.0.0.2:9000"))
        assertEquals(DeviceTarget("10.0.0.2", 9860), DeviceTarget.parse("http://10.0.0.2:9860/tools/"))
        assertEquals(DeviceTarget("127.0.0.1", 81), DeviceTarget.parse(":81"))
    }

    @Test fun ipv6() {
        assertEquals(DeviceTarget("fe80::1", 9860), DeviceTarget.parse("fe80::1"))
        assertEquals(DeviceTarget("::1", 9001), DeviceTarget.parse("[::1]:9001"))
        assertEquals("http://[::1]:9001", DeviceTarget.parse("[::1]:9001").baseUrl)
        assertEquals("http://10.0.0.2:9860", DeviceTarget.parse("10.0.0.2").baseUrl)
    }

    @Test fun badPorts() {
        for (bad in listOf("h:0", "h:70000", "h:x1", "[::1")) {
            assertThrows(IllegalArgumentException::class.java) { DeviceTarget.parse(bad) }
        }
    }
}
