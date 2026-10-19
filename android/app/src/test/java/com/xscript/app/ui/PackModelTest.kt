package com.xscript.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PackModelTest {
    private fun card(running: Boolean = false, gate: String? = null, mustUpdate: Boolean = false, license: Boolean = false, a11y: Boolean = false) =
        PackModel.runCard(running, gate, mustUpdate, license, a11y)

    @Test
    fun runningOffersStopEvenWhenBlocked() {
        val c = card(running = true, gate = "卡密已过期", license = true, a11y = true)
        assertEquals("停止", c.action)
        assertEquals(UiKit.Tone.DANGER, c.tone)
        assertTrue(c.running)
        assertFalse(c.warn)
    }

    @Test
    fun forcedUpdateComesBeforeLicense() {
        val c = card(gate = "版本过低", mustUpdate = true, license = true)
        assertEquals("更新", c.action)
        assertEquals("版本过低", c.status)
        assertTrue(c.warn)
    }

    @Test
    fun licenseBlockOffersActivation() {
        val c = card(gate = "未激活", license = true)
        assertEquals("激活", c.action)
        assertEquals("未激活", c.status)
        assertEquals(UiKit.Tone.PRIMARY, c.tone)
        assertTrue(c.warn)
    }

    @Test
    fun otherGateShowsReasonButKeepsStart() {
        val c = card(gate = "应用已停用")
        assertEquals("启动", c.action)
        assertEquals("应用已停用", c.status)
        assertTrue(c.warn)
    }

    @Test
    fun accessibilityHintThenReady() {
        assertEquals("请先开启下方的无障碍服务", card(a11y = true).status)
        assertTrue(card(a11y = true).warn)
        val ready = card()
        assertEquals("准备就绪", ready.title)
        assertEquals("启动", ready.action)
        assertEquals(UiKit.Tone.SUCCESS, ready.tone)
        assertFalse(ready.warn)
    }

    @Test
    fun licenseValue() {
        assertEquals(Pair("有效至 永久", true), PackModel.licenseValue(true, "永久", -1, null))
        assertEquals(Pair("有效至 2027-01-01 00:00，剩余 3 次", true), PackModel.licenseValue(true, "2027-01-01 00:00", 3, null))
        assertEquals(Pair("未激活", false), PackModel.licenseValue(false, "", -1, null))
        assertEquals(Pair("卡密已过期", false), PackModel.licenseValue(false, "", -1, "卡密已过期"))
    }
}
