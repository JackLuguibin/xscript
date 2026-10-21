package com.xscript.app.ui

/** Size cap of the run log screen's text (pure, unit-tested). */
object LogText {
    const val MAX_CHARS = 200_000
    const val KEEP_CHARS = 150_000

    /**
     * How many leading chars to delete so about [keep] remain once [max] is passed: 0 at or below [max]; otherwise up
     * to the start of the first whole line after the cut (or the cut itself when the rest is one long line).
     */
    fun trimLength(text: CharSequence, max: Int = MAX_CHARS, keep: Int = KEEP_CHARS): Int {
        if (text.length <= max) return 0
        val cut = text.length - keep
        for (i in cut - 1 until text.length) if (text[i] == '\n') return i + 1
        return cut
    }
}
