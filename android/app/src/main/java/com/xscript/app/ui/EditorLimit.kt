package com.xscript.app.ui

/**
 * How much of a file the on-device editor takes on. Laying out an EditText is linear in the text: on the emulator a
 * 2 000-line file opens in ~0.3 s, a 20 000-line one (~1.3 MB) in ~2 s, nearly all of it measuring the text. Bigger files
 * open read-only with their first [PREVIEW_LINES] lines; they are edited on the computer (Cursor / VS Code / PyCharm).
 */
object EditorLimit {
    const val MAX_LINES = 3000
    const val MAX_CHARS = 256 * 1024
    const val PREVIEW_LINES = 2000

    fun tooBig(text: String): Boolean = text.length > MAX_CHARS || lines(text) > MAX_LINES

    /** Line count as the editor shows it (a trailing newline does not start another line). */
    fun lines(text: String): Int = if (text.isEmpty()) 1 else text.count { it == '\n' } + if (text.endsWith('\n')) 0 else 1

    /** The first [PREVIEW_LINES] lines, each capped so one huge line cannot defeat the limit. */
    fun preview(text: String): String = text.lineSequence().take(PREVIEW_LINES).joinToString("\n") { if (it.length > 500) it.take(500) + " …" else it }
}
