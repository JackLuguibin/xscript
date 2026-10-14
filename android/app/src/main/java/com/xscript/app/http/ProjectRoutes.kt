package com.xscript.app.http

import com.xscript.app.project.ProjectStore
import org.json.JSONObject

/**
 * Web IDE project/file endpoints (新建工程 / 文件列表 / 新建文件 / 新建文件夹 / 读写 / 删除) on top of
 * [ProjectStore]. Pure JVM (no Android Context), so the HTTP contract is unit-tested directly.
 * Exceptions map to status codes in [ApiRouter.errorReply].
 */
class ProjectRoutes(private val store: ProjectStore) {
    /** Reply for `METHOD /projects/<name><sub>`, or null when this is not a file-management route. */
    fun handle(method: String, name: String, sub: String, req: ApiRouter.Request): ApiRouter.Reply? = when {
        method == "POST" && sub.isEmpty() -> {
            // Strict: 400 for an invalid name, 409 when the project already exists.
            store.createNew(name)
            ApiRouter.Reply.json(JSONObject().put("ok", true).put("project", name))
        }
        method == "GET" && sub == "/files" -> {
            ApiRouter.Reply.json(JSONObject().put("project", name).put("files", store.files(name)).put("dirs", store.dirs(name)))
        }
        method == "POST" && sub == "/dir" -> {
            val path = req.json().optString("path")
            store.createDir(name, path)
            ApiRouter.Reply.json(JSONObject().put("ok", true).put("path", ProjectStore.normalizeRel(path)))
        }
        method == "PUT" && sub == "/files" -> upload(name, req)
        method == "GET" && sub == "/file" -> readFile(name, req)
        method == "DELETE" && sub == "/file" ->
            ApiRouter.Reply.json(JSONObject().put("ok", store.deleteFile(name, req.query["path"].orEmpty())))
        else -> null
    }

    private fun upload(name: String, req: ApiRouter.Request): ApiRouter.Reply {
        val body = req.json()
        val files = body.optJSONArray("files")
        if (files != null) {
            for (i in 0 until files.length()) {
                val f = files.getJSONObject(i)
                store.writeFile(name, f.getString("path"), f.optString("content"), f.optString("encoding", "utf-8"))
            }
            return ApiRouter.Reply.json(JSONObject().put("ok", true).put("count", files.length()))
        }
        val path = body.optString("path")
        if (body.optBoolean("create")) {
            // Create-only (Web IDE 新建文件): 404 missing project, 409 if the path exists.
            store.createFile(name, path, body.optString("content"), body.optString("encoding", "utf-8"))
            return ApiRouter.Reply.json(JSONObject().put("ok", true).put("path", ProjectStore.normalizeRel(path)))
        }
        store.writeFile(name, path, body.optString("content"), body.optString("encoding", "utf-8"))
        return ApiRouter.Reply.json(JSONObject().put("ok", true))
    }

    private fun readFile(name: String, req: ApiRouter.Request): ApiRouter.Reply {
        val f = store.readFile(name, req.query["path"].orEmpty())
        if (!f.isFile) return ApiRouter.Reply.json(JSONObject().put("error", "missing file"), 404)
        val text = isText(f.name)
        if (req.query["raw"] == "1") {
            return ApiRouter.Reply.file(f, if (text) "text/plain; charset=utf-8" else "application/octet-stream", temp = false)
        }
        val bytes = f.readBytes()
        val out = JSONObject().put("path", req.query["path"])
        return if (text) {
            ApiRouter.Reply.json(out.put("encoding", "utf-8").put("content", String(bytes, Charsets.UTF_8)))
        } else {
            ApiRouter.Reply.json(out.put("encoding", "base64").put("content", java.util.Base64.getEncoder().encodeToString(bytes)))
        }
    }

    companion object {
        fun isText(name: String): Boolean {
            val ext = name.substringAfterLast('.', "").lowercase()
            return ext in setOf("py", "txt", "md", "json", "yaml", "yml", "html", "htm", "js", "css", "as", "ini", "cfg", "csv", "xml", "toml")
        }
    }
}
