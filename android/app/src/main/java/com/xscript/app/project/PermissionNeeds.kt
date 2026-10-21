package com.xscript.app.project

/**
 * Which device permissions a project's scripts use, from a scan of its Python sources. Heuristic on purpose:
 * it looks for the API calls that need each permission (`action.click(`, `screen.find_image(`, …), so a
 * project that never taps or reads the screen is not asked for accessibility or screen capture.
 */
object PermissionNeeds {
    enum class Kind(val label: String, val why: String) {
        ACCESSIBILITY("无障碍", "点击、滑动、输入、读取控件"),
        CAPTURE("图色权限（截图）", "找图、找色、文字识别"),
        OVERLAY("悬浮窗权限", "悬浮窗、浮动菜单、网页窗口"),
        NOTIFICATIONS("通知使用权", "监听通知"),
        STORAGE("文件访问权限", "读写 /sdcard 里的文件"),
    }

    /** First place a permission is used: "main.py:12". */
    data class Need(val kind: Kind, val where: String)

    private val patterns: List<Pair<Kind, Regex>> = listOf(
        Kind.ACCESSIBILITY to Regex("""\b(action|node|tree|xpath)\.\w+\s*\(|\b(Selector|Node|XPath)\s*\("""),
        // screen.size()/capture_status() do not capture; everything else under screen. does
        Kind.CAPTURE to Regex("""\bscreen\.(?!size\b|capture_status\b|width\b|height\b|orientation\b)\w+\s*\(|\b(FindImages|FindColors|CompareColors|Colors|Ocr|OcrX)\.\w+\s*\("""),
        Kind.OVERLAY to Regex("""\bui\.(float_\w+|Window)\s*\(|\bWindow\s*\(\s*["'<]|\bFloatWindow\b"""),
        Kind.NOTIFICATIONS to Regex("""\bevent\.(on|wait)\s*\(\s*["']notification["']"""),
        Kind.STORAGE to Regex("""["'](/sdcard|/storage/emulated)/|\bR\.sd\s*\("""),
    )

    /** [sources]: relative path → file text. Only `.py` files are scanned; comments are skipped. */
    fun scan(sources: Map<String, String>): List<Need> {
        val found = LinkedHashMap<Kind, String>()
        for ((path, text) in sources.toSortedMap(compareBy({ if (it == "__init__.py" || it == "main.py") 0 else 1 }, { it }))) {
            if (!path.endsWith(".py")) continue
            text.lineSequence().forEachIndexed { i, raw ->
                val line = raw.substringBefore('#')
                if (line.isBlank()) return@forEachIndexed
                for ((kind, re) in patterns) {
                    if (kind !in found && re.containsMatchIn(line)) found[kind] = "$path:${i + 1}"
                }
            }
        }
        return Kind.values().mapNotNull { k -> found[k]?.let { Need(k, it) } }
    }
}
