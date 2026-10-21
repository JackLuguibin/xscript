package com.xscript.pycharm

/** What the status bar shows about the configured phone. */
sealed class DeviceState {
    /** Not checked yet. */
    object Unknown : DeviceState()
    class Idle(val version: String) : DeviceState()
    class Running(val project: String, val version: String) : DeviceState()
    /** The device answered 401: it needs this IDE's pairing code. */
    object PairingNeeded : DeviceState()
    /** No answer (app closed, phone off, wrong address, adb forward missing). */
    object Unreachable : DeviceState()
    /** Answered, but with an unexpected HTTP error. */
    class Failed(val detail: String) : DeviceState()
}

/** One short /status check (the status bar polls this). Never throws. */
fun probe(status: () -> com.google.gson.JsonObject): DeviceState = try {
    val s = status()
    val version = s.get("version")?.takeIf { !it.isJsonNull }?.asString ?: "?"
    val running = s.get("running")?.takeIf { !it.isJsonNull }?.asBoolean == true
    if (running) {
        val name = s.get("project")?.takeIf { !it.isJsonNull }?.asString ?: ""
        DeviceState.Running(name, version)
    } else {
        DeviceState.Idle(version)
    }
} catch (e: DeviceHttpException) {
    if (e.isPairing) DeviceState.PairingNeeded else DeviceState.Failed(e.message ?: "HTTP ${e.status}")
} catch (e: Exception) {
    if (isUnreachable(e)) DeviceState.Unreachable else DeviceState.Failed(e.message ?: e.toString())
}

/** Status bar text, e.g. "XScript: 运行中 demo". */
fun statusLabel(state: DeviceState, msg: (String, Array<out Any>) -> String = { k, a -> XScriptBundle.message(k, *a) }): String = when (state) {
    DeviceState.Unknown -> msg("status.unknown", emptyArray())
    is DeviceState.Idle -> msg("status.idle", emptyArray())
    is DeviceState.Running -> if (state.project.isEmpty()) msg("status.running", emptyArray()) else msg("status.runningProject", arrayOf(state.project))
    DeviceState.PairingNeeded -> msg("status.pairing", emptyArray())
    DeviceState.Unreachable -> msg("status.offline", emptyArray())
    is DeviceState.Failed -> msg("status.error", emptyArray())
}

/** Tooltip: the address, the app version or the problem, and what a click does. */
fun statusTooltip(state: DeviceState, address: String, msg: (String, Array<out Any>) -> String = { k, a -> XScriptBundle.message(k, *a) }): String = when (state) {
    DeviceState.Unknown -> msg("status.tip.unknown", arrayOf(address))
    is DeviceState.Idle -> msg("status.tip.connected", arrayOf(address, state.version))
    is DeviceState.Running -> msg("status.tip.connected", arrayOf(address, state.version))
    DeviceState.PairingNeeded -> msg("status.tip.pairing", arrayOf(address))
    DeviceState.Unreachable -> msg("status.tip.offline", arrayOf(address))
    is DeviceState.Failed -> msg("status.tip.error", arrayOf(address, state.detail))
}

/** "Can't connect" checklist; linked from the unreachable notification. */
const val TROUBLESHOOTING_URL = "https://github.com/JackLuguibin/xscript/blob/main/docs/TROUBLESHOOTING.md"

/** A click opens the connect dialog when something is wrong, else the XScript tool window. */
fun clickOpensConnect(state: DeviceState): Boolean =
    state is DeviceState.Unreachable || state is DeviceState.PairingNeeded || state is DeviceState.Failed
