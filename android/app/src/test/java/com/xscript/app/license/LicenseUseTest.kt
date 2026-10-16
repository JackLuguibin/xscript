package com.xscript.app.license

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LicenseUseTest {
    private fun d(json: String) = LicenseUse.decide(JSONObject(json))

    @Test fun okCountCardReportsUsesLeft() {
        val o = d("""{"status":"ok","revoked":false,"uses_left":4}""")
        assertTrue(o.allow)
        assertEquals(4, o.usesLeft)
        assertEquals("剩余 4 次", LicenseUse.describe(o))
    }

    @Test fun formalAndTrialCardsAreUnlimited() {
        val o = d("""{"status":"ok","revoked":false,"uses_left":-1}""")
        assertTrue(o.allow)
        assertNull(LicenseUse.describe(o))
    }

    @Test fun lastUseStillRuns() {
        assertTrue(d("""{"status":"ok","revoked":false,"uses_left":0}""").allow)
    }

    @Test fun exhaustedBlocksWithMessageButKeepsToken() {
        val o = d("""{"status":"exhausted","revoked":false,"uses_left":0}""")
        assertFalse(o.allow)
        assertEquals("次数已用完", o.block)
        assertFalse(o.dropToken)
    }

    @Test fun expiredBlocks() {
        val o = d("""{"status":"expired","revoked":false,"uses_left":-1}""")
        assertFalse(o.allow)
        assertEquals(LicenseUse.EXPIRED, o.block)
    }

    @Test fun revokedAndUnknownDropTheToken() {
        for (j in listOf("""{"status":"revoked","revoked":true,"uses_left":0}""", """{"status":"unknown","revoked":true,"uses_left":0}""", """{"revoked":true}""")) {
            val o = d(j)
            assertFalse(j, o.allow)
            assertTrue(j, o.dropToken)
        }
    }

    @Test fun unrecognisedReplyIsTreatedAsOffline() {
        for (j in listOf("""{"error":"HTTP 502"}""", """{"detail":"Not Found"}""", """{"status":"weird"}""")) {
            val o = d(j)
            assertTrue(j, o.allow)
            assertTrue(j, o.offline)
        }
    }
}
