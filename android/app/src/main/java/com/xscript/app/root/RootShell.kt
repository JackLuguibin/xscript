package com.xscript.app.root

import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Thin `su -c` wrapper. Each call spawns a short-lived su process, which keeps state
 * isolation simple; `input` itself dominates latency anyway.
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
