package com.xscript.app.script

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class EmailDraftTest {
    @Test fun parsesStringListsAndFields() {
        val d = EmailDraft.from(JSONObject().put("to", "a@x.com; b@y.org ,").put("cc", JSONArray(listOf("c@z.io"))).put("subject", "Hi").put("body", "B"))
        assertEquals(listOf("a@x.com", "b@y.org"), d.to)
        assertEquals(listOf("c@z.io"), d.cc)
        assertEquals("Hi", d.subject)
        assertEquals("B", d.body)
    }

    @Test fun emptyDraftIsAllowed() {
        val d = EmailDraft.from(JSONObject().put("to", JSONObject.NULL))
        assertEquals(emptyList<String>(), d.to)
        assertEquals("", d.subject)
    }

    @Test fun rejectsInvalidAddresses() {
        assertThrows(IllegalArgumentException::class.java) { EmailDraft.addresses("not-an-address") }
        assertThrows(IllegalArgumentException::class.java) { EmailDraft.addresses("a b@x.com") }
    }
}
