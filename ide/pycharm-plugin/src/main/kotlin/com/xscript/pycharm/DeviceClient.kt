package com.xscript.pycharm

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration

/** One file for PUT /projects/{name}/files. `encoding` is "utf-8" or "base64". */
data class UploadFile(val path: String, val content: String, val encoding: String)

data class LogEntry(val seq: Long, val ts: Double, val stream: String, val line: String)
data class Logs(val entries: List<LogEntry>, val next: Long)
data class RemoteFile(val path: String, val size: Long)

/** Non-2xx reply. `detail` is the device's own `error` text when the body is JSON, else the start of the body. */
class DeviceHttpException(val status: Int, val body: String) :
    RuntimeException("HTTP $status" + detailOf(body).let { if (it.isEmpty()) "" else ": $it" }) {
    val detail: String get() = detailOf(body)
    /** The device's "pairing required" reply. */
    val isPairing: Boolean get() = status == 401

    companion object {
        fun detailOf(body: String): String = try {
            val o = JsonParser.parseString(body).asJsonObject
            (o.get("error") ?: o.get("msg"))?.asString ?: body.take(200)
        } catch (_: Exception) {
            body.take(200)
        }
    }
}

/** "abcd-efgh" → "ABCDEFGH": the pairing code as the device compares it. */
fun normalizeCode(code: String?): String = (code ?: "").filter { it.isLetterOrDigit() && it.code < 128 }.uppercase()

/** Null when valid, else a message for the input dialog. */
fun validateCode(code: String?): String? =
    if (Regex("^[A-Z0-9]{8}$").matches(normalizeCode(code))) null else "8 letters or digits, e.g. ABCD-EFGH"

/**
 * Device HTTP client (protocol/openapi.yaml), the Kotlin twin of the VS Code extension's client.ts.
 * `token` is the pairing code shown on the phone (开发与连接 → 配对码); empty when pairing is off.
 * No IDE classes here, so it is tested against scripts/mock_device.py with plain JUnit.
 */
class DeviceClient(val target: DeviceTarget, private val timeoutMs: Long = 15000, var token: String = "") {
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofMillis(minOf(timeoutMs, 5000)))
        .proxy(HttpClient.Builder.NO_PROXY) // the phone is on the LAN / adb forward: never via a system proxy
        .build()
    private val gson = Gson()

    private fun send(method: String, route: String, query: Map<String, Any> = emptyMap(), json: Any? = null,
                     timeout: Long = timeoutMs, pass: Set<Int> = emptySet()): HttpResponse<ByteArray> {
        val qs = if (query.isEmpty()) "" else "?" + query.entries.joinToString("&") {
            enc(it.key) + "=" + enc(it.value.toString())
        }
        val b = HttpRequest.newBuilder(URI.create(target.baseUrl + route + qs))
            .timeout(Duration.ofMillis(timeout))
            .header("X-XScript-Client", "pycharm")
        if (token.isNotEmpty()) b.header("Authorization", "Bearer " + normalizeCode(token))
        val body = if (json == null) HttpRequest.BodyPublishers.noBody() else {
            b.header("Content-Type", "application/json")
            HttpRequest.BodyPublishers.ofString(gson.toJson(json), StandardCharsets.UTF_8)
        }
        val r = http.send(b.method(method, body).build(), HttpResponse.BodyHandlers.ofByteArray())
        if (r.statusCode() !in 200..299 && r.statusCode() !in pass) {
            throw DeviceHttpException(r.statusCode(), String(r.body(), StandardCharsets.UTF_8))
        }
        return r
    }

    private fun obj(method: String, route: String, query: Map<String, Any> = emptyMap(), json: Any? = null,
                    timeout: Long = timeoutMs, pass: Set<Int> = emptySet()): JsonObject =
        JsonParser.parseString(String(send(method, route, query, json, timeout, pass).body(), StandardCharsets.UTF_8)).asJsonObject

    fun status(timeout: Long = timeoutMs): JsonObject = obj("GET", "/status", timeout = timeout)

    fun listProjects(): List<String> =
        obj("GET", "/projects").getAsJsonArray("projects")?.map { it.asString } ?: emptyList()

    /** Batch upload; creates the project if needed. */
    fun uploadFiles(project: String, files: List<UploadFile>): JsonObject =
        obj("PUT", "/projects/${p(project)}/files", json = mapOf("files" to files), timeout = maxOf(timeoutMs, 120000))

    /** 404 and 409 (already running) come back as data with an `error`. */
    fun run(project: String): JsonObject = obj("POST", "/projects/${p(project)}/run", pass = setOf(404, 409))

    fun stop(project: String): JsonObject = obj("POST", "/projects/${p(project)}/stop")

    fun logs(since: Long = 0): Logs {
        val o = obj("GET", "/logs", query = mapOf("since" to since))
        val entries = o.getAsJsonArray("entries")?.map { gson.fromJson(it, LogEntry::class.java) } ?: emptyList()
        return Logs(entries, o.get("next")?.asLong ?: since)
    }

    /** Files of a project on the device; null when it does not exist (404). */
    fun projectFiles(project: String): List<RemoteFile>? {
        val r = send("GET", "/projects/${p(project)}/files", pass = setOf(404))
        if (r.statusCode() == 404) return null
        val o = JsonParser.parseString(String(r.body(), StandardCharsets.UTF_8)).asJsonObject
        return o.getAsJsonArray("files")?.map { gson.fromJson(it, RemoteFile::class.java) } ?: emptyList()
    }

    /** Latest log seq, so following shows only lines from the next run. */
    fun currentSeq(maxPages: Int = 100): Long {
        var since = 0L
        repeat(maxPages) {
            val r = logs(since)
            if (r.entries.isEmpty() || r.next == since) return since
            since = r.next
        }
        return since
    }

    private fun p(project: String) = enc(project).replace("+", "%20")
    private fun enc(s: String) = URLEncoder.encode(s, StandardCharsets.UTF_8)
}

/** Log-follow state: the next seq to ask for and how many polls in a row were quiet. */
class FollowState(var since: Long, var idle: Int = 0)

/**
 * One log-follow poll (same rule as client.ts followTick): writes new lines, advances `since`, and every third
 * quiet poll asks the device whether the script still runs. Returns false once it has finished.
 */
fun followTick(client: DeviceClient, state: FollowState, write: (String) -> Unit): Boolean {
    val r = client.logs(state.since)
    for (e in r.entries) write(if (e.line.endsWith("\n")) e.line else e.line + "\n")
    state.since = r.next // the device log may have been cleared (next < since): restart from its cursor
    state.idle = if (r.entries.isEmpty()) state.idle + 1 else 0
    if (state.idle > 0 && state.idle % 3 == 0) {
        val running = client.status(3000).get("running")
        if (running == null || !running.asBoolean) return false
    }
    return true
}
