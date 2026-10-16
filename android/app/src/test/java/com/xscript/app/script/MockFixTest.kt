package com.xscript.app.script

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MockFixTest {
    @Test fun parsesAndClampsInterval() {
        val f = MockFix.from(JSONObject().put("lat", 39.9).put("lon", 116.4).put("accuracy", 3.5).put("interval", 10))
        assertEquals(39.9, f.lat, 0.0)
        assertEquals(116.4, f.lon, 0.0)
        assertEquals(3.5f, f.accuracy, 0f)
        assertEquals(MockFix.MIN_INTERVAL, f.intervalMs)
        assertEquals(MockFix.MAX_INTERVAL, MockFix.from(JSONObject().put("lat", 0).put("lon", 0).put("interval", 999_999)).intervalMs)
        assertEquals(1000L, MockFix.from(JSONObject().put("lat", 0).put("lon", 0)).intervalMs)
    }

    @Test fun rejectsOutOfRange() {
        val bad = listOf(
            JSONObject().put("lat", 91).put("lon", 0), JSONObject().put("lat", 0).put("lon", -181),
            JSONObject().put("lon", 0), JSONObject().put("lat", 0).put("lon", 0).put("accuracy", 0),
            JSONObject().put("lat", 0).put("lon", 0).put("interval", 0),
        )
        for (a in bad) assertThrows(a.toString(), IllegalArgumentException::class.java) { MockFix.from(a) }
    }
}
