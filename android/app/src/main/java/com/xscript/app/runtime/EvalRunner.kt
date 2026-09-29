package com.xscript.app.runtime

import com.chaquo.python.Python
import com.xscript.app.XscriptApp
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** One-shot probes from MCP (`POST /eval`). Runs in the main process. */
object EvalRunner {
    private val exec = Executors.newSingleThreadExecutor()

    fun run(code: String, timeoutMs: Long): JSONObject {
        XscriptApp.instance.ensurePython()
        val future = exec.submit<JSONObject> {
            val py = Python.getInstance()
            val json = py.getModule("json")
            val module = py.getModule("xscript.runtime.eval_runner")
            val result = module.callAttr("run", code)
            JSONObject(json.callAttr("dumps", result).toString())
        }
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            future.cancel(true)
            JSONObject().put("ok", false).put("error", "timeout")
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: t.toString())
        }
    }
}
