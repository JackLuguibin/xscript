package com.xscript.app.cloud

import android.content.Context
import android.os.Build
import android.util.Base64
import com.xscript.app.http.ApiRouter
import com.xscript.app.runtime.MainControl
import com.xscript.app.settings.Settings
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 云端控制: the device dials out to a control server over WebSocket and serves the same
 * API as the LAN HTTP server through it. Works behind NAT without port forwarding.
 *
 * Wire protocol (JSON text frames):
 *   device → server  {"type":"hello","device":{...status}}
 *   server → device  {"type":"request","id":"1","method":"GET","path":"/status","query":{},"body":"<base64>"}
 *   device → server  {"type":"response","id":"1","status":200,"mime":"...","body":"<base64>"}
 *
 * The URL may carry a token (wss://host/ws?token=...); the server is responsible for auth.
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
    private val retry = Executors.newSingleThreadScheduledExecutor()
    private var wanted = false

    private val http = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

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
        val req = Request.Builder().url(url).header("X-XScript-Device", Build.MODEL ?: "android").build()
        socket = http.newWebSocket(req, Listener(context, url))
    }

    private fun scheduleRetry(context: Context, url: String) {
        if (!wanted) return
        retry.schedule({
            synchronized(this) {
                if (wanted && state != State.CONNECTED && state != State.CONNECTING) open(context, url)
            }
        }, 5, TimeUnit.SECONDS)
    }

    private class Listener(val context: Context, val url: String) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            state = State.CONNECTED
            lastError = ""
            webSocket.send(JSONObject().put("type", "hello").put("device", MainControl.status(context)).toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = try {
                JSONObject(text)
            } catch (_: Exception) {
                return
            }
            if (msg.optString("type") != "request") return
            worker.execute {
                val id = msg.optString("id")
                val queryObj = msg.optJSONObject("query") ?: JSONObject()
                val query = HashMap<String, String>()
                queryObj.keys().forEach { k -> query[k] = queryObj.optString(k) }
                val body = msg.optString("body").takeIf { it.isNotEmpty() }?.let { Base64.decode(it, Base64.DEFAULT) } ?: ByteArray(0)
                val reply = router?.handle(
                    ApiRouter.Request(
                        msg.optString("method", "GET"),
                        msg.optString("path", "/"),
                        query,
                        ApiRouter.Body.of(body),
                        "cloud",
                        "",
                    ),
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

    fun label(): String = when (state) {
        State.OFF -> if (Settings.cloudUrl.isEmpty()) "未连接" else "已断开"
        State.CONNECTING -> "连接中"
        State.CONNECTED -> "已连接"
        State.ERROR -> "重连中"
    }
}
