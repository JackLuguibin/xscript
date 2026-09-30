package com.xscript.app.cloud

import android.content.Context
import android.os.Build
import android.provider.Settings as AndroidSettings
import android.util.Base64
import com.xscript.app.XscriptApp
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.events.EventHub
import com.xscript.app.http.ApiRouter
import com.xscript.app.license.LicenseManager
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.Automation
import com.xscript.app.runtime.MainControl
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.settings.Settings
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 云端控制: the device dials out to a control server over WebSocket (works behind NAT).
 *
 * Two command styles share the connection (see docs/CLOUD.md):
 *
 * XScript relay: the full device HTTP API through [ApiRouter].
 *   device → server  {"type":"hello","device_id":..,"group":..,"device":{...status}}
 *   server → device  {"type":"request","id":"1","method":"GET","path":"/status","query":{},"body":"<base64>"}
 *   device → server  {"type":"response","id":"1","status":200,"mime":"...","body":"<base64>"}
 *   server → device  {"type":"message","data":...}           → scripts (cloud.on_message / system.channel)
 *   device → server  {"type":"data","data":{...}}            ← scripts (cloud.send / cloud_control.send)
 *   device → server  {"type":"status","device":{...}}        on run start / stop and every 60 s
 *
 * AScript commands (frames with "path"; replies echo "path", "id" and "seq"):
 *   device_info, app_run {id, param, card}, app_stop, screen_shot {max, quality},
 *   device_action {action: click x/y | swipe ori | key ori}, app_list, message {data}
 *   reply {"path", "seq"?, "id"?, "code": 1 | -1, "msg": "success" | error, "device_id", "result"?}
 *   "seq" is an optional correlation id for servers that send several commands at once.
 *
 * Auth is the server's job (for example a token in the URL); the device only dials out.
 */
object CloudClient {
    enum class State { OFF, CONNECTING, CONNECTED, ERROR }

    @Volatile
    var state: State = State.OFF
        private set

    @Volatile
    var lastError: String = ""
        private set

    private var socket: WebSocket? = null
    private var router: ApiRouter? = null
    private val worker = Executors.newFixedThreadPool(2)
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private var wanted = false

    private val http = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    init {
        timer.scheduleAtFixedRate({ if (state == State.CONNECTED) pushStatus() }, 60, 60, TimeUnit.SECONDS)
    }

    /** Stable per-device id (ANDROID_ID: survives reinstalls of the same signed app). */
    fun deviceId(context: Context = XscriptApp.instance): String =
        AndroidSettings.Secure.getString(context.contentResolver, AndroidSettings.Secure.ANDROID_ID).orEmpty()
            .ifEmpty { "android-" + (Build.SERIAL ?: "unknown") }

    fun autoConnect(context: Context) {
        if (Settings.cloudUrl.isNotEmpty()) connect(context, Settings.cloudUrl)
    }

    @Synchronized
    fun connect(context: Context, url: String) {
        disconnect()
        val u = url.trim()
        require(u.startsWith("ws://") || u.startsWith("wss://")) { "cloud url must start with ws:// or wss://" }
        Settings.cloudUrl = u
        router = ApiRouter(context.applicationContext)
        wanted = true
        open(context.applicationContext, u)
    }

    @Synchronized
    fun disconnect() {
        wanted = false
        socket?.close(1000, "bye")
        socket = null
        state = State.OFF
    }

    fun forget() {
        disconnect()
        Settings.cloudUrl = ""
    }

    private fun open(context: Context, url: String) {
        state = State.CONNECTING
        val req = Request.Builder().url(url)
            .header("X-XScript-Device", Build.MODEL ?: "android")
            .header("X-XScript-Device-Id", deviceId(context))
            .build()
        socket = http.newWebSocket(req, Listener(context, url))
    }

    private fun scheduleRetry(context: Context, url: String) {
        if (!wanted) return
        timer.schedule({
            synchronized(this) {
                if (wanted && state != State.CONNECTED && state != State.CONNECTING) open(context, url)
            }
        }, 5, TimeUnit.SECONDS)
    }

    // ------------------------------------------------------------------ outgoing

    private fun send(obj: JSONObject): Boolean {
        val s = socket ?: return false
        if (state != State.CONNECTED) return false
        return s.send(obj.toString())
    }

    private fun identity(context: Context): JSONObject = JSONObject()
        .put("device_id", deviceId(context))
        .put("group", Settings.cloudGroup)
        .put("app", context.packageName)
        .put("device", MainControl.status(context))

    /** Script data for the dashboard (AScript cloud_control.send / Control.send). */
    fun sendData(data: Any): Boolean = send(JSONObject().put("type", "data").put("device_id", deviceId()).put("data", data))

    /** Run started / finished, and a periodic heartbeat. */
    fun pushStatus() {
        if (state != State.CONNECTED) return
        worker.execute { send(identity(XscriptApp.instance).put("type", "status")) }
    }

    fun status(): JSONObject = JSONObject()
        .put("state", state.name.lowercase())
        .put("url", Settings.cloudUrl)
        .put("device_id", deviceId())
        .put("group", Settings.cloudGroup)
        .put("error", lastError)

    // ------------------------------------------------------------------ incoming

    private class Listener(val context: Context, val url: String) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            state = State.CONNECTED
            lastError = ""
            webSocket.send(identity(context).put("type", "hello").toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = try {
                JSONObject(text)
            } catch (_: Exception) {
                return
            }
            when {
                msg.optString("type") == "request" -> worker.execute { relay(webSocket, msg) }
                msg.optString("type") == "message" -> deliver(msg.opt("data"))
                msg.has("path") -> worker.execute {
                    val reply = try {
                        command(context, msg)
                    } catch (t: Throwable) {
                        fail(msg, t.message ?: t.toString())
                    }
                    webSocket.send(reply.toString())
                }
            }
        }

        private fun relay(webSocket: WebSocket, msg: JSONObject) {
            val id = msg.optString("id")
            val queryObj = msg.optJSONObject("query") ?: JSONObject()
            val query = HashMap<String, String>()
            queryObj.keys().forEach { k -> query[k] = queryObj.optString(k) }
            val body = msg.optString("body").takeIf { it.isNotEmpty() }?.let { Base64.decode(it, Base64.DEFAULT) } ?: ByteArray(0)
            val reply = router?.handle(
                ApiRouter.Request(msg.optString("method", "GET"), msg.optString("path", "/"), query, ApiRouter.Body.of(body), "cloud", ""),
            ) ?: ApiRouter.Reply.json(JSONObject().put("error", "not ready"), 503)
            webSocket.send(
                JSONObject()
                    .put("type", "response")
                    .put("id", id)
                    .put("status", reply.status)
                    .put("mime", reply.mime)
                    .put("body", Base64.encodeToString(reply.bytes(), Base64.NO_WRAP))
                    .toString(),
            )
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (state != State.OFF) state = State.ERROR
            lastError = "closed $code $reason"
            scheduleRetry(context, url)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (state != State.OFF) state = State.ERROR
            lastError = t.message ?: t.toString()
            scheduleRetry(context, url)
        }
    }

    /** Server message → the running script's `cloud` event handlers. */
    private fun deliver(data: Any?) {
        EventHub.cloudMessage(data ?: JSONObject.NULL)
    }

    /** Reply skeleton. "seq" (server correlation id) is echoed; "id" is AScript's program id. */
    private fun base(msg: JSONObject, ok: Boolean, text: String): JSONObject {
        val out = JSONObject()
            .put("path", msg.optString("path"))
            .put("code", if (ok) 1 else -1)
            .put("msg", text)
            .put("device_id", deviceId())
        if (msg.has("seq")) out.put("seq", msg.get("seq"))
        if (msg.has("id")) out.put("id", msg.get("id"))
        return out
    }

    private fun ok(msg: JSONObject) = base(msg, true, "success")

    private fun fail(msg: JSONObject, error: String) = base(msg, false, error)

    /** AScript-style command frames. */
    internal fun command(context: Context, msg: JSONObject): JSONObject {
        return when (msg.optString("path")) {
            "device_info" -> ok(msg).put("result", deviceInfo(context))
            "app_list" -> ok(msg).put("result", JSONArray(ProjectStore(context).list()))
            "app_run" -> {
                val project = msg.optString("id").ifEmpty { msg.optString("project") }
                if (!ProjectStore(context).exists(project)) return fail(msg, "missing project $project")
                val card = msg.optString("card")
                if (card.isNotEmpty() && LicenseManager.required()) {
                    val res = LicenseManager.activate(context, card)
                    if (!res.ok) return fail(msg, "license: ${res.message}")
                }
                if (RunState.current(context) != null) {
                    // AScript restarts the program on app_run; stop first and start when it is gone.
                    ScriptService.stop(context)
                    waitStopped(context)
                }
                val params = msg.optJSONObject("param") ?: msg.optJSONObject("params") ?: JSONObject()
                val gate = ScriptService.run(context, project, params = params.toString())
                if (gate != null) fail(msg, gate) else ok(msg)
            }
            "app_stop" -> {
                if (RunState.current(context) == null) return fail(msg, "not running")
                ScriptService.stop(context)
                ok(msg)
            }
            "screen_shot" -> screenShot(msg)
            "device_action" -> deviceAction(msg)
            "message" -> {
                deliver(msg.opt("data"))
                ok(msg)
            }
            else -> {
                // Unknown paths are custom commands for the running script.
                deliver(msg)
                fail(msg, "unknown command, forwarded to script")
            }
        }
    }

    private fun waitStopped(context: Context) {
        val deadline = System.currentTimeMillis() + 5000
        while (RunState.scriptProcessAlive(context) && System.currentTimeMillis() < deadline) Thread.sleep(100)
        Thread.sleep(300)
    }

    private fun deviceInfo(context: Context): JSONObject {
        val running = RunState.current(context)
        return JSONObject()
            .put("device_version", XscriptApp.versionName(context))
            .put("device_name", (Build.BRAND ?: "") + (Build.MODEL ?: ""))
            .put("app_is_run", running != null)
            .put("app_is_line", false)
            .put("app_id", running.orEmpty())
            .put("username", Settings.cloudUrl)
            .put("device_id", deviceId(context))
            .put("group", Settings.cloudGroup)
            .put("license", LicenseManager.status(context))
    }

    private fun screenShot(msg: JSONObject): JSONObject {
        val bmp = CaptureEngine.captureBitmap() ?: return fail(msg, "capture unavailable")
        val max = msg.optDouble("max", 300.0).toInt().coerceIn(64, 4096)
        val quality = msg.optDouble("quality", 20.0).toInt().coerceIn(10, 100)
        val w = bmp.width
        val h = bmp.height
        val s = minOf(1.0, max.toDouble() / maxOf(w, h))
        val scaled = if (s < 1.0) android.graphics.Bitmap.createScaledBitmap(bmp, (w * s).toInt().coerceAtLeast(1), (h * s).toInt().coerceAtLeast(1), true) else bmp
        val out = ByteArrayOutputStream()
        scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, out)
        if (scaled !== bmp) scaled.recycle()
        bmp.recycle()
        return ok(msg)
            .put("max", max)
            .put("quality", quality)
            .put(
                "result",
                JSONObject()
                    .put("s_size", JSONArray(listOf(w, h)))
                    .put("r_size", JSONArray(listOf((w * s).toInt(), (h * s).toInt())))
                    .put("scale", s < 1.0)
                    .put("image", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)),
            )
    }

    private fun deviceAction(msg: JSONObject): JSONObject {
        val m = XscriptApp.instance.resources.displayMetrics
        val w = m.widthPixels
        val h = m.heightPixels
        val action = msg.optString("action")
        val ok = when (action) {
            "click" -> Automation.click(msg.optDouble("x").toInt(), msg.optDouble("y").toInt(), 20)
            "swipe" -> when (msg.optString("ori")) {
                "left" -> Automation.swipe(w * 4 / 5, h / 2, w / 5, h / 2, 300)
                "right" -> Automation.swipe(w / 5, h / 2, w * 4 / 5, h / 2, 300)
                "top" -> Automation.swipe(w / 2, h * 3 / 4, w / 2, h / 4, 300)
                "bottom" -> Automation.swipe(w / 2, h / 4, w / 2, h * 3 / 4, 300)
                else -> return fail(msg, "ori must be left/right/top/bottom")
            }
            "key" -> Automation.globalAction(msg.optString("ori").ifEmpty { msg.optString("key") })
            else -> return fail(msg, "unknown action $action")
        }
        val out = if (ok) ok(msg) else fail(msg, "action failed")
        for (k in listOf("action", "x", "y", "ori")) if (msg.has(k)) out.put(k, msg.get(k))
        return out
    }

    fun label(): String = when (state) {
        State.OFF -> if (Settings.cloudUrl.isEmpty()) "未连接" else "已断开"
        State.CONNECTING -> "连接中"
        State.CONNECTED -> "已连接"
        State.ERROR -> "重连中"
    }
}
