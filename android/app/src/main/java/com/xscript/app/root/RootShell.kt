package com.xscript.app.root

import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Root command runner. [run] reuses one long-lived `su` shell for latency-sensitive
 * commands (gestures, keys); [exec] / [execRaw] spawn a short-lived `su -c` per call for
 * anything that needs output, binary data or isolation.
 */
object RootShell {
    data class Result(val code: Int, val out: String, val err: String) {
        val ok: Boolean get() = code == 0
    }

    @Volatile
    private var cached: Boolean? = null

    @Volatile
    private var lastProbeAt = 0L

    private val probing = AtomicBoolean(false)

    private const val REPROBE_MS = 30_000L

    /**
     * Last known root state without blocking; null until the first probe finishes.
     * A negative result is re-probed in the background at most every 30 s, so granting
     * su later (or a timed-out prompt) is picked up without restarting the app.
     */
    fun known(): Boolean? {
        val c = cached
        if (c == false && SystemClock.elapsedRealtime() - lastProbeAt > REPROBE_MS) probeAsync()
        return c
    }

    /** Probe su (blocking). Call off the UI thread: su managers may show a prompt. */
    fun available(refresh: Boolean = false): Boolean {
        val c = cached
        if (c != null && !refresh) return c
        return probe()
    }

    private fun probe(): Boolean {
        val ok = try {
            // Long timeout: the su manager may show a grant prompt the first time.
            exec("id", 30_000).out.contains("uid=0")
        } catch (_: Throwable) {
            false
        }
        lastProbeAt = SystemClock.elapsedRealtime()
        cached = ok
        return ok
    }

    fun probeAsync(onDone: ((Boolean) -> Unit)? = null) {
        if (!probing.compareAndSet(false, true)) {
            onDone?.let { cb -> thread(isDaemon = true) { cb(cached == true) } }
            return
        }
        thread(name = "xscript-root-probe", isDaemon = true) {
            val ok = try {
                probe()
            } finally {
                probing.set(false)
            }
            onDone?.invoke(ok)
        }
    }

    // ---- persistent session -------------------------------------------------------------
    //
    // Spawning `su` costs ~250 ms per call (su daemon handshake, plus a "granted" toast on
    // some managers), several times what `input tap` itself takes. Gesture/key commands only
    // need an exit code, so they go through one long-lived root shell instead.

    private const val MARK = "__XS_DONE__"
    private const val EOF = "\u0000eof"

    private class Session(val process: Process) {
        val lines = LinkedBlockingQueue<String>()
        val writer = process.outputStream.bufferedWriter()

        init {
            thread(name = "xscript-su-out", isDaemon = true) {
                try {
                    process.inputStream.bufferedReader().forEachLine { lines.put(it) }
                } catch (_: Exception) {
                }
                lines.put(EOF)
            }
            thread(name = "xscript-su-err", isDaemon = true) {
                try {
                    val sink = ByteArray(4096)
                    val err = process.errorStream
                    while (err.read(sink) >= 0) Unit
                } catch (_: Exception) {
                }
            }
        }

        fun alive(): Boolean = process.isAlive
    }

    private var session: Session? = null
    private var seq = 0L

    /**
     * Run [cmd] in the shared root shell and report whether it exited 0. Output is discarded.
     * Falls back to a one-shot [exec] if the session cannot start. A hung command resets the
     * session so the next call starts clean.
     */
    @Synchronized
    fun run(cmd: String, timeoutMs: Long = 15_000): Boolean {
        val s = session?.takeIf { it.alive() } ?: openSession() ?: return exec(cmd, timeoutMs).ok
        val marker = MARK + (++seq) + ":"
        val code = try {
            // `sh -c` contains syntax errors in the command; stdin from /dev/null keeps the
            // command from eating the session's input.
            s.writer.write("sh -c ${quote(cmd)} </dev/null >/dev/null 2>&1; echo \"$marker\$?\"\n")
            s.writer.flush()
            awaitMarker(s, marker, SystemClock.elapsedRealtime() + timeoutMs)
        } catch (_: Exception) {
            null
        }
        if (code == null) closeSession()
        return code == "0"
    }

    /** Exit code printed after [marker], or null on timeout / dead shell. */
    private fun awaitMarker(s: Session, marker: String, deadline: Long): String? {
        while (true) {
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0) return null
            val line = s.lines.poll(left, TimeUnit.MILLISECONDS) ?: return null
            if (line == EOF) return null
            if (line.startsWith(marker)) return line.substring(marker.length).trim()
        }
    }

    private fun openSession(): Session? {
        closeSession()
        return try {
            Session(ProcessBuilder("su").start()).also { session = it }
        } catch (_: Exception) {
            null
        }
    }

    private fun closeSession() {
        val s = session ?: return
        session = null
        try {
            s.writer.write("exit\n")
            s.writer.flush()
        } catch (_: Exception) {
        }
        s.process.destroy()
    }

    // ---- one-shot commands --------------------------------------------------------------

    fun exec(cmd: String, timeoutMs: Long = 15_000): Result {
        val bytes = execRaw(cmd, timeoutMs)
        return Result(bytes.code, String(bytes.out, Charsets.UTF_8), bytes.err)
    }

    class RawResult(val code: Int, val out: ByteArray, val err: String)

    fun execRaw(cmd: String, timeoutMs: Long = 15_000): RawResult {
        val process = ProcessBuilder("su", "-c", cmd).start()
        process.outputStream.close()
        val errBuf = ByteArrayOutputStream()
        val errThread = thread(isDaemon = true) { copy(process.errorStream, errBuf) }
        val outBuf = ByteArrayOutputStream()
        val outThread = thread(isDaemon = true) { copy(process.inputStream, outBuf) }
        val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) {
            process.destroy()
            return RawResult(-1, outBuf.toByteArray(), "timeout")
        }
        outThread.join(2000)
        errThread.join(500)
        return RawResult(process.exitValue(), outBuf.toByteArray(), errBuf.toString("UTF-8"))
    }

    /** Single-quote a value for sh. */
    fun quote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    private fun copy(input: InputStream, out: ByteArrayOutputStream) {
        try {
            input.use { it.copyTo(out) }
        } catch (_: Exception) {
        }
    }
}
