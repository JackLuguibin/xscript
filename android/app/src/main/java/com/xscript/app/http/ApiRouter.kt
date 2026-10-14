package com.xscript.app.http

import android.content.Context
import android.graphics.Bitmap
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.net.NetworkInfo
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.Automation
import com.xscript.app.runtime.EvalRunner
import com.xscript.app.runtime.LogBuffer
import com.xscript.app.runtime.MainControl
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.runtime.DapTransport
import com.xscript.app.runtime.ScriptSupervisor
import com.xscript.app.schedule.Scheduler
import com.xscript.app.settings.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * Transport-independent request handling. Used by the LAN HTTP server and by the cloud
 * control WebSocket, so both expose the exact same API (see protocol/openapi.yaml).
 */
class ApiRouter(private val context: Context) {
    /**
     * Reply payload: in-memory [body], or a [file] streamed by the HTTP server (large zips,
     * raw file reads). [deleteFile] marks the file as a temp file owned by the reply.
     */
    class Reply(
        val status: Int,
        val mime: String,
        val body: ByteArray,
        val file: File? = null,
        val deleteFile: Boolean = false,
    ) {
        /** Whole payload in memory, for transports that cannot stream (cloud relay). */
        fun bytes(): ByteArray {
            val f = file ?: return body
            return try {
                f.readBytes()
            } finally {
                if (deleteFile) f.delete()
            }
        }

        companion object {
            fun json(obj: Any, status: Int = 200) =
                Reply(status, "application/json; charset=utf-8", obj.toString().toByteArray(Charsets.UTF_8))

            fun file(f: File, mime: String, temp: Boolean) = Reply(200, mime, ByteArray(0), f, temp)
        }
    }

    /** Request body: small bodies in memory, large uploads spooled to a temp file. */
    class Body private constructor(private val bytes: ByteArray?, private val file: File?) {
        val isEmpty: Boolean get() = (bytes?.isEmpty() ?: true) && (file?.length() ?: 0L) == 0L

        fun bytes(): ByteArray = bytes ?: file?.readBytes() ?: ByteArray(0)

        fun stream(): InputStream = file?.let { FileInputStream(it) } ?: bytes().inputStream()

        fun release() {
            file?.delete()
        }

        companion object {
            val EMPTY = Body(ByteArray(0), null)

            fun of(bytes: ByteArray) = Body(bytes, null)

            fun ofFile(file: File) = Body(null, file)
        }
    }

    class Request(
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val body: Body,
        val client: String = "",
        val remote: String = "",
    ) {
        fun json(): JSONObject {
            if (body.isEmpty) return JSONObject()
            val text = String(body.bytes(), Charsets.UTF_8)
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    private val store = ProjectStore(context)
    private val tools = com.xscript.app.tools.ToolsRouter(context)
    private val projectRoutes = ProjectRoutes(store)
    private val projectRoute = Regex("^/projects/([^/]+)(/.*)?$")

    fun handle(req: Request): Reply {
        if (req.client.isNotEmpty()) ClientTracker.touch(req.client, req.remote)
        return try {
            route(req)
        } catch (e: Exception) {
            errorReply(e)
        }
    }

    private fun route(req: Request): Reply {
        val m = req.method
        val p = req.path.trimEnd('/').ifEmpty { "/" }
        if (tools.handles(p)) return tools.route(req, if (req.path == "/tools/") "/tools/" else p)
        when {
            m == "GET" && p == "/" -> return home()
            m == "GET" && p == "/status" -> return Reply.json(MainControl.status(context))
            m == "GET" && p == "/debug/status" -> return Reply.json(DapTransport.status())
            m == "POST" && p == "/debug/connect" -> return Reply.json(DapTransport.connect())
            m == "POST" && p == "/debug/request" -> return Reply.json(DapTransport.send(req.json()))
            m == "GET" && p == "/debug/messages" -> return Reply.json(DapTransport.messages(
                req.query["since"]?.toLongOrNull() ?: 0L,
            ))
            m == "DELETE" && p == "/debug" -> {
                DapTransport.disconnect()
                return Reply.json(JSONObject().put("ok", true))
            }
            m == "GET" && p == "/screen" -> return screen(req)
            m == "GET" && p == "/ui-tree" -> return uiTree(req)
            m == "GET" && p == "/logs" -> return logs(req)
            m == "DELETE" && p == "/logs" -> {
                LogBuffer.clear(context)
                return Reply.json(JSONObject().put("ok", true))
            }
            m == "POST" && p == "/eval" -> return eval(req)
            m == "POST" && p == "/action" -> return action(req)
            m == "GET" && p == "/settings" -> return Reply.json(settings())
            m == "PUT" && p == "/settings" -> return putSettings(req)
            m == "GET" && p == "/projects" -> return Reply.json(
                JSONObject().put("projects", JSONArray(store.list())).put("details", store.describe()),
            )
            p == "/schedules" || p.startsWith("/schedules/") -> return schedules(req, m, p)
            p == "/models" || p.startsWith("/models/") -> return models(req, m, p)
            m == "GET" && p == "/packages" -> return pip(JSONObject().put("op", "list"), 20_000L)
            m == "POST" && p == "/packages" -> {
                val body = req.json()
                val req2 = JSONObject().put("op", body.optString("op", "install"))
                    .put("packages", body.optJSONArray("packages") ?: JSONArray())
                    .put("upgrade", body.optBoolean("upgrade"))
                    .put("index_url", body.optString("index_url"))
                return pip(req2, body.optLong("timeout_ms", 300_000L).coerceIn(5_000L, 900_000L))
            }
            m == "GET" && p == "/ascript/projects" -> return Reply.json(JSONObject().put("projects", JSONArray(store.ascriptProjects())))
            m == "POST" && p == "/ascript/import" -> {
                val name = req.json().optString("name")
                store.importAscript(name)
                return Reply.json(JSONObject().put("ok", true).put("project", name))
            }
        }
        val pm = projectRoute.matchEntire(p) ?: return Reply.json(JSONObject().put("error", "not found"), 404)
        val name = java.net.URLDecoder.decode(pm.groupValues[1], "UTF-8")
        val sub = pm.groupValues[2]
        projectRoutes.handle(m, name, sub, req)?.let { return it }
        return when {
            m == "DELETE" && sub.isEmpty() -> {
                if (RunState.current(context) == name) ScriptService.stop(context)
                Scheduler.forgetProject(context, name)
                Reply.json(JSONObject().put("ok", store.delete(name)))
            }
            m == "GET" && sub == "/config" -> Reply.json(MainControl.config(name))
            m == "PUT" && sub == "/config" -> {
                if (!store.exists(name)) return Reply.json(JSONObject().put("error", "missing project"), 404)
                val body = req.json()
                val patch = JSONObject().put("project", name)
                for (k in listOf("auto_run", "stop_re_run")) if (body.has(k)) patch.put(k, body.getBoolean(k))
                Reply.json(JSONObject(MainControl.handle("config_set", patch.toString())))
            }
            m == "PUT" && sub == "/zip" -> {
                req.body.stream().use { store.importZip(name, it, replace = req.query["replace"] != "false") }
                Reply.json(JSONObject().put("ok", true).put("project", name).put("files", store.files(name).length()))
            }
            m == "GET" && sub == "/zip" -> {
                if (!store.exists(name)) return Reply.json(JSONObject().put("error", "missing project"), 404)
                val tmp = File.createTempFile("export", ".zip", context.cacheDir)
                try {
                    tmp.outputStream().use { store.exportZip(name, it) }
                } catch (e: Exception) {
                    tmp.delete()
                    throw e
                }
                Reply.file(tmp, "application/zip", temp = true)
            }
            m == "POST" && sub == "/run" -> runProject(name)
            m == "POST" && sub == "/debug" -> runProject(name, debug = true)
            m == "POST" && sub == "/stop" -> {
                DapTransport.disconnect()
                ScriptService.stop(context)
                Reply.json(JSONObject().put("ok", true).put("running", false))
            }
            else -> Reply.json(JSONObject().put("error", "not found"), 404)
        }
    }

    companion object {
        /** Exception type → HTTP status: 404 missing, 400 invalid input, 409 conflict, else 500. */
        fun errorReply(e: Exception): Reply = when (e) {
            is NoSuchElementException -> Reply.json(JSONObject().put("error", e.message ?: "not found"), 404)
            is IllegalArgumentException -> Reply.json(JSONObject().put("error", e.message ?: "bad request"), 400)
            is IllegalStateException -> Reply.json(JSONObject().put("error", e.message ?: "conflict"), 409)
            else -> Reply.json(JSONObject().put("error", e.message ?: e.toString()), 500)
        }
    }

    private fun home(): Reply {
        val ip = NetworkInfo.localIp(context)
        val s = MainControl.status(context)
        val html = """
            <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
            <body style="font-family:sans-serif;background:#f4f5f7;color:#222;padding:16px">
            <h2>XScript</h2>
            <p>http://$ip:${NetworkInfo.PORT}</p>
            <p><a href="/tools/">开发工具：脚本 IDE · 图色工具 · 标注工具 · 投屏</a></p>
            <pre>${s.toString(2)}</pre>
            </body></html>
        """.trimIndent()
        return Reply(200, "text/html; charset=utf-8", html.toByteArray(Charsets.UTF_8))
    }

    private fun screen(req: Request): Reply {
        val bitmap = CaptureEngine.captureBitmap()
            ?: return Reply.json(JSONObject().put("error", "capture_unavailable"), 503)
        val fmt = req.query["format"].orEmpty()
        val quality = req.query["quality"]?.toIntOrNull()?.coerceIn(1, 100) ?: 80
        // Optional longest-side limit, for live remote control over 云控 (small JPEG frames).
        val max = req.query["max"]?.toIntOrNull()?.coerceIn(64, 4096)
        val w = bitmap.width
        val h = bitmap.height
        val scale = if (max != null) minOf(1.0, max.toDouble() / maxOf(w, h)) else 1.0
        val img = if (scale < 1.0) {
            Bitmap.createScaledBitmap(bitmap, (w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1), true)
        } else {
            bitmap
        }
        val bytes = ByteArrayOutputStream()
        val jpeg = fmt == "jpg" || fmt == "jpeg"
        img.compress(if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, if (jpeg) quality else 100, bytes)
        if (img !== bitmap) img.recycle()
        bitmap.recycle()
        return Reply(200, if (jpeg) "image/jpeg" else "image/png", bytes.toByteArray())
    }

    private fun uiTree(req: Request): Reply {
        if (!Automation.ready()) {
            return Reply.json(JSONObject().put("error", "no_channel: enable accessibility or root"), 503)
        }
        val mode = req.query["mode"]?.toIntOrNull() ?: 0
        return Reply.json(Automation.dumpTree(mode))
    }

    private fun logs(req: Request): Reply {
        val since = req.query["since"]?.toLongOrNull() ?: 0L
        val (entries, next) = LogBuffer.since(context, since)
        return Reply.json(LogBuffer.toJson(entries, next))
    }

    private fun runProject(name: String, debug: Boolean = false): Reply {
        if (!store.exists(name)) return Reply.json(JSONObject().put("error", "missing project"), 404)
        if (ScriptSupervisor.isBusy(context)) {
            return Reply.json(JSONObject().put("error", "already running").put("project", RunState.get(context)), 409)
        }
        Settings.lastProject = name
        DapTransport.disconnect()
        val refusal = ScriptService.run(context, name, debug = debug)
        if (refusal != null) return Reply.json(JSONObject().put("error", refusal), 403)
        val result = JSONObject().put("ok", true).put("running", true).put("project", name)
        if (debug) result.put("debug", JSONObject().put("port", 5678)
            .put("remote_root", store.dir(name).absolutePath))
        return Reply.json(result)
    }

    /** 定时任务: GET/POST /schedules, GET/PUT/DELETE /schedules/<id>, POST /schedules/<id>/run. */
    private fun schedules(req: Request, m: String, p: String): Reply {
        val sched = Scheduler.store(context)
        val parts = p.removePrefix("/schedules").trim('/').split('/').filter { it.isNotEmpty() }
        val now = System.currentTimeMillis()
        fun one(id: String): Reply {
            val s = sched.get(id) ?: return Reply.json(JSONObject().put("error", "missing schedule"), 404)
            return Reply.json(s.toJson())
        }
        if (parts.isEmpty()) {
            return when (m) {
                "GET" -> Reply.json(
                    JSONObject()
                        .put("schedules", JSONArray(sched.list(req.query["project"]).map { it.toJson() }))
                        .put("exact_alarms", Scheduler.canExact(context)),
                )
                "POST" -> {
                    val body = req.json()
                    require(store.exists(body.optString("project"))) { "missing project ${body.optString("project")}" }
                    val s = sched.add(body, now)
                    Scheduler.rearm(context)
                    one(s.id)
                }
                else -> Reply.json(JSONObject().put("error", "not found"), 404)
            }
        }
        val id = parts[0]
        return when {
            parts.size == 1 && m == "GET" -> one(id)
            parts.size == 1 && m == "PUT" -> {
                val body = req.json()
                if (body.has("project")) require(store.exists(body.getString("project"))) { "missing project ${body.getString("project")}" }
                sched.get(id) ?: return Reply.json(JSONObject().put("error", "missing schedule"), 404)
                sched.update(id, body, now)
                Scheduler.rearm(context)
                one(id)
            }
            parts.size == 1 && m == "DELETE" -> {
                val ok = sched.remove(id)
                if (ok) Scheduler.rearm(context)
                Reply.json(JSONObject().put("ok", ok))
            }
            parts.size == 2 && parts[1] == "run" && m == "POST" -> {
                sched.get(id) ?: return Reply.json(JSONObject().put("error", "missing schedule"), 404)
                Reply.json(JSONObject().put("result", Scheduler.runNow(context, id)))
            }
            else -> Reply.json(JSONObject().put("error", "not found"), 404)
        }
    }

    /** Model files for YOLO / PaddleOCR: GET /models, PUT/GET/DELETE /models/<path>. */
    private fun models(req: Request, m: String, p: String): Reply {
        val store = com.xscript.app.ml.ModelStore
        val rel = java.net.URLDecoder.decode(p.removePrefix("/models").trim('/'), "UTF-8")
        if (rel.isEmpty()) {
            if (m != "GET") return Reply.json(JSONObject().put("error", "not found"), 404)
            return Reply.json(JSONObject().put("dir", store.dir(context).absolutePath).put("models", store.list(context)))
        }
        return when (m) {
            "PUT" -> {
                val f = req.body.stream().use { store.write(context, rel, it) }
                Reply.json(JSONObject().put("ok", true).put("path", rel).put("size", f.length()))
            }
            "GET" -> {
                val f = store.file(context, rel)
                if (!f.isFile) Reply.json(JSONObject().put("error", "missing model"), 404)
                else Reply.file(f, "application/octet-stream", temp = false)
            }
            "DELETE" -> Reply.json(JSONObject().put("ok", store.delete(context, rel)))
            else -> Reply.json(JSONObject().put("error", "not found"), 404)
        }
    }

    /** GET /packages lists runtime-installed packages; POST installs / uninstalls (in :eval). */
    private fun pip(body: JSONObject, timeoutMs: Long): Reply {
        val result = EvalRunner.pip(body, timeoutMs)
        return when {
            result.optString("error") == "timeout" -> Reply.json(result, 408)
            !result.optBoolean("ok") -> Reply.json(result, 400)
            else -> Reply.json(result)
        }
    }

    private fun eval(req: Request): Reply {
        val body = req.json()
        val code = body.optString("code")
        val timeout = body.optLong("timeout_ms", 8000L).coerceIn(200L, 15_000L)
        val result = EvalRunner.run(code, timeout)
        val status = if (result.optString("error") == "timeout") 408 else 200
        return Reply.json(result, status)
    }

    /** Direct automation for remote control panels: {"type":"click","x":..,"y":..} etc. */
    private fun action(req: Request): Reply {
        val a = req.json()
        val ok = when (a.optString("type")) {
            "click" -> Automation.click(a.getInt("x"), a.getInt("y"), a.optInt("dur", 20))
            "swipe" -> Automation.swipe(a.getInt("x1"), a.getInt("y1"), a.getInt("x2"), a.getInt("y2"), a.optInt("dur", 300))
            "input" -> Automation.inputText(a.optString("text"))
            "key" -> Automation.globalAction(a.optString("name"))
            "node" -> Automation.nodeAction(a.getString("path"), a.optString("action", "click"), a.optString("arg"))
            else -> throw IllegalArgumentException("unknown action type")
        }
        return Reply.json(JSONObject().put("ok", ok))
    }

    private fun settings(): JSONObject = JSONObject()
        .put("run_mode", Settings.runMode)
        .put("float_on_run", Settings.floatOnRun)
        .put("keep_screen_on", Settings.keepScreenOn)
        .put("cloud_url", Settings.cloudUrl)

    private fun putSettings(req: Request): Reply {
        val a = req.json()
        if (a.has("run_mode")) {
            val mode = a.getString("run_mode")
            require(mode in setOf(Settings.MODE_AUTO, Settings.MODE_ACCESSIBILITY, Settings.MODE_ROOT)) { "bad run_mode" }
            Settings.runMode = mode
        }
        if (a.has("float_on_run")) Settings.floatOnRun = a.getBoolean("float_on_run")
        if (a.has("keep_screen_on")) Settings.keepScreenOn = a.getBoolean("keep_screen_on")
        return Reply.json(settings())
    }
}
