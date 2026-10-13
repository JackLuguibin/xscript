package com.xscript.app.project

import android.content.Context
import android.util.Base64
import com.xscript.app.root.RootShell
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * Projects live in `<external files>/projects/<name>/` with `__init__.py` as entry.
 * The directory name doubles as the Python package name, so it must be an identifier
 * (Unicode letters allowed, same as AScript).
 */
class ProjectStore(context: Context) {
    val root: File = File(context.getExternalFilesDir(null), "projects").apply { mkdirs() }

    fun list(): List<String> {
        val dirs = root.listFiles() ?: return emptyList()
        return dirs.filter { it.isDirectory && hasEntry(it) }.map { it.name }.sorted()
    }

    fun describe(): JSONArray {
        val arr = JSONArray()
        for (name in list()) {
            val dir = dir(name)
            arr.put(
                JSONObject()
                    .put("name", name)
                    .put("modified", lastModified(dir))
                    .put("flavor", flavor(dir))
                    .put("files", countFiles(dir)),
            )
        }
        return arr
    }

    fun dir(name: String): File = File(root, sanitize(name))

    fun exists(name: String): Boolean {
        if (!isValidName(name)) return false
        return hasEntry(dir(name))
    }

    fun create(name: String): File {
        val d = dir(name)
        d.mkdirs()
        File(d, "res/img").mkdirs()
        val init = File(d, "__init__.py")
        if (!init.exists()) {
            init.writeText(
                """
                # ${d.name}: 入口文件
                from xscript.android import action, node, screen, system

                print("hello from ${d.name}")
                """.trimIndent() + "\n",
            )
        }
        return d
    }

    fun delete(name: String): Boolean = dir(name).deleteRecursively()

    fun writeFile(name: String, relativePath: String, content: String, encoding: String): File {
        val target = File(dir(name), normalizeRel(relativePath))
        target.parentFile?.mkdirs()
        val bytes = if (encoding.equals("base64", ignoreCase = true)) {
            Base64.decode(content, Base64.DEFAULT)
        } else {
            content.toByteArray(Charsets.UTF_8)
        }
        target.writeBytes(bytes)
        return target
    }

    fun readFile(name: String, relativePath: String): File = File(dir(name), normalizeRel(relativePath))

    fun deleteFile(name: String, relativePath: String): Boolean =
        File(dir(name), normalizeRel(relativePath)).deleteRecursively()

    fun files(name: String): JSONArray {
        val base = dir(name)
        val arr = JSONArray()
        base.walkTopDown()
            .onEnter { it.name != "__pycache__" && !it.name.startsWith(".") || it == base }
            .filter { it.isFile }
            .sortedBy { it.path }
            .forEach { f ->
                arr.put(
                    JSONObject()
                        .put("path", f.relativeTo(base).invariantSeparatorsPath)
                        .put("size", f.length())
                        .put("modified", f.lastModified()),
                )
            }
        return arr
    }

    /**
     * Unpack a zip into project `name`. A single top-level folder in the archive is
     * stripped, so both "proj.zip → __init__.py" and "proj.zip → proj/__init__.py" work.
     */
    fun importZip(name: String, input: InputStream, replace: Boolean = true): File {
        val target = dir(name)
        // Entries stream straight to a staging dir (never whole files in memory). It sits
        // next to `projects/`, on the same filesystem, so moving files is a rename.
        val staging = File(root.parentFile, "import-tmp/" + System.nanoTime())
        staging.mkdirs()
        try {
            val paths = mutableListOf<String>()
            ZipInputStream(input).use { zip ->
                var e: ZipEntry? = zip.nextEntry
                while (e != null) {
                    val path = e.name.replace('\\', '/')
                    val skip = e.isDirectory || path.split('/').any { it == "__pycache__" || it == "__MACOSX" }
                    if (!skip) {
                        val rel = normalizeRel(path)
                        val out = File(staging, rel)
                        out.parentFile?.mkdirs()
                        out.outputStream().use { zip.copyTo(it) }
                        paths.add(rel)
                    }
                    e = zip.nextEntry
                }
            }
            val prefix = commonTopFolder(paths)
            val src = if (prefix.isEmpty()) staging else File(staging, prefix.trimEnd('/'))
            // Validate before touching the existing project so a bad zip leaves it intact.
            require(hasEntry(src) || (!replace && hasEntry(target))) { "zip has no __init__.py" }
            if (replace) target.deleteRecursively()
            target.mkdirs()
            src.walkTopDown().filter { it.isFile }.forEach { f ->
                val out = File(target, f.relativeTo(src).path)
                out.parentFile?.mkdirs()
                if (out.exists()) out.delete()
                if (!f.renameTo(out)) f.copyTo(out, overwrite = true)
            }
        } finally {
            staging.deleteRecursively()
        }
        return target
    }

    fun exportZip(name: String, out: java.io.OutputStream) {
        val base = dir(name)
        ZipOutputStream(out).use { zip ->
            base.walkTopDown()
                .onEnter { it == base || it.name != "__pycache__" }
                .filter { it.isFile }
                .forEach { f ->
                    zip.putNextEntry(ZipEntry(base.name + "/" + f.relativeTo(base).invariantSeparatorsPath))
                    f.inputStream().use { it.copyTo(zip) }
                    zip.closeEntry()
                }
        }
    }

    /** Projects found in AScript's model directory (`/sdcard/airscript/model`). */
    fun ascriptProjects(): List<String> {
        val direct = File(ASCRIPT_MODEL).listFiles()
            ?.filter { File(it, "__init__.py").isFile }
            ?.map { it.name }
        if (!direct.isNullOrEmpty()) return direct.sorted()
        if (RootShell.known() != true) return emptyList()
        val res = RootShell.exec("for d in $ASCRIPT_MODEL/*/; do [ -f \"\$d/__init__.py\" ] && basename \"\$d\"; done")
        return res.out.lines().map { it.trim() }.filter { it.isNotEmpty() }.sorted()
    }

    /** Copy an AScript project in. Uses plain file IO when readable, otherwise root. */
    fun importAscript(project: String): File {
        val src = File(ASCRIPT_MODEL, project)
        val target = dir(project)
        target.deleteRecursively()
        target.mkdirs()
        if (src.canRead() && src.listFiles() != null) {
            src.walkTopDown()
                .onEnter { it == src || (it.name != "__pycache__" && !it.name.startsWith(".")) }
                .filter { it.isFile }
                .forEach { f ->
                    val out = File(target, f.relativeTo(src).path)
                    out.parentFile?.mkdirs()
                    f.copyTo(out, overwrite = true)
                }
        } else {
            require(RootShell.available()) { "cannot read $src (needs root or storage permission)" }
            // Stream a tar through su so the files land with our own uid.
            val tar = RootShell.execRaw(
                "cd " + RootShell.quote(src.absolutePath) +
                    " && tar -cf - --exclude=__pycache__ --exclude=.mypy_cache --exclude=.git . 2>/dev/null || " +
                    "(cd " + RootShell.quote(src.absolutePath) + " && tar -cf - .)",
                120_000,
            )
            require(tar.out.isNotEmpty()) { "root copy failed: ${tar.err}" }
            untar(tar.out, target)
        }
        require(File(target, "__init__.py").isFile) { "$project has no __init__.py" }
        return target
    }

    private fun untar(bytes: ByteArray, target: File) {
        var off = 0
        var longName: String? = null
        while (off + 512 <= bytes.size) {
            val header = bytes.copyOfRange(off, off + 512)
            if (header.all { it.toInt() == 0 }) break
            var name = longName ?: cString(header, 0, 100)
            longName = null
            val prefix = cString(header, 345, 155)
            if (prefix.isNotEmpty() && !name.contains('/')) name = "$prefix/$name"
            val size = cString(header, 124, 12).trim().ifEmpty { "0" }.toLong(8).toInt()
            val type = header[156].toInt().toChar()
            off += 512
            val data = bytes.copyOfRange(off, (off + size).coerceAtMost(bytes.size))
            off += ((size + 511) / 512) * 512
            when (type) {
                'L' -> longName = String(data, Charsets.UTF_8).trimEnd('\u0000')
                '0', '\u0000' -> {
                    val rel = name.removePrefix("./")
                    if (rel.isEmpty() || rel.split('/').any { it == "__pycache__" || (it.startsWith(".") && it.length > 1) }) continue
                    val out = File(target, normalizeRel(rel))
                    out.parentFile?.mkdirs()
                    out.writeBytes(data)
                }
            }
        }
    }

    private fun cString(b: ByteArray, start: Int, len: Int): String {
        var end = start
        while (end < start + len && b[end].toInt() != 0) end++
        return String(b, start, end - start, Charsets.UTF_8)
    }

    private fun commonTopFolder(paths: List<String>): String {
        if (paths.any { !it.contains('/') }) return ""
        val tops = paths.map { it.substringBefore('/') }.toSet()
        if (tops.size != 1) return ""
        val top = tops.first()
        return if (paths.any { it == "$top/__init__.py" || it == "$top/__init__.pyc" }) "$top/" else ""
    }

    private fun lastModified(dir: File): Long =
        dir.walkTopDown().onEnter { it.name != "__pycache__" }.filter { it.isFile }.maxOfOrNull { it.lastModified() } ?: dir.lastModified()

    private fun countFiles(dir: File): Int =
        dir.walkTopDown().onEnter { it.name != "__pycache__" }.count { it.isFile }

    /** "ascript" if the project imports the AScript API, otherwise "xscript". */
    private fun flavor(dir: File): String {
        val init = File(dir, "__init__.py")
        val text = try {
            init.readText()
        } catch (_: Exception) {
            ""
        }
        if (text.contains("ascript.") || File(dir, "build.as").isFile) return "ascript"
        return "xscript"
    }

    companion object {
        const val ASCRIPT_MODEL = "/sdcard/airscript/model"

        /** Entry module: source, or bytecode only for 代码保护 builds. */
        fun hasEntry(dir: File): Boolean = File(dir, "__init__.py").isFile || File(dir, "__init__.pyc").isFile

        private val NAME = Regex("""[\p{L}_][\p{L}\p{N}_]*""")

        fun isValidName(name: String): Boolean = name.trim().matches(NAME)

        fun sanitize(name: String): String {
            val n = name.trim()
            require(n.matches(NAME)) { "invalid project name: $name" }
            return n
        }

        fun normalizeRel(path: String): String {
            val cleaned = path.trim().replace('\\', '/').trimStart('/')
            require(cleaned.isNotEmpty()) { "empty path" }
            require(!cleaned.split('/').any { it == ".." || it == "" }) { "invalid path" }
            return cleaned
        }
    }
}
