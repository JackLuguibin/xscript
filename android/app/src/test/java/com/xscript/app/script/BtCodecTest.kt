package com.xscript.app.script

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BtCodecTest {
    @Test fun addresses() {
        assertEquals("AA:BB:CC:DD:EE:0F", BtCodec.address(" aa-bb-cc-dd-ee-0f "))
        for (bad in listOf("AA:BB:CC:DD:EE", "GG:BB:CC:DD:EE:FF", "", "AABBCCDDEEFF")) {
            assertThrows(bad, IllegalArgumentException::class.java) { BtCodec.address(bad) }
        }
    }

    @Test fun uuids() {
        assertEquals(BtCodec.SPP, BtCodec.uuid(null))
        assertEquals(BtCodec.SPP, BtCodec.uuid(""))
        assertEquals("0000180d-0000-1000-8000-00805f9b34fb", BtCodec.uuid("180D").toString())
        assertEquals("00002a37-0000-1000-8000-00805f9b34fb", BtCodec.uuid("0x2a37").toString())
        assertEquals("12345678-0000-1000-8000-00805f9b34fb", BtCodec.uuid("12345678").toString())
        assertEquals("6e400001-b5a3-f393-e0a9-e50e24dcca9e", BtCodec.uuid("6E400001-B5A3-F393-E0A9-E50E24DCCA9E").toString())
        assertThrows(IllegalArgumentException::class.java) { BtCodec.uuid("xyz") }
    }

    @Test fun payloads() {
        val b = byteArrayOf(0, 1, -1, 65)
        assertArrayEquals(b, BtCodec.decode(BtCodec.encode(b)))
        assertThrows(IllegalArgumentException::class.java) { BtCodec.decode("!!") }
    }
}
