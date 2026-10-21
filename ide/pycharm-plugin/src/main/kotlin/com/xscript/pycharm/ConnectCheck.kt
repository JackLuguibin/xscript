package com.xscript.pycharm

import com.google.gson.JsonObject

/** The connect dialog's checks, in order; the first failing one is where the connection breaks. */
enum class CheckStepId(val key: String) { ADDRESS("address"), REACH("reach"), APP("app"), XSCRIPT("xscript"), PAIRING("pairing") }

/** ok = null: not checked because an earlier step failed. */
data class CheckStep(val id: CheckStepId, val ok: Boolean?, val detail: String = "")

/** Same rule as the desktop app: any JSON object is not enough, a random local web server answers too. */
fun isXscriptStatus(s: JsonObject): Boolean = listOf("device_id", "app_id", "model").any { s.has(it) }

/** Pairing is on and our code was not accepted (or not sent). */
fun statusNeedsPairing(s: JsonObject): Boolean =
    s.get("pairing")?.takeIf { it.isJsonPrimitive }?.asBoolean == true &&
        s.get("paired")?.takeIf { it.isJsonPrimitive }?.let { !it.asBoolean } == true

/** Plain TCP connect: "refused" when nothing listens, "timeout" when nothing answers. */
fun tcpConnect(target: DeviceTarget, timeoutMs: Int = 3000) {
    java.net.Socket().use { it.connect(java.net.InetSocketAddress(target.host, target.port), timeoutMs) }
}

private fun reachDetail(e: Exception): String = when (e) {
    is java.net.ConnectException -> "refused"
    is java.net.SocketTimeoutException -> "timeout"
    is java.net.UnknownHostException -> "unknown host"
    else -> e.message ?: e.javaClass.simpleName
}

/**
 * Walks address → reach → app → xscript → pairing and stops at the first failure (later steps ok = null).
 * `connect` and `status` are injected so tests need no network; never throws.
 */
fun runConnectCheck(
    value: String?,
    connect: (DeviceTarget) -> Unit = { tcpConnect(it) },
    status: (DeviceTarget) -> JsonObject,
): List<CheckStep> {
    val steps = mutableListOf<CheckStep>()
    fun finish() = steps + CheckStepId.entries.drop(steps.size).map { CheckStep(it, null) }

    val target = try { DeviceTarget.parse(value) } catch (e: IllegalArgumentException) {
        steps += CheckStep(CheckStepId.ADDRESS, false, (value ?: "").trim())
        return finish()
    }
    val shown = (if (':' in target.host) "[${target.host}]" else target.host) + ":" + target.port
    steps += CheckStep(CheckStepId.ADDRESS, true, shown)

    try { connect(target) } catch (e: Exception) {
        steps += CheckStep(CheckStepId.REACH, false, reachDetail(e))
        return finish()
    }
    steps += CheckStep(CheckStepId.REACH, true)

    val s = try { status(target) } catch (e: DeviceHttpException) {
        steps += CheckStep(CheckStepId.APP, true)
        if (e.isPairing) {
            steps += CheckStep(CheckStepId.XSCRIPT, true)
            steps += CheckStep(CheckStepId.PAIRING, false, "HTTP 401")
        } else {
            steps += CheckStep(CheckStepId.XSCRIPT, false, e.message ?: "HTTP ${e.status}")
        }
        return finish()
    } catch (e: Exception) {
        val notJson = e is com.google.gson.JsonParseException || e is IllegalStateException
        if (notJson) {
            steps += CheckStep(CheckStepId.APP, true)
            steps += CheckStep(CheckStepId.XSCRIPT, false, "not JSON")
        } else {
            steps += CheckStep(CheckStepId.APP, false, if (e is java.net.http.HttpTimeoutException) "timeout" else e.message ?: e.javaClass.simpleName)
        }
        return finish()
    }
    steps += CheckStep(CheckStepId.APP, true)
    if (!isXscriptStatus(s)) {
        steps += CheckStep(CheckStepId.XSCRIPT, false, "not XScript")
        return finish()
    }
    fun str(k: String) = s.get(k)?.takeIf { it.isJsonPrimitive }?.asString ?: ""
    steps += CheckStep(CheckStepId.XSCRIPT, true, listOf(str("model"), str("version")).filter { it.isNotEmpty() }.joinToString(" "))
    steps += if (statusNeedsPairing(s)) CheckStep(CheckStepId.PAIRING, false)
    else CheckStep(CheckStepId.PAIRING, true, if (s.get("pairing")?.takeIf { it.isJsonPrimitive }?.asBoolean == true) "paired" else "off")
    return finish()
}

/** All passed, or only the pairing code is missing (Connect asks for it right after). */
fun canConnect(steps: List<CheckStep>): Boolean = steps.all { it.ok == true || it.id == CheckStepId.PAIRING }

/** The step-by-step result as HTML for the dialog; the failing step gets its fix. */
fun checkHtml(steps: List<CheckStep>, msg: (String, Array<out Any>) -> String = { k, a -> XScriptBundle.message(k, *a) }): String {
    fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    val sb = StringBuilder("<html><body>")
    for (st in steps) {
        val mark = when (st.ok) { true -> "<font color='#2e9e4f'>✓</font>"; false -> "<font color='#d64545'>✗</font>"; null -> "<font color='#999999'>·</font>" }
        val name = esc(msg("check.${st.id.key}", emptyArray()))
        val label = if (st.ok == null) "<font color='#999999'>$name · ${esc(msg("check.skipped", emptyArray()))}</font>" else if (st.ok == false) "<b>$name</b>" else name
        sb.append(mark).append("&nbsp; ").append(label)
        if (st.ok != null && st.detail.isNotEmpty()) sb.append(" <font color='#888888'>· ").append(esc(st.detail)).append("</font>")
        sb.append("<br>")
        if (st.ok == false) sb.append("<div style='margin:2px 0 6px 18px'>").append(esc(msg("check.fix.${st.id.key}", emptyArray()))).append("</div>")
    }
    if (steps.all { it.ok == true }) sb.append("<br>").append(esc(msg("check.allOk", emptyArray())))
    return sb.append("</body></html>").toString()
}
