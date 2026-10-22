package com.xscript.pycharm

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.isDirectory
import kotlin.io.path.name

/** One problem the Web IDE's basic checks report; [line] 1-based, [col] 0-based. */
data class LintProblem(val line: Int, val col: Int, val length: Int, val message: String, val fixes: List<LintFix> = emptyList())

/** Replace characters [from], [to]) of the checked text with [text]. */
data class LintEdit(val from: Int, val to: Int, val text: String)

/** One Alt+Enter quick fix: [edits] to the checked text, or a place to jump to ([jumpLine] 1-based, [jumpCol] 0-based). */
data class LintFix(
    val title: String,
    val edits: List<LintEdit> = emptyList(),
    val jumpLine: Int = 0,
    val jumpCol: Int = 0,
    val preferred: Boolean = false,
)

/**
 * The pure parts of the basic checks (no IDE needed, unit-tested): which files go in, how results come back and how the
 * Web IDE's wording is adapted. The checks themselves run in [LintEngine].
 */
object LintRules {
    const val MAX_FILES = 2000
    const val MAX_BYTES = 400_000L

    /**
     * Every .py file of the project at [root] as (path relative with "/", text), skipping the folders an upload skips.
     * [open] holds unsaved editor text by absolute path and wins over the disk.
     */
    fun sources(root: Path, open: Map<Path, String> = emptyMap()): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        fun walk(dir: Path) {
            val entries = Files.list(dir).use { s -> s.sorted().toList() }
            for (p in entries) {
                if (out.size >= MAX_FILES || p.name.startsWith(".")) continue
                if (p.isDirectory()) {
                    if (p.name !in LocalProject.SKIP_DIRS) walk(p)
                } else if (p.extension == "py") {
                    val text = open[p.toAbsolutePath().normalize()]
                        ?: if (Files.size(p) > MAX_BYTES) continue else Files.readString(p)
                    out.add(root.relativize(p).joinToString("/") to text)
                }
            }
        }
        walk(root)
        return out
    }

    /**
     * The Web IDE's hints name its own Ctrl+. quick fixes. When PyCharm offers the same fix ([hasFix], Alt+Enter), the
     * hint says "Alt+Enter"; otherwise it is dropped (same rule as the VS Code extension's plainMessage):
     * "（Ctrl+. 从 m 导入）" -> "（可以从 m 导入）", "（Ctrl+. 删除）" -> "".
     */
    fun plainMessage(message: String, hasFix: Boolean = false): String = if (hasFix) message.replace("Ctrl+.", "Alt+Enter") else message
        .replace("Ctrl+. 从 ", "可以从 ")
        .replace(Regex("[；;]?\\s*Ctrl\\+\\.[^）)]*"), "")
        .replace(Regex("（\\s*）|\\(\\s*\\)"), "")
        .trim()

    /**
     * The engine's answer for [text]: {importLine, problems: [{line, col, length, message, severity, suggest?, fix?, name?,
     * edit?, jump?}]}. Only warnings are kept: PyCharm already greys out unused imports / variables and unreachable code
     * with its own inspections.
     */
    fun parse(json: String, text: String): List<LintProblem> {
        val root = JsonParser.parseString(json).asJsonObject
        val importLine = root.get("importLine")?.asInt ?: 1
        return root.getAsJsonArray("problems").mapNotNull { e ->
            val o = e.asJsonObject
            if (o.get("severity")?.asString != "warning") return@mapNotNull null
            val fixes = fixes(o, text, importLine)
            LintProblem(o.get("line").asInt, o.get("col").asInt, maxOf(1, o.get("length")?.asInt ?: 1), plainMessage(o.get("message").asString, fixes.isNotEmpty()), fixes)
        }
    }

    /** Offset of (1-based [line], 0-based [col]) in [text], clamped to it. */
    fun offsetOf(text: String, line: Int, col: Int): Int {
        var at = 0
        var n = 1
        while (n < line) {
            val nl = text.indexOf('\n', at)
            if (nl < 0) return text.length
            at = nl + 1
            n++
        }
        return minOf(text.length, at + col)
    }

    private fun str(o: JsonObject, key: String): String? = o.get(key)?.takeIf { it.isJsonPrimitive }?.asString

    /** The Web IDE's Ctrl+. actions for a warning: the check's own edit, the jump, the "是不是 …" rename, the import. */
    private fun fixes(o: JsonObject, text: String, importLine: Int): List<LintFix> {
        o.get("edit")?.takeIf { it.isJsonObject }?.asJsonObject?.let { e ->
            val from = offsetOf(text, e.get("line").asInt, e.get("col").asInt)
            val to = minOf(text.length, from + e.get("length").asInt)
            return listOf(LintFix(e.get("label").asString, listOf(LintEdit(from, to, str(e, "text") ?: "")), preferred = true))
        }
        o.get("jump")?.takeIf { it.isJsonObject }?.asJsonObject?.let { j ->
            val line = j.get("line").asInt
            return listOf(LintFix("跳到第 $line 行的定义", jumpLine = line, jumpCol = j.get("col").asInt))
        }
        str(o, "suggest")?.let { s ->
            val from = offsetOf(text, o.get("line").asInt, o.get("col").asInt)
            return listOf(LintFix("改为 $s", listOf(LintEdit(from, minOf(text.length, from + o.get("length").asInt), s)), preferred = true))
        }
        val name = str(o, "name") ?: return emptyList()
        val modules = o.get("fix")?.takeIf { it.isJsonArray }?.asJsonArray?.map { it.asString }.orEmpty()
        if (modules.isEmpty()) return emptyList()
        val lines = text.split("\n").size
        // past the last line: the file ends without a newline, so start a new line first
        val lead = if (importLine > lines) "\n" else ""
        val at = offsetOf(text, importLine, 0)
        return modules.map { m -> LintFix("从 $m 导入 $name", listOf(LintEdit(at, at, lead + "from $m import $name\n")), preferred = modules.size == 1) }
    }
}
