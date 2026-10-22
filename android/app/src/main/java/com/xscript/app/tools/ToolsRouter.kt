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
 *   GET  /website/src/{screen,label}.html  AScript URL aliases for 图色工具 / 标注工具
 *   POST /tools/snapshots                freeze the current screen → {id, width, height, url};
 *                                        with a PNG body, store that image as a snapshot instead
 *   GET  /tools/snapshots                recent snapshots
 *   DELETE /tools/snapshots[/<id>]       delete one snapshot, or all of them
 *   GET  /tools/snapshots/<id>.png       snapshot image
 *   POST /tools/snapshots/<id>/crop      save a region into a project (res/img/...)
 *   POST /tools/vision                   pixel / find_colors / compare_colors / count_color / find_color_blobs /
 *                                        dominant_colors / find_image / ocr / yolo
 *   /tools/datasets/...                  标注 datasets, see [datasets]
 *
 * The MJPEG 投屏 stream (`GET /screen/stream`) needs a streaming response, so it lives
 * in the HTTP server itself.
 */
class ToolsRouter(private val context: Context) {
    private val snapshots = SnapshotStore(File(context.filesDir, "tools/snapshots"))
    private val datasets = DatasetStore(File(context.getExternalFilesDir(null), "datasets"))
    private val projects = ProjectStore(context)

    fun handles(path: String) = path == "/tools" || path.startsWith("/tools/") || path in WEBSITE_ALIASES

    fun route(req: Request, p: String): Reply {
        val m = req.method
        WEBSITE_ALIASES[p]?.let { if (m == "GET") return asset("/tools/ui/$it", req.ifNoneMatch) }
        return when {
            m == "GET" && p == "/tools/ui/combo.js" -> combo(req.query["f"].orEmpty(), req.ifNoneMatch)
            m == "GET" && (p == "/tools" || p == "/tools/" || p.startsWith("/tools/ui/")) -> asset(p, req.ifNoneMatch)
            m == "GET" && p == "/tools/snapshots" -> Reply.json(JSONObject().put("snapshots", snapshots.list()))
            m == "POST" && p == "/tools/snapshots" ->
                if (req.body.isEmpty) snapshot() else Reply.json(snapshots.saveUpload(req.body.bytes()))
            m == "DELETE" && p == "/tools/snapshots" -> Reply.json(JSONObject().put("ok", true).put("deleted", snapshots.clear()))
            m == "DELETE" && p.startsWith("/tools/snapshots/") ->
                Reply.json(JSONObject().put("ok", snapshots.delete(p.removePrefix("/tools/snapshots/").removeSuffix(".png"))))
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
        val templateSnap = body.optString("template_snapshot")
        if (templateSnap.isNotEmpty()) {
            // Template = template_rect cut from another snapshot (the web tool keeps crops across tabs).
            val f = snapshots.file(templateSnap) ?: return notFound("missing template snapshot")
            req.put("template_path", f.absolutePath)
            req.remove("template_snapshot")
        } else if (template.isNotEmpty()) {
            val project = template.substringBefore(':')
            val rel = template.substringAfter(':', "")
            require(projects.exists(project) && rel.isNotEmpty()) { "template must be <project>:<path>" }
            val f = projects.readFile(project, rel)
            require(f.isFile) { "missing template $template" }
            req.put("template_path", f.absolutePath)
            req.remove("template")
        }
        val model = body.optString("model")
        if (model.isNotEmpty()) {
            // "<project>:res/best.onnx" or a path under the shared model directory.
            val f = if (model.contains(':')) {
                val project = model.substringBefore(':')
                require(projects.exists(project)) { "missing project $project" }
                projects.readFile(project, model.substringAfter(':'))
            } else {
                com.xscript.app.ml.ModelStore.file(context, model)
            }
            require(f.isFile) { "missing model $model" }
            req.put("model", f.absolutePath)
        }
        // Model ops load (and PaddleOCR may download) models on the first call.
        val heavy = body.optString("op") == "yolo" || body.optString("engine").let { it.startsWith("paddle") || it == "auto" }
        val timeout = body.optLong("timeout_ms", if (heavy) 60_000L else 12_000L).coerceIn(500L, if (heavy) 120_000L else 20_000L)
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
    //   POST   /tools/datasets/<name>/rename           {"to": "new_name"}
    //   PUT    /tools/datasets/<name>/classes          {"classes": [...]}
    //   DELETE /tools/datasets/<name>/classes/<index>  drop a class and its boxes, shift later indices
    //   POST   /tools/datasets/<name>/images           body = PNG/JPEG bytes, or {"snapshot": id}
    //   GET    /tools/datasets/<name>/images/<id>      image bytes
    //   DELETE /tools/datasets/<name>/images/<id>
    //   GET    /tools/datasets/<name>/labels/<id>      {"width","height","boxes":[{"cls","rect"}]}
    //   PUT    /tools/datasets/<name>/labels/<id>
    //   DELETE /tools/datasets/<name>/labels/<id>      back to unlabelled
    //   GET    /tools/datasets/<name>/export           YOLO zip (images/, labels/, data.yaml)

    private val datasetRoute = Regex("^/tools/datasets/([^/]+)(?:/(classes|images|labels|export|rename)(?:/([^/]+))?)?$")

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
            section == "rename" && m == "POST" -> Reply.json(datasets.rename(name, req.json().optString("to").trim()))
            section == "classes" && id.isEmpty() && m == "PUT" ->
                Reply.json(datasets.setClasses(name, req.json().optJSONArray("classes") ?: JSONArray()))
            section == "classes" && id.isNotEmpty() && m == "DELETE" -> {
                val index = id.toIntOrNull() ?: throw IllegalArgumentException("class index must be a number")
                Reply.json(datasets.deleteClass(name, index))
            }
            section == "images" && id.isEmpty() && m == "POST" -> addImage(name, req)
            section == "images" && id.isNotEmpty() && m == "GET" -> {
                val f = datasets.imageFile(name, id) ?: return notFound("missing image")
                Reply.file(f, if (f.extension == "png") "image/png" else "image/jpeg", temp = false)
            }
            section == "images" && id.isNotEmpty() && m == "DELETE" ->
                Reply.json(JSONObject().put("ok", datasets.deleteImage(name, id)))
            section == "labels" && id.isNotEmpty() && m == "GET" -> Reply.json(datasets.label(name, id))
            section == "labels" && id.isNotEmpty() && m == "PUT" -> Reply.json(datasets.saveLabel(name, id, req.json()))
            section == "labels" && id.isNotEmpty() && m == "DELETE" ->
                Reply.json(JSONObject().put("ok", datasets.deleteLabel(name, id)))
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

    /**
     * Assets only change when the app is installed again, so the install time is their version: a reload whose
     * If-None-Match still names it gets a 304 instead of the file (no read, no gzip, no transfer).
     */
    private val assetTag: String by lazy {
        val installed = try { context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime } catch (_: Exception) { System.currentTimeMillis() }
        "\"xs-" + java.lang.Long.toString(installed, 36) + "\""
    }

    private fun asset(p: String, ifNoneMatch: String? = null): Reply {
        val rel = if (p == "/tools" || p == "/tools/") "index.html" else p.removePrefix("/tools/ui/")
        require(rel.isNotEmpty() && !rel.split('/').any { it == ".." || it.isEmpty() }) { "invalid path" }
        if (etagMatches(ifNoneMatch, assetTag)) return Reply(304, mime(rel), ByteArray(0), etag = assetTag)
        val bytes = try {
            context.assets.open("tools/$rel").use { it.readBytes() }
        } catch (_: java.io.IOException) {
            return notFound("missing asset $rel")
        }
        return Reply(200, mime(rel), bytes, etag = assetTag)
    }

    /** Built combos by their `f=` list (pages use a fixed handful; assets only change with the app). */
    private val combos = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()

    /**
     * `GET /tools/ui/combo.js?f=a.js,b.js`: the page's scripts joined in order, in one response. Over HTTP/1.1 the
     * browser opens about six connections, so 17 separate scripts took several round trips on Wi-Fi each time the
     * Web IDE opened (even when all were 304). Same ETag as the files themselves.
     */
    private fun combo(f: String, ifNoneMatch: String?): Reply {
        val names = comboNames(f) ?: return Reply.json(JSONObject().put("error", "invalid combo"), 400)
        if (etagMatches(ifNoneMatch, assetTag)) return Reply(304, mime("combo.js"), ByteArray(0), etag = assetTag)
        val bytes = combos[f] ?: run {
            val out = java.io.ByteArrayOutputStream()
            try {
                names.forEachIndexed { i, n ->
                    if (i > 0) out.write("\n;\n".toByteArray())
                    out.write("/* ---- $n ---- */\n".toByteArray())
                    context.assets.open("tools/$n").use { it.copyTo(out) }
                }
            } catch (_: java.io.IOException) {
                return notFound("missing asset in combo")
            }
            out.write('\n'.code)
            out.toByteArray().also { if (combos.size < 16) combos[f] = it }
        }
        return Reply(200, mime("combo.js"), bytes, etag = assetTag)
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

    companion object {
        private val COMBO_NAME = Regex("""[A-Za-z0-9_][A-Za-z0-9_.-]*\.js""")

        /** The `f=` list of a combo: plain .js names (no paths), each once, at most 40; null when invalid. */
        fun comboNames(f: String): List<String>? {
            val names = f.split(',')
            if (f.isEmpty() || names.size > 40 || names.toSet().size != names.size) return null
            return names.takeIf { it.all { n -> COMBO_NAME.matches(n) } }
        }

        /** If-None-Match names [tag] (a list, weak `W/` forms and `*` included). */
        fun etagMatches(ifNoneMatch: String?, tag: String): Boolean =
            ifNoneMatch != null && ifNoneMatch.split(',').map { it.trim() }.any { it == "*" || it.removePrefix("W/") == tag }

        /**
         * AScript's tool URLs, so bookmarks such as /website/src/screen.html?plug=FindColors open the
         * matching XScript page. Pages load their scripts from absolute /tools/ui/ paths.
         */
        val WEBSITE_ALIASES = mapOf(
            "/website/src/screen.html" to "color.html",
            "/website/src/label.html" to "label.html",
            "/website/src/editor.html" to "editor.html",
        )
    }
}
