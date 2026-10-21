package com.xscript.pycharm

import java.nio.file.Files
import java.nio.file.Path

/** Pulling a project from the device into a local folder: the Kotlin twin of the VS Code extension's sync.ts pull. */
object ProjectPull {
    class PulledFile(val path: String, val data: ByteArray)
    data class Diff(val added: List<String>, val changed: List<String>, val unchanged: List<String>)

    /** A device path we are willing to write: relative, "/"-separated, no empty / "." / ".." segments. */
    fun safeRelative(rel: String): Boolean =
        rel.isNotEmpty() && !rel.startsWith("/") && '\\' !in rel && '\u0000' !in rel &&
            rel.split("/").all { it.isNotEmpty() && it != "." && it != ".." }

    /** Downloads every file of `project`; unsafe paths are skipped. Throws when the project does not exist. */
    fun fetch(client: DeviceClient, project: String, onFile: (String) -> Unit = {}): List<PulledFile> {
        val list = client.projectFiles(project) ?: throw IllegalStateException(XScriptBundle.message("pull.missing", project))
        return list.filter { safeRelative(it.path) }.map {
            onFile(it.path)
            PulledFile(it.path, client.readFileRaw(project, it.path))
        }
    }

    private fun local(root: Path, rel: String): Path = rel.split("/").fold(root) { p, seg -> p.resolve(seg) }

    fun diff(root: Path, pulled: List<PulledFile>): Diff {
        val added = mutableListOf<String>(); val changed = mutableListOf<String>(); val same = mutableListOf<String>()
        for (f in pulled) {
            val p = local(root, f.path)
            when {
                !Files.exists(p) -> added += f.path
                Files.readAllBytes(p).contentEquals(f.data) -> same += f.path
                else -> changed += f.path
            }
        }
        return Diff(added, changed, same)
    }

    /** Writes only new or different files; local files the device does not have are left alone. Returns how many were written. */
    fun write(root: Path, pulled: List<PulledFile>, diff: Diff = diff(root, pulled)): Int {
        val todo = (diff.added + diff.changed).toSet()
        var n = 0
        for (f in pulled) {
            if (f.path !in todo) continue
            val p = local(root, f.path)
            Files.createDirectories(p.parent)
            Files.write(p, f.data)
            n++
        }
        return n
    }
}
