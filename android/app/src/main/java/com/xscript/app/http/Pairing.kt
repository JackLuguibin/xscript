package com.xscript.app.http

import android.content.Context
import com.xscript.app.XscriptApp
import java.security.SecureRandom

/**
 * The developer API pairing code. On by default: every LAN/ADB client must present it. It can be
 * switched off on the device for AScript-style open access (AScript's dev server has no auth).
 */
object Pairing {
    /** No 0/O/1/I/L: the code is read off a phone screen and typed on a computer. */
    const val ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    const val LENGTH = 8

    private val random = SecureRandom()
    private fun prefs() = XscriptApp.instance.getSharedPreferences("xscript_pairing", Context.MODE_PRIVATE)

    /** The current code, created on first use. */
    val code: String
        @Synchronized get() {
            val p = prefs()
            p.getString("code", null)?.takeIf { it.length == LENGTH }?.let { return it }
            val fresh = generate()
            p.edit().putString("code", fresh).commit()
            return fresh
        }

    var required: Boolean
        get() = prefs().getBoolean("required", true)
        set(value) {
            prefs().edit().putBoolean("required", value).apply()
        }

    /** A new code; every client paired with the old one has to pair again. */
    @Synchronized
    fun regenerate(): String {
        val fresh = generate()
        prefs().edit().putString("code", fresh).commit()
        Throttle.reset()
        return fresh
    }

    /** "ABCD-EFGH". */
    fun display(code: String = this.code): String = code.chunked(4).joinToString("-")

    fun generate(): String = buildString { repeat(LENGTH) { append(ALPHABET[random.nextInt(ALPHABET.length)]) } }

    /**
     * Wrong codes per client address: after [MAX_FAILS] in [WINDOW_MS] that address gets 429 until the
     * window passes, so an 8-character code cannot be guessed online.
     */
    object Throttle {
        const val MAX_FAILS = 10
        const val WINDOW_MS = 60_000L
        private val fails = HashMap<String, ArrayDeque<Long>>()

        @Synchronized
        fun blocked(remote: String, now: Long): Boolean {
            val q = fails[remote] ?: return false
            while (q.isNotEmpty() && now - q.first() > WINDOW_MS) q.removeFirst()
            if (q.isEmpty()) fails.remove(remote)
            return q.size >= MAX_FAILS
        }

        @Synchronized
        fun fail(remote: String, now: Long) {
            if (fails.size > 1024) fails.clear()
            fails.getOrPut(remote) { ArrayDeque() }.addLast(now)
        }

        @Synchronized
        fun reset() = fails.clear()
    }
}
