package com.xscript.app.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

/** One local debuggee. HTTP clients poll framed DAP messages without another LAN port. */
object DapTransport {
    private data class Record(val id: Long, val value: JSONObject, val bytes: Int)
    private var socket: Socket? = null
    private var epoch = 0L
    private var nextId = 0L
    private var bytes = 0
    private var error = ""
    private val records = ArrayDeque<Record>()

    /** debugpy's port in the script process; tests point it at a fake debuggee. */
    @Volatile internal var port = 5678

    @Synchronized
    fun connect(): JSONObject {
        check(socket == null) { "debugger already connected" }
        val s = Socket()
        try {
            s.connect(InetSocketAddress("127.0.0.1", port), 1500)
            s.tcpNoDelay = true
        } catch (e: Exception) {
            s.close()
            throw IllegalStateException("debugger not ready: ${e.message}")
        }
        socket = s
        error = ""
        records.clear()
        bytes = 0
        nextId = 0
        val generation = ++epoch
        thread(name = "xscript-dap", isDaemon = true) {
            try {
                val input = s.getInputStream()
                while (!s.isClosed) {
                    val value = DapFrames.read(input)
                    synchronized(this) {
                        if (epoch != generation) return@thread
                        val size = value.toString().toByteArray(Charsets.UTF_8).size
                        records.addLast(Record(++nextId, value, size))
                        bytes += size
                        while (records.size > 512 || bytes > 8 * 1024 * 1024) {
                            bytes -= records.removeFirst().bytes
                        }
                    }
                }
            } catch (e: Exception) {
                synchronized(this) {
                    if (epoch == generation) {
                        socket = null
                        error = if (e is EOFException) "" else e.message.orEmpty()
                    }
                }
            } finally {
                s.close()
            }
        }
        return JSONObject().put("ok", true).put("next", 0)
    }

    @Synchronized
    fun send(value: JSONObject): JSONObject {
        require(value.optString("type") == "request") { "DAP request required" }
        require(value.optInt("seq") > 0 && value.optString("command").isNotBlank()) { "invalid DAP request" }
        val s = socket ?: throw IllegalStateException("debugger disconnected")
        DapFrames.write(s.getOutputStream(), value)
        return JSONObject().put("ok", true)
    }

    @Synchronized
    fun messages(since: Long): JSONObject {
        require(since >= 0) { "invalid cursor" }
        val first = records.firstOrNull()?.id ?: (nextId + 1)
        return status().put("messages", JSONArray(records.filter { it.id > since }.map {
            JSONObject().put("id", it.id).put("message", it.value)
        })).put("next", nextId).put("dropped_before", first - 1)
    }

    @Synchronized
    fun status(): JSONObject = JSONObject().put("connected", socket != null)
        .put("port", port).put("error", error)

    @Synchronized
    fun disconnect() {
        ++epoch
        try { socket?.close() } finally { socket = null }
    }
}

/** Content-Length is UTF-8 bytes; header and payload may span any number of reads. */
internal object DapFrames {
    private const val MAX_FRAME = 4 * 1024 * 1024

    fun read(input: InputStream): JSONObject {
        val header = StringBuilder()
        while (!header.endsWith("\r\n\r\n")) {
            val c = input.read()
            if (c < 0) throw EOFException("DAP stream closed")
            require(c in 0..127 && header.length < 8192) { "invalid DAP header" }
            header.append(c.toChar())
        }
        val lengths = header.toString().split("\r\n").filter {
            it.substringBefore(':').equals("Content-Length", ignoreCase = true)
        }
        require(lengths.size == 1) { "one Content-Length required" }
        val length = lengths.single().substringAfter(':', "").trim().toIntOrNull()
            ?: throw IllegalArgumentException("invalid Content-Length")
        require(length in 1..MAX_FRAME) { "DAP frame too large or empty" }
        val body = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val n = input.read(body, offset, length - offset)
            if (n < 0) throw EOFException("truncated DAP frame")
            if (n == 0) continue
            offset += n
        }
        return JSONObject(String(body, Charsets.UTF_8))
    }

    fun write(output: OutputStream, value: JSONObject) {
        val body = value.toString().toByteArray(Charsets.UTF_8)
        require(body.size in 1..MAX_FRAME) { "DAP frame too large or empty" }
        output.write("Content-Length: ${body.size}\r\n\r\n".toByteArray(Charsets.US_ASCII))
        output.write(body)
        output.flush()
    }
}
