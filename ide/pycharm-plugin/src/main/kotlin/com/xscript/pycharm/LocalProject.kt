package com.xscript.pycharm

import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.name

/** Finding and reading a local XScript project: the same rules as the VS Code extension's project.ts / sync.ts. */
object LocalProject {
    /** Same list as ide/mcp-server/xscript_mcp/client.py zip_directory. */
    val SKIP_DIRS = setOf("__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".venv", "venv", ".idea", ".vscode", "node_modules")
    private val TEXT_EXT = setOf("py", "txt", "json", "md", "html", "js", "css", "yaml", "yml", "ini", "cfg", "csv", "xml")
    /** Where AScript's VS Code extension keeps the sync rules; shared so both IDEs honour one file. */
    const val SYNCIGNORE = ".vscode/.syncignore"

    /** A project is a directory with an entry __init__.py, or with AScript's build.as. */
    fun isProjectDir(dir: Path) = dir.resolve("__init__.py").exists() || dir.resolve("build.as").exists()

    /** Topmost directory with a project marker, walking up from `start` without leaving `boundary`. */
    fun findRoot(start: Path, boundary: Path? = null): Path? {
        var dir: Path? = (if (start.isDirectory()) start else start.parent)?.toAbsolutePath()?.normalize()
        val stop = boundary?.toAbsolutePath()?.normalize()
        var found: Path? = null
        while (dir != null) {
            if (isProjectDir(dir)) found = dir else if (found != null) break
            if (dir == stop) break
            dir = dir.parent
        }
        return found
    }

    fun loadIgnore(root: Path): IgnoreRules =
        try { IgnoreRules(Files.readString(root.resolve(SYNCIGNORE))) } catch (_: Exception) { IgnoreRules("") }

    /**
     * Whether a device path is one an upload manages, i.e. collectFiles would pick it up if it existed here:
     * no dot names, no skipped folders, no .pyc/.pyo, not matched by .syncignore (nor any of its folders).
     */
    fun isSyncedPath(rel: String, ignore: IgnoreRules): Boolean {
        val segs = rel.split("/")
        if (segs.any { it.isEmpty() || it.startsWith(".") }) return false
        for (i in 0 until segs.size - 1) {
            if (segs[i] in SKIP_DIRS || ignore.ignores(segs.subList(0, i + 1).joinToString("/"), true)) return false
        }
        val name = segs.last()
        return !(name.endsWith(".pyc") || name.endsWith(".pyo")) && !ignore.ignores(rel, false)
    }

    fun collectFiles(root: Path, ignore: IgnoreRules = loadIgnore(root)): List<UploadFile> {
        val out = mutableListOf<UploadFile>()
        fun walk(dir: Path) {
            Files.newDirectoryStream(dir).use { ds ->
                for (p in ds) {
                    val name = p.name
                    if (name.startsWith(".")) continue
                    val rel = root.relativize(p).joinToString("/")
                    if (Files.isDirectory(p)) {
                        if (name !in SKIP_DIRS && !ignore.ignores(rel, true)) walk(p)
                        continue
                    }
                    if (!Files.isRegularFile(p) || name.endsWith(".pyc") || name.endsWith(".pyo") || ignore.ignores(rel, false)) continue
                    val data = Files.readAllBytes(p)
                    val text = if (name.substringAfterLast('.', "").lowercase() in TEXT_EXT) utf8(data) else null
                    out += if (text != null) UploadFile(rel, text, "utf-8")
                    else UploadFile(rel, Base64.getEncoder().encodeToString(data), "base64")
                }
            }
        }
        walk(root)
        return out.sortedBy { it.path }
    }

    private fun utf8(data: ByteArray): String? = try {
        StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString()
    } catch (_: CharacterCodingException) { null }
}

/** gitignore-lite matcher for .syncignore (sync.ts IgnoreRules); the last matching rule wins. */
class IgnoreRules(text: String) {
    private data class Rule(val re: Regex, val dirOnly: Boolean, val negate: Boolean)
    private val rules = mutableListOf<Rule>()
    val size: Int get() = rules.size

    init {
        for (raw in text.split(Regex("\r?\n"))) {
            var line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val negate = line.startsWith("!")
            if (negate) line = line.substring(1)
            val dirOnly = line.endsWith("/")
            if (dirOnly) line = line.dropLast(1)
            val anchored = line.startsWith("/") || "/" in line
            line = line.removePrefix("/")
            if (line.isEmpty()) continue
            val body = globToRegex(line)
            rules += Rule(Regex(if (anchored) "^$body$" else "(?:^|/)$body$"), dirOnly, negate)
        }
    }

    /** `rel` is "/"-separated and relative to the project root. */
    fun ignores(rel: String, isDir: Boolean): Boolean {
        var ignored = false
        for (r in rules) {
            if (r.dirOnly && !isDir) continue
            if (r.re.containsMatchIn(rel)) ignored = !r.negate
        }
        return ignored
    }

    private fun globToRegex(glob: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < glob.length) {
            val c = glob[i]
            when {
                c == '*' && glob.getOrNull(i + 1) == '*' -> {
                    i++
                    if (glob.getOrNull(i + 1) == '/') { i++; out.append("(?:.*/)?") } else out.append(".*")
                }
                c == '*' -> out.append("[^/]*")
                c == '?' -> out.append("[^/]")
                else -> out.append(Regex.escape(c.toString()))
            }
            i++
        }
        return out.toString()
    }
}
