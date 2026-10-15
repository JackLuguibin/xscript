package com.xscript.app.pack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppOpsModelTest {
    private val server = "http://10.0.2.2:8800"

    @Test
    fun noticesAreParsedAndCapped() {
        val items = (1..8).joinToString(",") { """{"id":$it,"title":"t$it","body":"b","level":"urgent"}""" }
        val list = AppOpsModel.parseNotices("""{"items":[$items,{"id":99,"title":" "}]}""")
        assertEquals(5, list.size)
        assertEquals("t1", list[0].title)
        assertEquals("urgent", list[0].level)
    }

    @Test
    fun unknownLevelFallsBackToInfoAndEmptyTitleIsDropped() {
        val list = AppOpsModel.parseNotices("""{"items":[{"id":1,"title":"x","level":"weird"},{"id":2,"title":""}]}""")
        assertEquals(1, list.size)
        assertEquals("info", list[0].level)
        assertTrue(AppOpsModel.parseNotices("{}").isEmpty())
    }

    @Test
    fun updateRoundTrips() {
        val u = AppOpsModel.parseUpdate(
            """{"update":true,"force":true,"latest_version_code":3,"latest_version_name":"1.2","min_version_code":2,
               "url":"/pub/app-update/apk?app=a.b","sha256":"ABC","size":10,"notes":"n"}""",
        )
        val back = AppOpsModel.parseUpdate(u.toJson())
        assertEquals(3, back.latestCode)
        assertEquals("abc", back.sha256)
        assertTrue(back.force)
    }

    private fun upd(min: Int, latest: Int = 3, url: String = "/pub/app-update/apk?app=a") = AppOpsModel.Update(
        true, min > 0, latest, "v", min, url, "", 0, "",
    )

    @Test
    fun forcedOnlyBelowMinimumAndWithADownload() {
        assertTrue(AppOpsModel.mustUpdate(upd(2), 1, server))
        assertFalse(AppOpsModel.mustUpdate(upd(2), 2, server)) // at the minimum
        assertFalse(AppOpsModel.mustUpdate(upd(2), 5, server)) // above, whatever was cached
        assertFalse(AppOpsModel.mustUpdate(upd(0), 1, server)) // nobody is forced
        assertFalse(AppOpsModel.mustUpdate(null, 1, server))
    }

    @Test
    fun neverLockedOutWithoutADownloadAddress() {
        assertFalse(AppOpsModel.mustUpdate(upd(2, url = ""), 1, server))
        assertFalse(AppOpsModel.mustUpdate(upd(2, url = "ftp://x/y.apk"), 1, server))
        assertFalse(AppOpsModel.mustUpdate(upd(2), 1, "")) // relative URL but no server to resolve it
    }

    @Test
    fun offerNeedsANewerVersion() {
        assertTrue(AppOpsModel.offerUpdate(upd(0, latest = 3), 2, server))
        assertFalse(AppOpsModel.offerUpdate(upd(0, latest = 3), 3, server))
    }

    @Test
    fun urlResolution() {
        assertEquals("http://10.0.2.2:8800/pub/app-update/apk?app=a", AppOpsModel.resolveUrl("http://10.0.2.2:8800/", "/pub/app-update/apk?app=a"))
        assertEquals("https://x.com/a.apk", AppOpsModel.resolveUrl(server, "https://x.com/a.apk"))
        assertNull(AppOpsModel.resolveUrl(server, "//evil.com/a.apk"))
        assertNull(AppOpsModel.resolveUrl(server, "javascript:alert(1)"))
        assertNull(AppOpsModel.resolveUrl(server, ""))
        assertTrue(AppOpsModel.inAppDownload(server, "$server/pub/app-update/apk?app=a"))
        assertFalse(AppOpsModel.inAppDownload(server, "https://x.com/a.apk"))
    }
}
