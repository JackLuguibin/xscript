package com.xscript.pycharm

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException

class DeviceStatusTest {
    private fun json(s: String) = JsonParser.parseString(s).asJsonObject
    /** Fake bundle: "key[arg,arg]" so tests check the key and its arguments without the IDE. */
    private val msg: (String, Array<out Any>) -> String = { k, a -> if (a.isEmpty()) k else "$k[${a.joinToString(",")}]" }

    @Test
    fun `idle and running devices`() {
        val idle = probe { json("""{"running": false, "project": null, "version": "0.4.0"}""") }
        assertTrue(idle is DeviceState.Idle)
        assertEquals("0.4.0", (idle as DeviceState.Idle).version)
        assertEquals("status.idle", statusLabel(idle, msg))
        assertEquals("status.tip.connected[127.0.0.1:9860,0.4.0]", statusTooltip(idle, "127.0.0.1:9860", msg))

        val running = probe { json("""{"running": true, "project": "每日签到", "version": "0.4.0"}""") }
        assertEquals("status.runningProject[每日签到]", statusLabel(running, msg))
        assertEquals("status.running", statusLabel(probe { json("""{"running": true}""") }, msg))
        assertFalse(clickOpensConnect(running))
    }

    @Test
    fun `capture problems show in the label and tooltip, and a click asks the phone`() {
        val lost = probe { json("""{"running": false, "version": "0.4.1", "capture": false, "capture_via": "", "capture_lost": true}""") }
        assertEquals(CaptureProblem.LOST, lost.capture())
        assertEquals("status.idlestatus.capture.lost", statusLabel(lost, msg))
        assertEquals("status.tip.captureLost[127.0.0.1:9860]", statusTooltip(lost, "127.0.0.1:9860", msg))
        assertTrue(clickGrantsCapture(lost))
        assertFalse(clickOpensConnect(lost))

        val running = probe { json("""{"running": true, "project": "demo", "capture_via": "", "capture_lost": false}""") }
        assertEquals("status.runningProject[demo]status.capture.none", statusLabel(running, msg))

        // capture works (another method after a lost grant counts as working), or an older app that does not say
        for (ok in listOf("""{"capture_via": "accessibility", "capture_lost": true}""", """{"capture": true}""", "{}")) {
            val s = probe { json(ok) }
            assertEquals(ok, null, s.capture())
            assertFalse(clickGrantsCapture(s))
        }
        assertEquals(CaptureProblem.NONE, captureProblem(json("""{"capture": false}""")))
        assertEquals(null, DeviceState.Unreachable.capture())
    }

    @Test
    fun `missing fields do not throw`() {
        val s = probe { json("{}") }
        assertTrue(s is DeviceState.Idle)
        assertEquals("?", (s as DeviceState.Idle).version)
    }

    @Test
    fun `pairing, offline and errors`() {
        val pairing = probe { throw DeviceHttpException(401, """{"error":"pairing required"}""") }
        assertTrue(pairing is DeviceState.PairingNeeded)
        assertEquals("status.pairing", statusLabel(pairing, msg))
        assertTrue(clickOpensConnect(pairing))

        val offline = probe { throw ConnectException("refused") }
        assertTrue(offline is DeviceState.Unreachable)
        assertEquals("status.tip.offline[10.0.0.9:9860]", statusTooltip(offline, "10.0.0.9:9860", msg))
        assertTrue(probe { throw IOException("reset") } is DeviceState.Unreachable)
        assertTrue(clickOpensConnect(offline))

        val failed = probe { throw DeviceHttpException(500, "boom") }
        assertTrue(failed is DeviceState.Failed)
        assertEquals("status.error", statusLabel(failed, msg))
        assertTrue(probe { throw IllegalStateException("bad json") } is DeviceState.Failed)
        assertTrue(clickOpensConnect(failed))
    }

    @Test
    fun `unknown before the first check`() {
        assertEquals("status.unknown", statusLabel(DeviceState.Unknown, msg))
        assertFalse(clickOpensConnect(DeviceState.Unknown))
    }

    @Test
    fun `troubleshooting link points at a page in this repo`() {
        val path = TROUBLESHOOTING_URL.substringAfter("/blob/main/")
        assertTrue(TROUBLESHOOTING_URL.startsWith("https://github.com/JackLuguibin/xscript/blob/main/"))
        assertTrue(java.io.File("../../$path").isFile)
    }
}
