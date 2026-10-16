package com.xscript.app.ime

/** Pure helpers around Settings.Secure input-method strings (JVM-tested). */
object ImeIds {
    /** ENABLED_INPUT_METHODS: "pkg/.Svc;subtype:pkg2/cls" → ["pkg/.Svc", "pkg2/cls"] (subtypes dropped). */
    fun enabled(secure: String?): List<String> =
        secure.orEmpty().split(':').map { it.substringBefore(';').trim() }.filter { it.isNotEmpty() }

    /** Component ids may be written "pkg/.Cls" or "pkg/pkg.Cls"; compare them in the long form. */
    fun normalize(id: String): String {
        val pkg = id.substringBefore('/')
        val cls = id.substringAfter('/', "")
        return if (cls.startsWith(".")) "$pkg/$pkg$cls" else id
    }

    fun same(a: String?, b: String?): Boolean = a != null && b != null && normalize(a) == normalize(b)

    fun isEnabled(secure: String?, id: String): Boolean = enabled(secure).any { same(it, id) }

    /** Number of characters to delete so the field becomes empty, given the text before/after the cursor. */
    fun clearCounts(before: CharSequence?, after: CharSequence?): Pair<Int, Int> = (before?.length ?: 0) to (after?.length ?: 0)

    /** Root shell commands that make [id] the current IME (enable first; `ime set` alone fails for disabled IMEs). */
    fun rootSwitch(id: String, quote: (String) -> String): List<String> = listOf("ime enable " + quote(id), "ime set " + quote(id))
}
