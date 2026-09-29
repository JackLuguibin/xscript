package com.xscript.app.runtime

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * Cross-process run log (JSON lines + sequence file, guarded by a file lock).
 * Rotates once it passes [MAX_BYTES] so long-running scripts cannot fill storage.
 *
 * File locks only exclude other processes; within one process a second
 * `FileChannel.lock()` throws instead of blocking, so [jvmLock] serialises threads first
 * (the script process appends from several Python threads).
 */
object LogBuffer {
    data class Entry(val seq: Long, val ts: Long, val stream: String, val line: String)

    private const val MAX_BYTES = 2L * 1024 * 1024
    private const val KEEP_BYTES = 512L * 1024
    private const val CHUNK = 64 * 1024

    private val jvmLock = Any()

    fun append(context: Context, stream: String, line: String) {
        val files = files(context)
        files.dir.mkdirs()
        synchronized(jvmLock) {
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
        synchronized(jvmLock) {
            RandomAccessFile(files.log, "rw").use { raf ->
                val lock = raf.channel.lock()
                try {
                    raf.setLength(0)
                } finally {
                    lock.release()
                }
            }
        }
    }

    fun since(context: Context, since: Long, limit: Int = 2000): Pair<List<Entry>, Long> {
        val log = files(context).log
        if (!log.exists()) return emptyList<Entry>() to since
        synchronized(jvmLock) {
            RandomAccessFile(log, "rw").use { raf ->
                // Shared lock: readers never see a half-rotated file.
                val lock = raf.channel.lock(0L, Long.MAX_VALUE, true)
                try {
                    return readTail(raf, since, limit)
                } finally {
                    lock.release()
                }
            }
        }
    }

    /**
     * Entries with seq > [since], oldest first, at most [limit] (the newest ones), plus the
     * cursor for the next call. Scans backwards from the end of the file and stops at the
     * first entry the caller already has, so a poll costs O(new entries), not O(file).
     *
     * If the newest seq is below [since], the sequence was reset (app data cleared) and the
     * caller gets the latest entries as if it had asked with since = 0.
     */
    internal fun readTail(raf: RandomAccessFile, since: Long, limit: Int): Pair<List<Entry>, Long> {
        val newestFirst = ArrayList<Entry>()
        var newest = -1L
        var floor = since

        /** Returns false once scanning can stop. */
        fun take(bytes: ByteArray, from: Int, to: Int): Boolean {
            if (to <= from) return true
            val obj = try {
                JSONObject(String(bytes, from, to - from, Charsets.UTF_8))
            } catch (_: Exception) {
                return true // partial line being written, or garbage: skip it
            }
            val seq = obj.optLong("seq")
            if (newest < 0) {
                newest = seq
                if (seq < since) floor = 0
            }
            if (seq <= floor) return false
            newestFirst.add(Entry(seq, obj.optLong("ts"), obj.optString("stream"), obj.optString("line")))
            return newestFirst.size < limit
        }

        var pos = raf.length()
        var carry = ByteArray(0)
        scan@ while (pos > 0) {
            val start = maxOf(0L, pos - CHUNK)
            val chunk = ByteArray((pos - start).toInt())
            raf.seek(start)
            raf.readFully(chunk)
            val data = if (carry.isEmpty()) chunk else chunk + carry
            var end = data.size
            for (i in data.size - 1 downTo 0) {
                if (data[i] == '\n'.code.toByte()) {
                    if (!take(data, i + 1, end)) break@scan
                    end = i
                }
            }
            if (start == 0L) {
                take(data, 0, end)
                break
            }
            carry = data.copyOfRange(0, end)
            pos = start
        }

        val next = when {
            newest < 0 -> since
            newest < since -> newest
            else -> maxOf(newest, since)
        }
        return newestFirst.asReversed() to next
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
