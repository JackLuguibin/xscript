package com.xscript.pycharm

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/** What to send this time and the hashes to remember once it went through (the VS Code extension's sync.ts planUpload). */
data class UploadPlan(val upload: List<UploadFile>, val skipped: Int, val hashes: Map<String, String>)

object UploadPlanner {
    fun bytes(f: UploadFile): ByteArray =
        if (f.encoding == "base64") Base64.getDecoder().decode(f.content) else f.content.toByteArray(StandardCharsets.UTF_8)

    fun sha1(data: ByteArray): String = MessageDigest.getInstance("SHA-1").digest(data).joinToString("") { "%02x".format(it) }

    /**
     * A file is skipped only when the device has it with the same size AND its hash is the one we uploaded last time.
     * `remote` null (project missing, or a full upload) sends everything.
     */
    fun plan(files: List<UploadFile>, remote: List<RemoteFile>?, cache: Map<String, String>): UploadPlan {
        val remoteSize = remote?.associate { it.path to it.size } ?: emptyMap()
        val hashes = LinkedHashMap<String, String>()
        val upload = mutableListOf<UploadFile>()
        var skipped = 0
        for (f in files) {
            val data = bytes(f)
            val h = sha1(data)
            hashes[f.path] = h
            if (remote != null && remoteSize[f.path] == data.size.toLong() && cache[f.path] == h) skipped++ else upload += f
        }
        return UploadPlan(upload, skipped, hashes)
    }

    /** The device refuses to delete a project's entry. */
    private val PROTECTED = setOf("__init__.py", "__init__.pyc")

    /**
     * Device files an upload with "delete files removed locally" would delete: on the device, not in `local`,
     * and managed by uploads (`synced`, e.g. not matched by .syncignore). Sorted. `remote` null (no list) deletes nothing.
     */
    fun planDeletes(local: Collection<String>, remote: List<RemoteFile>?, synced: (String) -> Boolean): List<String> {
        remote ?: return emptyList()
        val have = local.toHashSet()
        return remote.map { it.path }.filter { it !in have && it !in PROTECTED && synced(it) }.distinct().sorted()
    }

    /**
     * Device folders that `gone` leaves without files: every device file under them is being deleted and no local
     * file lives under them (a file uploaded a moment ago is not in the pre-upload `remote` list). __pycache__ and .pyc
     * leftovers do not count as content. Only the topmost such folders, sorted; they are removed with
     * DELETE ?recursive=1, which takes those leftovers too.
     */
    fun planEmptiedFolders(local: Collection<String>, remote: List<RemoteFile>?, gone: List<String>): List<String> {
        if (remote == null || gone.isEmpty()) return emptyList()
        val deleting = gone.toHashSet()
        fun dirsOf(p: String): List<String> {
            val parts = p.split('/')
            return (1 until parts.size).map { parts.subList(0, it).joinToString("/") }
        }
        fun generated(p: String) = p.endsWith(".pyc") || "__pycache__" in p.split('/')
        val keep = HashSet<String>()
        remote.forEach { f -> if (f.path !in deleting && !generated(f.path)) keep += dirsOf(f.path) }
        local.forEach { keep += dirsOf(it) }
        val cands = gone.flatMap(::dirsOf).filter { it !in keep }.toSet()
        return cands.filter { d -> dirsOf(d).none { it in cands } }.sorted()
    }

    /** The file list for the confirmation: at most `max` lines, then "… and N more". */
    fun describeDeletes(paths: List<String>, max: Int = 30, more: (Int) -> String = { "… and $it more" }): String =
        (paths.take(max).map { "  $it" } + (if (paths.size > max) listOf("  " + more(paths.size - max)) else emptyList())).joinToString("\n")

    /** One cache per device address and project, like the VS Code workspaceState key. */
    fun cacheKey(target: DeviceTarget, project: String) = "xscript.sync:${target.host}:${target.port}:$project"
}
