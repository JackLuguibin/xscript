package com.xscript.app.project

import android.content.Context
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
class ProjectStore(val root: File) {
    constructor(context: Context) : this(File(context.getExternalFilesDir(null), "projects"))

    init {
        root.mkdirs()
    }

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

    fun create(name: String): File = create(name, strict = false)

    private fun create(name: String, strict: Boolean): File {
        val d = dir(name)
        d.mkdirs()
        val init = File(d, "__init__.py")
        // createNewFile is atomic: of two concurrent strict creates exactly one wins, the other gets 409.
        val fresh = init.createNewFile()
        check(!strict || fresh) { "工程已存在: ${d.name}" }
        File(d, "res/img").mkdirs()
        if (fresh) {
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

    /**
     * Strict create for the HTTP API / Web IDE: rejects invalid names (IllegalArgumentException → 400)
     * and existing projects (IllegalStateException → 409) instead of silently reusing them.
     */
    fun createNew(name: String, files: Map<String, String>? = null): File {
        require(isValidName(name)) { "工程名须以字母或下划线开头，仅包含字母、数字、下划线: $name" }
        check(!hasEntry(dir(name))) { "工程已存在: ${name.trim()}" }
        val d = create(name, strict = true)
        files?.let { writeTemplate(name, it) }
        return d
    }

    /** Create (lenient, like [create]) and fill with template [files] when the project is new. */
    fun createFromTemplate(name: String, files: Map<String, String>): File {
        val fresh = !hasEntry(dir(name))
        val d = create(name)
        if (fresh) writeTemplate(name, files)
        return d
    }

    private fun writeTemplate(name: String, files: Map<String, String>) {
        for ((rel, content) in files) writeFile(name, rel, content, "utf-8")
    }

    /** Delete a project. Symlinks inside it are removed, never followed (their targets stay intact). */
    fun delete(name: String): Boolean = deleteTree(dir(name))

    /** Create-only file write: fails with 409 when the path already exists (file or folder). */
    fun createFile(name: String, relativePath: String, content: String, encoding: String): File {
        if (!exists(name)) throw NoSuchElementException("工程不存在: $name")
        val target = resolve(name, relativePath)
        check(!target.exists()) { "文件已存在: ${normalizeRel(relativePath)}" }
        target.parentFile?.mkdirs()
        // Atomic claim of the path, so two concurrent creates cannot both succeed.
        check(target.createNewFile()) { "文件已存在: ${normalizeRel(relativePath)}" }
        return writeFile(name, relativePath, content, encoding)
    }

    /** Create a folder (and parents). Fails with 409 when a file or folder already uses the path. */
    fun createDir(name: String, relativePath: String): File {
        if (!exists(name)) throw NoSuchElementException("工程不存在: $name")
        val target = resolve(name, relativePath)
        check(!target.exists()) { "路径已存在: ${normalizeRel(relativePath)}" }
        check(target.mkdirs()) { "无法创建文件夹: ${normalizeRel(relativePath)}" }
        return target
    }

    /** Resolve a project-relative path, rejecting anything that escapes the project directory. */
    fun resolve(name: String, relativePath: String): File {
        val base = dir(name)
        val target = File(base, normalizeRel(relativePath))
        require(target.canonicalPath.startsWith(base.canonicalPath + File.separator)) { "路径须位于工程目录内" }
        return target
    }

    fun writeFile(name: String, relativePath: String, content: String, encoding: String): File {
        val target = resolve(name, relativePath)
        require(!target.isDirectory) { "路径是文件夹: ${normalizeRel(relativePath)}" }
        target.parentFile?.mkdirs()
        val bytes = if (encoding.equals("base64", ignoreCase = true)) {
            java.util.Base64.getMimeDecoder().decode(content)
        } else {
            content.toByteArray(Charsets.UTF_8)
        }
        target.writeBytes(bytes)
        return target
    }

    /** Resolved like writes, so a symlink inside the project cannot expose files outside it. */
    fun readFile(name: String, relativePath: String): File = resolve(name, relativePath)

    /**
     * Delete one file, or an empty folder. The entry point cannot be deleted (400), a missing
     * path is reported as [NoSuchElementException] (404), and a non-empty folder is refused (409).
     */
    fun deleteFile(name: String, relativePath: String): Boolean {
        val rel = normalizeRel(relativePath)
        require(!isEntry(rel)) { "不能删除工程入口 $rel" }
        val target = resolve(name, rel)
        if (!target.exists()) throw NoSuchElementException("文件不存在: $rel")
        if (target.isDirectory) check(target.list().isNullOrEmpty()) { "文件夹非空: $rel" }
        check(target.delete()) { "删除失败: $rel" }
        return true
    }

    /**
     * Rename / move a file or folder inside the project (Web IDE 重命名 / 移动). 404 when the project or
     * source is missing, 400 for invalid paths, moving the entry point, or a folder into itself, 409 when
     * the destination exists. One rename(2) call (no copy), never replacing; moves are serialized.
     */
    fun move(name: String, fromPath: String, toPath: String): String {
        if (!exists(name)) throw NoSuchElementException("工程不存在: $name")
        val from = normalizeRel(fromPath)
        val to = normalizeRel(toPath)
        require(!isEntry(from)) { "不能移动工程入口 $from" }
        require(from != to) { "新路径与原路径相同: $to" }
        require(!to.startsWith("$from/")) { "不能把文件夹移动到它自己里面: $to" }
        val src = resolve(name, from)
        val dst = resolve(name, to)
        synchronized(moveLock) {
            if (!src.exists() && !isLink(src)) throw NoSuchElementException("文件不存在: $from")
            check(!dst.exists() && !isLink(dst)) { "目标已存在: $to" }
            dst.parentFile?.let { parent ->
                require(!parent.isFile) { "目标上级不是文件夹: ${to.substringBeforeLast('/')}" }
                parent.mkdirs()
            }
            try {
                java.nio.file.Files.move(src.toPath(), dst.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
            } catch (e: java.nio.file.FileAlreadyExistsException) {
                throw IllegalStateException("目标已存在: $to")
            }
        }
        return to
    }

    /** Project-relative folders (excluding hidden and __pycache__), so empty folders are visible. */
    fun dirs(name: String): JSONArray {
        val base = dir(name)
        val arr = JSONArray()
        base.walkTopDown()
            .onEnter { it == base || (it.name != "__pycache__" && !it.name.startsWith(".") && !isLink(it)) }
            .filter { it.isDirectory && it != base }
            .map { it.relativeTo(base).invariantSeparatorsPath }
            .sorted()
            .forEach { arr.put(it) }
        return arr
    }

    fun files(name: String): JSONArray {
        val base = dir(name)
        val arr = JSONArray()
        base.walkTopDown()
            .onEnter { it == base || (it.name != "__pycache__" && !it.name.startsWith(".") && !isLink(it)) }
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
            if (replace) deleteTree(target)
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
        private val moveLock = Any()

        private fun isLink(f: File): Boolean = java.nio.file.Files.isSymbolicLink(f.toPath())

        /** Like deleteRecursively, but a symlink (file or folder) is unlinked instead of walked into. */
        fun deleteTree(f: File): Boolean {
            if (!isLink(f) && f.isDirectory) f.listFiles()?.forEach { deleteTree(it) }
            return f.delete() || !f.exists() && !isLink(f)
        }

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
            require(!cleaned.split('/').any { it == ".." || it == "." || it == "" }) { "invalid path" }
            require(cleaned.none { it == '\u0000' }) { "invalid path" }
            return cleaned
        }

        /** The project entry module (source or protected bytecode). */
        fun isEntry(rel: String): Boolean = rel == "__init__.py" || rel == "__init__.pyc"
    }
}
