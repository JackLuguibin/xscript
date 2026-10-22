package com.xscript.pycharm

import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.isDirectory
import kotlin.io.path.name

/** One problem the Web IDE's basic checks report; [line] 1-based, [col] 0-based. */
data class LintProblem(val line: Int, val col: Int, val length: Int, val message: String)

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
     * The Web IDE's hints name its own Ctrl+. quick fixes, which PyCharm does not have:
     * "（是不是 x？Ctrl+. 改正）" -> "（是不是 x？）", "（Ctrl+. 从 m 导入）" -> "（可以从 m 导入）", "（Ctrl+. 删除）" -> "".
     * Same rule as the VS Code extension's plainMessage.
     */
    fun plainMessage(message: String): String = message
        .replace("Ctrl+. 从 ", "可以从 ")
        .replace(Regex("[；;]?\\s*Ctrl\\+\\.[^）)]*"), "")
        .replace(Regex("（\\s*）|\\(\\s*\\)"), "")
        .trim()

    /**
     * The engine's answer: a JSON array of {line, col, length, message, severity}. Only warnings are kept: PyCharm already
     * greys out unused imports / variables and unreachable code with its own inspections.
     */
    fun parse(json: String): List<LintProblem> = JsonParser.parseString(json).asJsonArray.mapNotNull { e ->
        val o = e.asJsonObject
        if (o.get("severity")?.asString != "warning") return@mapNotNull null
        LintProblem(o.get("line").asInt, o.get("col").asInt, maxOf(1, o.get("length")?.asInt ?: 1), plainMessage(o.get("message").asString))
    }
}
