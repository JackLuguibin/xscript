package com.xscript.app.ml

import android.content.Context
import com.xscript.app.project.ProjectStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream

/**
 * Model files (YOLO .onnx, PaddleOCR packs) in `<external files>/models/`. Shared by every
 * project; Python's `xscript.android.models` downloads into the same directory.
 * `PUT /models/<path>` uploads a file, `GET /models` lists them, `DELETE /models/<path>` removes one.
 */
object ModelStore {
    fun dir(context: Context): File = File(context.getExternalFilesDir(null), "models").apply { mkdirs() }

    fun list(context: Context): JSONArray {
        val base = dir(context)
        val arr = JSONArray()
        base.walkTopDown()
            .filter { it.isFile && !it.name.endsWith(".sha256") && !it.name.contains(".part") }
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

    fun file(context: Context, rel: String): File = resolve(dir(context), rel)

    fun resolve(base: File, rel: String): File {
        val target = File(base, ProjectStore.normalizeRel(rel))
        // normalizeRel already refuses "..", this also stops a symlink inside the folder pointing out of it.
        require(target.canonicalPath.startsWith(base.canonicalPath + File.separator)) { "路径须位于模型目录内" }
        return target
    }

    /** Stream an upload into place through a temp file, so a broken upload never leaves half a model. */
    fun write(context: Context, rel: String, input: InputStream): File {
        val target = file(context, rel)
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, target.name + ".part-upload")
        try {
            tmp.outputStream().use { input.copyTo(it) }
            if (target.exists()) target.delete()
            require(tmp.renameTo(target)) { "cannot move upload into place" }
            File(target.path + ".sha256").delete()
        } finally {
            tmp.delete()
        }
        return target
    }

    fun delete(context: Context, rel: String): Boolean {
        val f = file(context, rel)
        File(f.path + ".sha256").delete()
        return f.deleteRecursively()
    }
}
