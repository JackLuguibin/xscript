package com.xscript.app.http

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingSocketTest {
    @Test
    fun onlyAdbGetsTheCode() {
        assertTrue(PairingSocket.reply(2000, true) { "ABCDEFGH" }.contains("ABCDEFGH"))
        assertTrue(PairingSocket.reply(0, true) { "ABCDEFGH" }.contains("ABCDEFGH"))
        assertFalse("another app", PairingSocket.reply(10123, true) { "ABCDEFGH" }.contains("ABCDEFGH"))
        assertFalse("pairing off: no code", PairingSocket.reply(2000, false) { "ABCDEFGH" }.contains("ABCDEFGH"))
        assertTrue(PairingSocket.reply(2000, false) { "x" }.contains("\"required\":false"))
    }
}
