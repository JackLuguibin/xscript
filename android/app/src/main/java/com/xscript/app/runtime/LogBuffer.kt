package com.xscript.app.runtime

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * Cross-process run log (JSON lines + sequence file, guarded by a file lock).
 * Rotates once it passes [MAX_BYTES] so long-running scripts cannot fill storage.
 */
object LogBuffer {
    data class Entry(val seq: Long, val ts: Long, val stream: String, val line: String)

    private const val MAX_BYTES = 2L * 1024 * 1024
    private const val KEEP_BYTES = 512L * 1024

    fun append(context: Context, stream: String, line: String) {
        val files = files(context)
        files.dir.mkdirs()
        RandomAccessFile(files.log, "rw").use { raf ->
            val lock = raf.channel.lock()
            try {
                val seq = nextSeq(files.seq)
                val obj = JSONObject()
                    .put("seq", seq)
                    .put("ts", System.currentTimeMillis())
                    .put("stream", stream)
                    .put("line", line)
                raf.seek(raf.length())
                raf.write((obj.toString() + "\n").toByteArray(Charsets.UTF_8))
                if (raf.length() > MAX_BYTES) rotate(raf)
            } finally {
                lock.release()
            }
        }
    }

    /** Keep only the tail of the file, starting at a line boundary. */
    private fun rotate(raf: RandomAccessFile) {
        val len = raf.length()
        val start = len - KEEP_BYTES
        val tail = ByteArray(KEEP_BYTES.toInt())
        raf.seek(start)
        raf.readFully(tail)
        val nl = tail.indexOf('\n'.code.toByte())
        val keep = if (nl >= 0) tail.copyOfRange(nl + 1, tail.size) else tail
        raf.setLength(0)
        raf.seek(0)
        raf.write(keep)
    }

    fun clear(context: Context) {
        val files = files(context)
        if (!files.log.exists()) return
        RandomAccessFile(files.log, "rw").use { raf ->
            val lock = raf.channel.lock()
            try {
                raf.setLength(0)
            } finally {
                lock.release()
            }
        }
    }

    fun since(context: Context, since: Long, limit: Int = 2000): Pair<List<Entry>, Long> {
        val files = files(context)
        if (!files.log.exists()) return emptyList<Entry>() to since
        val entries = ArrayDeque<Entry>()
        var next = since
        files.log.forEachLine(Charsets.UTF_8) { line ->
            if (line.isBlank()) return@forEachLine
            val obj = try {
                JSONObject(line)
            } catch (_: Exception) {
                return@forEachLine
            }
            val seq = obj.optLong("seq")
            if (seq > since) {
                entries.addLast(Entry(seq, obj.optLong("ts"), obj.optString("stream"), obj.optString("line")))
                if (entries.size > limit) entries.removeFirst()
            }
            if (seq > next) next = seq
        }
        // Sequence reset (log cleared on another install): restart from zero.
        if (next < since && entries.isEmpty()) next = 0
        return entries.toList() to next
    }

    fun toJson(entries: List<Entry>, next: Long): JSONObject {
        val arr = JSONArray()
        entries.forEach { e ->
            arr.put(
                JSONObject()
                    .put("seq", e.seq)
                    .put("ts", e.ts)
                    .put("stream", e.stream)
                    .put("line", e.line),
            )
        }
        return JSONObject().put("entries", arr).put("next", next)
    }

    private fun nextSeq(seqFile: File): Long {
        val current = if (seqFile.exists()) seqFile.readText().trim().toLongOrNull() ?: 0L else 0L
        val next = current + 1
        seqFile.writeText(next.toString())
        return next
    }

    private fun files(context: Context): Paths {
        val dir = File(context.filesDir, "logs")
        return Paths(dir, File(dir, "runtime.jsonl"), File(dir, "seq"))
    }

    private data class Paths(val dir: File, val log: File, val seq: File)
}
