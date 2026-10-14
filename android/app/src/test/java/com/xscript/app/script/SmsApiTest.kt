package com.xscript.app.script

import android.database.Cursor
import java.lang.reflect.Proxy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SmsApiTest {
    // A fake Cursor fixture only: these tests never query device messages.
    private fun cursor(values: Map<String, Any?>): Cursor {
        val columns = values.keys.toList()
        return Proxy.newProxyInstance(Cursor::class.java.classLoader, arrayOf(Cursor::class.java)) { _, method, args ->
            when (method.name) {
                "getColumnIndex" -> columns.indexOf(args!![0] as String)
                "isNull" -> values[columns[args!![0] as Int]] == null
                "getLong" -> (values[columns[args!![0] as Int]] as Number).toLong()
                "getString" -> values[columns[args!![0] as Int]] as String?
                else -> throw AssertionError("Unexpected Cursor call ${method.name}")
            }
        } as Cursor
    }

    @Test fun originalRowSchemaAndBooleanRead() {
        val row = SmsApi.rowFromCursor(cursor(linkedMapOf(
            "_id" to 12L, "thread_id" to 3L, "address" to "5551234", "body" to "fixture",
            "date" to 1234L, "date_sent" to 1200L, "type" to 1, "read" to 1,
            "subject" to "subject fixture", "status" to -1,
        )))
        assertEquals(setOf("id", "thread_id", "address", "body", "date", "date_sent", "type", "read", "subject", "status"), row.keys().asSequence().toSet())
        assertEquals(12L, row.getLong("id"))
        assertEquals("subject fixture", row.getString("subject"))
        assertEquals(true, row.get("read"))
        for (flag in listOf(0, 2, -1)) {
            assertEquals(false, SmsApi.rowFromCursor(cursor(mapOf("read" to flag))).get("read"))
        }
    }

    @Test fun missingColumnsAndNullStringsUseDefaults() {
        val row = SmsApi.rowFromCursor(cursor(mapOf("address" to null, "date_sent" to null)))
        for (field in listOf("address", "body", "subject")) assertEquals("", row.get(field))
        for (field in listOf("id", "thread_id", "date", "date_sent", "type", "status")) assertEquals(0L, row.getLong(field))
        assertEquals(false, row.get("read"))
    }

    @Test fun addressIsBoundLikeWithoutWildcardEscaping() {
        val address = "123%_' OR 1=1 --"
        val q = SmsApi.queryArguments(JSONObject().put("sms_type", 1).put("address", address)
            .put("limit", -1).put("offset", -10).put("order_desc", false))
        assertEquals("type = ? AND address LIKE ?", q.selection)
        assertArrayEquals(arrayOf("1", "%$address%"), q.selectionArgs)
        assertEquals("date ASC", q.sortOrder)
        assertEquals(0, q.offset)
        assertEquals(-1, q.limit)
    }

    @Test fun defaultQueryHasNoFiltersOrSecondarySort() {
        val q = SmsApi.queryArguments(JSONObject().put("sms_type", 99).put("address", ""))
        assertNull(q.selection)
        assertNull(q.selectionArgs)
        assertEquals("date DESC", q.sortOrder)
        assertEquals(0, q.limit)
        assertEquals(0, q.offset)
    }
}
