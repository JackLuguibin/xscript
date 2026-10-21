package com.xscript.pycharm

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.ServerSocket
import java.net.SocketTimeoutException

class ConnectCheckTest {
    private fun json(s: String) = JsonParser.parseString(s).asJsonObject
    private val msg: (String, Array<out Any>) -> String = { k, _ -> k }
    private fun oks(steps: List<CheckStep>) = steps.map { it.ok }
    private val device = """{"model": "Pixel", "version": "0.4.0", "device_id": "d1", "pairing": true, "paired": true}"""

    @Test
    fun `all steps pass for a paired XScript device`() {
        val steps = runConnectCheck("192.168.1.23", connect = {}, status = { json(device) })
        assertEquals(listOf(true, true, true, true, true), oks(steps))
        assertEquals("192.168.1.23:9860", steps[0].detail)
        assertEquals("Pixel 0.4.0", steps[3].detail)
        assertEquals("paired", steps[4].detail)
        assertTrue(canConnect(steps))
        assertTrue(checkHtml(steps, msg).contains("check.allOk"))
    }

    @Test
    fun `a bad address stops at the first step`() {
        val steps = runConnectCheck("host:99999", connect = { error("not called") }, status = { error("not called") })
        assertEquals(listOf(false, null, null, null, null), oks(steps))
        assertFalse(canConnect(steps))
    }

    @Test
    fun `refused and timeout are told apart`() {
        val refused = runConnectCheck("127.0.0.1:1", connect = { throw ConnectException("x") }, status = { error("no") })
        assertEquals(listOf(true, false, null, null, null), oks(refused))
        assertEquals("refused", refused[1].detail)
        val html = checkHtml(refused, msg)
        assertTrue(html.contains("check.fix.reach"))
        assertFalse(html.contains("check.fix.app"))
        assertEquals("timeout", runConnectCheck("10.0.0.9", connect = { throw SocketTimeoutException() }, status = { error("no") })[1].detail)
    }

    @Test
    fun `an open port without the app, or another server, fails later`() {
        assertEquals(listOf(true, true, false, null, null), oks(runConnectCheck("a:1", connect = {}, status = { throw java.io.IOException("reset") })))
        assertEquals(listOf(true, true, true, false, null), oks(runConnectCheck("a:1", connect = {}, status = { json("""{"ok": 1}""") })))
        assertEquals(listOf(true, true, true, false, null), oks(runConnectCheck("a:1", connect = {}, status = { throw DeviceHttpException(404, "") })))
    }

    @Test
    fun `missing pairing code still allows connecting`() {
        val viaJson = runConnectCheck("a", connect = {}, status = { json("""{"model": "P", "pairing": true, "paired": false}""") })
        assertEquals(listOf(true, true, true, true, false), oks(viaJson))
        assertTrue(canConnect(viaJson))
        val via401 = runConnectCheck("a", connect = {}, status = { throw DeviceHttpException(401, "") })
        assertEquals(listOf(true, true, true, true, false), oks(via401))
        assertTrue(checkHtml(via401, msg).contains("check.fix.pairing"))
        assertEquals("off", runConnectCheck("a", connect = {}, status = { json("""{"model": "P"}""") })[4].detail)
    }

    @Test
    fun `real tcp connect to a listening and a closed port`() {
        ServerSocket(0).use { server ->
            tcpConnect(DeviceTarget("127.0.0.1", server.localPort), 1000)
            val port = server.localPort
            server.close()
            val steps = runConnectCheck("127.0.0.1:$port", status = { error("no") })
            assertEquals("refused", steps[1].detail)
        }
    }

    @Test
    fun `every step has a title and a fix in both bundles (generated from protocol connect-check json)`() {
        for (name in listOf("/messages/XScriptBundle.properties", "/messages/XScriptBundle_zh_CN.properties")) {
            val props = java.util.Properties().apply {
                ConnectCheckTest::class.java.getResourceAsStream(name)!!.reader(Charsets.UTF_8).use { load(it) }
            }
            for (id in CheckStepId.entries) {
                assertTrue("$name check.${id.key}", !props.getProperty("check.${id.key}").isNullOrBlank())
                assertTrue("$name check.fix.${id.key}", !props.getProperty("check.fix.${id.key}").isNullOrBlank())
            }
        }
    }

    @Test
    fun `html escapes details`() {
        val html = checkHtml(listOf(CheckStep(CheckStepId.ADDRESS, false, "<b>x</b>")) , msg)
        assertTrue(html.contains("&lt;b&gt;x"))
    }
}
