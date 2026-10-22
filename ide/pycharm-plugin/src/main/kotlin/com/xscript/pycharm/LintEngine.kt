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
            if (raw.startsWith("!")) { log.info("XScript checks failed: " + raw.drop(1)); null } else LintRules.parse(raw)
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
            val b = JBCefBrowser.createBuilder().setOffScreenRendering(true).setCreateImmediately(true).build()  // never shown: create now
            val query = JBCefJSQuery.create(b as JBCefBrowserBase)
            query.addHandler { msg ->
                val at = msg.indexOf(':')
                val id = msg.substring(0, at).toIntOrNull()
                if (id == 0) { log.info("XScript checks: ready"); ready.complete(true) } else id?.let { pending[it]?.complete(msg.substring(at + 1)) }
                null
            }
            Disposer.register(this, query)
            Disposer.register(this, b)
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
                xsSend(id + ":" + JSON.stringify(all.map(p => ({line: p.line, col: p.col, length: p.length, message: p.message, severity: p.severity}))));
              } catch (e) { xsSend(id + ":!" + e); }
            };
            xsSend("0:ready");
        """.trimIndent()

        const val READY_TIMEOUT_MS = 30_000L

        fun get(): LintEngine = ApplicationManager.getApplication().getService(LintEngine::class.java)
    }
}
