package com.xscript.app.runtime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Process
import com.xscript.app.IEval
import com.xscript.app.XscriptApp
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * `POST /eval` from MCP. Runs in the main process but only as a client: the code itself
 * executes in [EvalService] (`:eval`). On timeout the whole :eval process is killed,
 * which is the only way to stop a Python loop or a blocking native call.
 */
object EvalRunner {
    /** Budget for starting :eval (cold Python start), separate from the snippet timeout. */
    private const val CONNECT_MS = 15_000L

    // Cached pool: a call stuck in a dying process must not block the next one.
    private val calls = Executors.newCachedThreadPool { r -> Thread(r, "xscript-eval").apply { isDaemon = true } }
    private val lock = Any()

    @Volatile
    private var remote: IEval? = null
    private var connection: ServiceConnection? = null

    /** One snippet at a time: killing :eval on timeout would take concurrent snippets with it. */
    fun run(code: String, timeoutMs: Long): JSONObject = call(timeoutMs) { it.run(code) }

    /** 图色工具 check (see xscript.runtime.vision). Same process, lock and timeout rules as [run]. */
    fun vision(request: JSONObject, timeoutMs: Long): JSONObject = call(timeoutMs) { it.vision(request.toString()) }

    private fun call(timeoutMs: Long, block: (IEval) -> String): JSONObject {
        synchronized(lock) {
            val eval = connect() ?: return fail("eval process unavailable")
            val future = calls.submit<String> { block(eval) }
            return try {
                JSONObject(future.get(timeoutMs, TimeUnit.MILLISECONDS))
            } catch (_: TimeoutException) {
                kill(eval)
                fail("timeout")
            } catch (t: Throwable) {
                // DeadObjectException etc.: the process died (crash, OOM, os._exit).
                reset()
                fail((t.cause ?: t).let { it.message ?: it.toString() })
            }
        }
    }

    private fun fail(error: String) = JSONObject().put("ok", false).put("result", "").put("error", error)

    private fun connect(): IEval? {
        remote?.takeIf { it.asBinder().isBinderAlive }?.let { return it }
        reset()
        val ctx = XscriptApp.instance
        val ready = CountDownLatch(1)
        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                remote = IEval.Stub.asInterface(service)
                ready.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                remote = null
            }
        }
        if (!ctx.bindService(Intent(ctx, EvalService::class.java), conn, Context.BIND_AUTO_CREATE)) return null
        connection = conn
        ready.await(CONNECT_MS, TimeUnit.MILLISECONDS)
        return remote
    }

    private fun kill(eval: IEval) {
        val pid = try {
            eval.pid()
        } catch (_: Exception) {
            0
        }
        reset()
        if (pid > 0 && pid != Process.myPid()) Process.killProcess(pid)
    }

    private fun reset() {
        remote = null
        val conn = connection ?: return
        connection = null
        try {
            XscriptApp.instance.unbindService(conn)
        } catch (_: Exception) {
        }
    }
}
