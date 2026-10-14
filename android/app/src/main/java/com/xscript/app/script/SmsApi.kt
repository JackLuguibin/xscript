package com.xscript.app.script

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import com.xscript.app.XscriptApp
import org.json.JSONArray
import org.json.JSONObject

/** Read-only SMS provider bridge. No message content is logged or sent over the network. */
object SmsApi {
    private val ctx: Context get() = XscriptApp.instance
    private val projection = arrayOf("_id", "thread_id", "address", "body", "date", "date_sent", "type", "read", "subject", "status")

    private fun hasPermission() = ctx.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    fun call(op: String, a: JSONObject): String = when (op) {
        "sms_has_permission" -> hasPermission().toString()
        "sms_debug" -> JSONObject().put("client_available", true)
            .put("permission", hasPermission()).put("read_only", true).toString()
        "sms_query" -> query(a).toString()
        else -> throw IllegalArgumentException("unknown SMS op $op")
    }

    internal data class QueryArguments(
        val selection: String?, val selectionArgs: Array<String>?, val sortOrder: String,
        val limit: Int, val offset: Int,
    )

    internal fun queryArguments(a: JSONObject): QueryArguments {
        val limit = integer(a, "limit")
        val offset = integer(a, "offset").coerceAtLeast(0)
        val type = integer(a, "sms_type")
        val address = if (a.isNull("address")) null else a.get("address").also {
            require(it is String) { "address must be a string" }
        }.toString().takeIf { it.isNotEmpty() }
        val desc = if (!a.has("order_desc")) true else a.get("order_desc").also {
            require(it is Boolean) { "order_desc must be boolean" }
        } as Boolean
        val where = mutableListOf<String>()
        val args = mutableListOf<String>()
        if (type in 1..3) { where += "type = ?"; args += type.toString() }
        // Original AScript uses LIKE without escaping caller wildcard characters.
        if (address != null) { where += "address LIKE ?"; args += "%$address%" }
        return QueryArguments(
            where.takeIf { it.isNotEmpty() }?.joinToString(" AND "),
            args.takeIf { it.isNotEmpty() }?.toTypedArray(),
            if (desc) "date DESC" else "date ASC", limit, offset,
        )
    }

    private fun query(a: JSONObject): JSONArray {
        val result = JSONArray()
        // AScript's proxy returns empty rows when permission is absent or revoked.
        if (!hasPermission()) return result
        try {
            val q = queryArguments(a)
            // Pagination stays in the cursor: never append caller-supplied LIMIT/OFFSET SQL.
            val cursor = ctx.contentResolver.query(
                Uri.parse("content://sms"), projection, q.selection, q.selectionArgs, q.sortOrder,
            ) ?: return result
            cursor.use {
                if (q.offset > 0 && !it.moveToPosition(q.offset - 1)) return result
                while ((q.limit <= 0 || result.length() < q.limit) && it.moveToNext()) {
                    result.put(rowFromCursor(it))
                }
            }
        } catch (_: Exception) {
            // Match the original read API's empty result on provider errors. Do not log SMS data.
            return JSONArray()
        }
        return result
    }

    internal fun rowFromCursor(cursor: Cursor): JSONObject {
        fun number(column: String): Long {
            val index = cursor.getColumnIndex(column)
            return if (index < 0 || cursor.isNull(index)) 0 else cursor.getLong(index)
        }
        fun string(column: String): String {
            val index = cursor.getColumnIndex(column)
            return if (index < 0 || cursor.isNull(index)) "" else cursor.getString(index).orEmpty()
        }
        return JSONObject().put("id", number("_id")).put("thread_id", number("thread_id"))
            .put("address", string("address")).put("body", string("body"))
            .put("date", number("date")).put("date_sent", number("date_sent"))
            .put("type", number("type").toInt()).put("read", number("read") == 1L)
            .put("subject", string("subject")).put("status", number("status").toInt())
    }

    private fun integer(a: JSONObject, key: String): Int {
        if (!a.has(key)) return 0
        val value = a.get(key)
        require(value is Int || value is Long) { "$key must be an integer" }
        val number = (value as Number).toLong()
        require(number in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) { "$key must be a 32-bit integer" }
        return number.toInt()
    }
}
