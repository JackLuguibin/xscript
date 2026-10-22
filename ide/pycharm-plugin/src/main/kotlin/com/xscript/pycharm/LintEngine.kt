package com.xscript.pycharm

import com.google.gson.Gson
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefClient
import com.intellij.ui.jcef.JBCefJSQuery
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Runs the Web IDE's basic checks (android/app/src/main/assets/tools/editor-{parse,symbols,docs}.js, copied into the plugin
 * as /webide/ at build time) in a hidden JCEF page, the browser PyCharm already ships: one source, so PyCharm reports what
 * the Web IDE and VS Code report. Started on first use; without JCEF (headless, some remote setups) [lint] returns null.
 */
@Service(Service.Level.APP)
class LintEngine : Disposable {
    private val log = logger<LintEngine>()
    private var browser: JBCefBrowser? = null
    private val ready = CompletableFuture<Boolean>()
    private val pending = ConcurrentHashMap<Int, CompletableFuture<String>>()
    private val ids = AtomicInteger()

    /** Problems of [file] (project-relative) among [files], or null when the checks cannot run (no JCEF, timeout, error). */
    fun lint(files: List<Pair<String, String>>, file: String, timeoutMs: Long = 8000): List<LintProblem>? {
        if (!JBCefApp.isSupported() || !start()) return null
        // the first call also waits for the page to load the checks (a few seconds on a cold start)
        if (runCatching { ready.get(maxOf(timeoutMs, READY_TIMEOUT_MS), TimeUnit.MILLISECONDS) }.getOrNull() != true) {
            log.info("XScript checks: the checks page did not load")
            return null
        }
        val id = ids.incrementAndGet()
        val answer = CompletableFuture<String>().also { pending[id] = it }
        val payload = Gson().toJson(mapOf("file" to file, "files" to files.map { mapOf("path" to it.first, "content" to it.second) }))
        browser?.cefBrowser?.executeJavaScript("xsLint($id, ${Gson().toJson(payload)})", "xscript://lint", 0)
        return try {
            val raw = answer.get(timeoutMs, TimeUnit.MILLISECONDS)
            if (raw.startsWith("!")) { log.info("XScript checks failed: " + raw.drop(1)); null } else LintRules.parse(raw, files.firstOrNull { it.first == file }?.second ?: "")
        } catch (e: Exception) {
            log.info("XScript checks: no answer for $file ($e)")
            null
        } finally {
            pending.remove(id)
        }
    }

    @Synchronized
    private fun start(): Boolean {
        if (browser != null) return true
        return try {
            // never shown, so created at once; a JS query on an already created browser needs a pool slot reserved on its
            // client first (otherwise JBCefJSQuery.create throws IllegalStateException and the checks never run)
            val client = JBCefApp.getInstance().createClient()
            client.setProperty(JBCefClient.Properties.JS_QUERY_POOL_SIZE, 1)
            val b = JBCefBrowser.createBuilder().setClient(client).setOffScreenRendering(true).setCreateImmediately(true).build()
            val query = JBCefJSQuery.create(b as JBCefBrowserBase)
            query.addHandler { msg ->
                val at = msg.indexOf(':')
                val id = msg.substring(0, at).toIntOrNull()
                if (id == 0) { log.info("XScript checks: ready"); ready.complete(true) } else id?.let { pending[it]?.complete(msg.substring(at + 1)) }
                null
            }
            Disposer.register(this, query)
            Disposer.register(this, b)
            Disposer.register(this, client)
            b.loadHTML(page(query.inject("m")))
            browser = b
            true
        } catch (e: Throwable) {
            log.warn("XScript checks: JCEF is not available", e)
            false
        }
    }

    private fun page(send: String): String {
        fun script(name: String) = (javaClass.getResourceAsStream("/webide/$name")?.use { String(it.readAllBytes(), Charsets.UTF_8) } ?: "")
            .replace("</script", "<\\/script")
        return """<!doctype html><meta charset="utf-8"><body><script>${script("editor-parse.js")}</script>""" +
            "<script>${script("editor-docs.js")}</script><script>${script("editor-symbols.js")}</script><script>" +
            "function xsSend(m){ $send }\n" + DRIVER + "</script></body>"
    }

    override fun dispose() {
        pending.values.forEach { it.cancel(true) }
    }

    companion object {
        /** Same combination as the Web IDE's assist.lint and the VS Code extension's lintFile. */
        private val DRIVER = """
            window.xsLint = function (id, payload) {
              try {
                const req = JSON.parse(payload);
                const idx = EditorSymbols.build(req.files, window.XSDocs || null);
                const dead = idx.unreachableIn(req.file), deadLines = new Set(dead.map(d => d.line));
                const all = idx.problemsIn(req.file).concat(idx.unusedIn(req.file).filter(u => !deadLines.has(u.line)), dead);
                const keep = p => ({line: p.line, col: p.col, length: p.length, message: p.message, severity: p.severity,
                  suggest: p.suggest, fix: p.fix, name: p.name, edit: p.edit, jump: p.jump});
                xsSend(id + ":" + JSON.stringify({importLine: idx.importLine(req.file), problems: all.map(keep)}));
              } catch (e) { xsSend(id + ":!" + e); }
            };
            xsSend("0:ready");
        """.trimIndent()

        const val READY_TIMEOUT_MS = 30_000L

        fun get(): LintEngine = ApplicationManager.getApplication().getService(LintEngine::class.java)
    }
}
