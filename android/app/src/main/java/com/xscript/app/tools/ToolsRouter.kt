package com.xscript.app.tools

import android.content.Context
import android.graphics.Bitmap
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.http.ApiRouter.Reply
import com.xscript.app.http.ApiRouter.Request
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.EvalRunner
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Developer tools served from the device (图色工具, 标注工具, 投屏):
 *
 *   GET  /tools/                         tool pages (assets/tools/)
 *   POST /tools/snapshots                freeze the current screen → {id, width, height, url}
 *   GET  /tools/snapshots                recent snapshots
 *   GET  /tools/snapshots/<id>.png       snapshot image
 *   POST /tools/snapshots/<id>/crop      save a region into a project (res/img/...)
 *   POST /tools/vision                   pixel / find_colors / compare_colors / find_image / ocr
 *   /tools/datasets/...                  标注 datasets, see [datasets]
 *
 * The MJPEG 投屏 stream (`GET /screen/stream`) needs a streaming response, so it lives
 * in the HTTP server itself.
 */
class ToolsRouter(private val context: Context) {
    private val snapshots = SnapshotStore(File(context.filesDir, "tools/snapshots"))
    private val datasets = DatasetStore(File(context.getExternalFilesDir(null), "datasets"))
    private val projects = ProjectStore(context)

    fun handles(path: String) = path == "/tools" || path.startsWith("/tools/")

    fun route(req: Request, p: String): Reply {
        val m = req.method
        return when {
            m == "GET" && (p == "/tools" || p == "/tools/" || p.startsWith("/tools/ui/")) -> asset(p)
            m == "GET" && p == "/tools/snapshots" -> Reply.json(JSONObject().put("snapshots", snapshots.list()))
            m == "POST" && p == "/tools/snapshots" -> snapshot()
            m == "GET" && p.startsWith("/tools/snapshots/") && p.endsWith(".png") -> {
                val id = p.removePrefix("/tools/snapshots/").removeSuffix(".png")
                val f = snapshots.file(id) ?: return notFound("missing snapshot")
                Reply.file(f, "image/png", temp = false)
            }
            m == "POST" && p.startsWith("/tools/snapshots/") && p.endsWith("/crop") ->
                crop(p.removePrefix("/tools/snapshots/").removeSuffix("/crop"), req.json())
            m == "POST" && p == "/tools/vision" -> vision(req.json())
            p == "/tools/datasets" || p.startsWith("/tools/datasets/") -> datasets(req, p)
            else -> notFound("not found")
        }
    }

    // ---- snapshots ----

    private fun snapshot(): Reply {
        val bmp = CaptureEngine.captureBitmap()
            ?: return Reply.json(JSONObject().put("error", "capture_unavailable"), 503)
        val out = ByteArrayOutputStream()
        val w = bmp.width
        val h = bmp.height
        // PNG keeps colors exact, which the color picker depends on.
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return Reply.json(snapshots.save(out.toByteArray(), w, h))
    }

    /** {"rect":[l,t,r,b], "project":"demo", "path":"res/img/ok.png"} → writes a PNG crop. */
    private fun crop(id: String, body: JSONObject): Reply {
        val src = snapshots.file(id) ?: return notFound("missing snapshot")
        val project = body.getString("project")
        require(projects.exists(project)) { "missing project $project" }
        val rel = body.optString("path").ifEmpty { "res/img/crop_${System.currentTimeMillis()}.png" }
        require(rel.lowercase().endsWith(".png")) { "path must end with .png" }
        val r = body.getJSONArray("rect")
        val bmp = android.graphics.BitmapFactory.decodeFile(src.absolutePath)
            ?: return Reply.json(JSONObject().put("error", "cannot decode snapshot"), 500)
        try {
            val l = r.getInt(0).coerceIn(0, bmp.width - 1)
            val t = r.getInt(1).coerceIn(0, bmp.height - 1)
            val rr = r.getInt(2).coerceIn(l + 1, bmp.width)
            val bb = r.getInt(3).coerceIn(t + 1, bmp.height)
            val part = Bitmap.createBitmap(bmp, l, t, rr - l, bb - t)
            val bytes = ByteArrayOutputStream().also { part.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            if (part !== bmp) part.recycle()
            projects.writeFile(project, rel, android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP), "base64")
            return Reply.json(
                JSONObject().put("ok", true).put("project", project).put("path", rel)
                    .put("rect", JSONArray(listOf(l, t, rr, bb))),
            )
        } finally {
            bmp.recycle()
        }
    }

    // ---- vision ----

    /**
     * Runs in :eval against a snapshot, so results match the Python API. `snapshot` picks
     * the image; `template` ("project:path/in/project.png") resolves to a project file.
     */
    private fun vision(body: JSONObject): Reply {
        val id = body.optString("snapshot")
        val file = snapshots.file(id) ?: return notFound("missing snapshot")
        val req = JSONObject(body.toString()).put("image", file.absolutePath)
        req.remove("snapshot")
        val template = body.optString("template")
        if (template.isNotEmpty()) {
            val project = template.substringBefore(':')
            val rel = template.substringAfter(':', "")
            require(projects.exists(project) && rel.isNotEmpty()) { "template must be <project>:<path>" }
            val f = projects.readFile(project, rel)
            require(f.isFile) { "missing template $template" }
            req.put("template_path", f.absolutePath)
            req.remove("template")
        }
        val timeout = body.optLong("timeout_ms", 12_000L).coerceIn(500L, 20_000L)
        val result = EvalRunner.vision(req, timeout)
        return when {
            result.optString("error") == "timeout" -> Reply.json(result, 408)
            !result.optBoolean("ok") -> Reply.json(result, 400)
            else -> Reply.json(result)
        }
    }

    // ---- 标注 datasets ----
    //
    //   GET    /tools/datasets                         list
    //   POST   /tools/datasets/<name>                  create
    //   DELETE /tools/datasets/<name>                  delete
    //   GET    /tools/datasets/<name>                  classes + items
    //   PUT    /tools/datasets/<name>/classes          {"classes": [...]}
    //   POST   /tools/datasets/<name>/images           body = PNG/JPEG bytes, or {"snapshot": id}
    //   GET    /tools/datasets/<name>/images/<id>      image bytes
    //   DELETE /tools/datasets/<name>/images/<id>
    //   GET    /tools/datasets/<name>/labels/<id>      {"width","height","boxes":[{"cls","rect"}]}
    //   PUT    /tools/datasets/<name>/labels/<id>
    //   GET    /tools/datasets/<name>/export           YOLO zip (images/, labels/, data.yaml)

    private val datasetRoute = Regex("^/tools/datasets/([^/]+)(?:/(classes|images|labels|export)(?:/([^/]+))?)?$")

    private fun datasets(req: Request, p: String): Reply {
        val m = req.method
        if (p == "/tools/datasets") {
            return if (m == "GET") Reply.json(JSONObject().put("datasets", datasets.list())) else notFound("not found")
        }
        val match = datasetRoute.matchEntire(p) ?: return notFound("not found")
        val name = java.net.URLDecoder.decode(match.groupValues[1], "UTF-8")
        val section = match.groupValues[2]
        val id = match.groupValues[3]
        if (!(m == "POST" && section.isEmpty()) && !datasets.exists(name)) return notFound("missing dataset $name")
        return when {
            section.isEmpty() && m == "POST" -> Reply.json(datasets.create(name))
            section.isEmpty() && m == "GET" -> Reply.json(datasets.describe(name))
            section.isEmpty() && m == "DELETE" -> Reply.json(JSONObject().put("ok", datasets.delete(name)))
            section == "classes" && m == "PUT" ->
                Reply.json(datasets.setClasses(name, req.json().optJSONArray("classes") ?: JSONArray()))
            section == "images" && id.isEmpty() && m == "POST" -> addImage(name, req)
            section == "images" && id.isNotEmpty() && m == "GET" -> {
                val f = datasets.imageFile(name, id) ?: return notFound("missing image")
                Reply.file(f, if (f.extension == "png") "image/png" else "image/jpeg", temp = false)
            }
            section == "images" && id.isNotEmpty() && m == "DELETE" ->
                Reply.json(JSONObject().put("ok", datasets.deleteImage(name, id)))
            section == "labels" && id.isNotEmpty() && m == "GET" -> Reply.json(datasets.label(name, id))
            section == "labels" && id.isNotEmpty() && m == "PUT" -> Reply.json(datasets.saveLabel(name, id, req.json()))
            section == "export" && m == "GET" -> {
                val tmp = File.createTempFile("yolo", ".zip", context.cacheDir)
                try {
                    tmp.outputStream().use { datasets.exportYolo(name, it) }
                } catch (e: Exception) {
                    tmp.delete()
                    throw e
                }
                Reply.file(tmp, "application/zip", temp = true)
            }
            else -> notFound("not found")
        }
    }

    private fun addImage(name: String, req: Request): Reply {
        val bytes = req.body.bytes()
        val (data, ext) = if (DatasetStore.sniff(bytes) != null) {
            bytes to DatasetStore.sniff(bytes)!!
        } else {
            val json = try {
                JSONObject(String(bytes, Charsets.UTF_8))
            } catch (_: org.json.JSONException) {
                throw IllegalArgumentException("body must be a PNG/JPEG image or {\"snapshot\": id}")
            }
            val snap = json.optString("snapshot")
            val f = snapshots.file(snap) ?: return notFound("missing snapshot")
            f.readBytes() to "png"
        }
        val id = datasets.addImage(name, data, ext)
        return Reply.json(JSONObject().put("ok", true).put("id", id))
    }

    // ---- static pages ----

    private fun asset(p: String): Reply {
        val rel = if (p == "/tools" || p == "/tools/") "index.html" else p.removePrefix("/tools/ui/")
        require(rel.isNotEmpty() && !rel.split('/').any { it == ".." || it.isEmpty() }) { "invalid path" }
        val bytes = try {
            context.assets.open("tools/$rel").use { it.readBytes() }
        } catch (_: java.io.IOException) {
            return notFound("missing asset $rel")
        }
        return Reply(200, mime(rel), bytes)
    }

    private fun mime(name: String): String = when (name.substringAfterLast('.').lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        else -> "application/octet-stream"
    }

    private fun notFound(msg: String) = Reply.json(JSONObject().put("error", msg), 404)
}
