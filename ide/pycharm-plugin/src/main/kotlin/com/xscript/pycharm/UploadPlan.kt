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

    /** The file list for the confirmation: at most `max` lines, then "… and N more". */
    fun describeDeletes(paths: List<String>, max: Int = 30, more: (Int) -> String = { "… and $it more" }): String =
        (paths.take(max).map { "  $it" } + (if (paths.size > max) listOf("  " + more(paths.size - max)) else emptyList())).joinToString("\n")

    /** One cache per device address and project, like the VS Code workspaceState key. */
    fun cacheKey(target: DeviceTarget, project: String) = "xscript.sync:${target.host}:${target.port}:$project"
}
