package com.xscript.app.script

import org.json.JSONArray
import org.json.JSONObject

/** Arguments of `media.send_email`, parsed without android.* so the JVM tests cover them. */
internal data class EmailDraft(val to: List<String>, val cc: List<String>, val subject: String, val body: String) {
    companion object {
        private val ADDRESS = Regex("^[^\\s@,;<>]+@[^\\s@,;<>]+$")

        fun from(a: JSONObject): EmailDraft =
            EmailDraft(addresses(a.opt("to")), addresses(a.opt("cc")), a.optString("subject", ""), a.optString("body", ""))

        /** "a@x.com, b@y.com" / ["a@x.com"] / null; invalid entries are rejected rather than silently dropped. */
        fun addresses(v: Any?): List<String> {
            val raw = when (v) {
                null, JSONObject.NULL -> emptyList()
                is JSONArray -> (0 until v.length()).map { v.get(it).toString() }
                else -> v.toString().split(',', ';')
            }
            return raw.map { it.trim() }.filter { it.isNotEmpty() }.onEach {
                require(ADDRESS.matches(it)) { "invalid email address: $it" }
            }
        }
    }
}
