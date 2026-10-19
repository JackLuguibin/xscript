package com.xscript.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UiKitTextTest {
    @Test
    fun sameTextComparesPlainText() {
        assertTrue(UiKit.sameText("已授权", "已授权"))
        assertTrue(UiKit.sameText(StringBuilder("3 个"), "3 个"))
        assertTrue(UiKit.sameText(null, null))
        assertFalse(UiKit.sameText("运行", "停止"))
        assertFalse(UiKit.sameText("", null))
        assertFalse(UiKit.sameText("http://10.0.2.17:9860/", "http://10.0.2.18:9860/"))
    }
}
