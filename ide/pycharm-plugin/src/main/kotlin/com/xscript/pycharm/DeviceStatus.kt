package com.xscript.pycharm

/** What the status bar shows about the configured phone. */
sealed class DeviceState {
    /** Not checked yet. */
    object Unknown : DeviceState()
    class Idle(val version: String, val capture: CaptureProblem? = null) : DeviceState()
    class Running(val project: String, val version: String, val capture: CaptureProblem? = null) : DeviceState()
    /** The device answered 401: it needs this IDE's pairing code. */
    object PairingNeeded : DeviceState()
    /** No answer (app closed, phone off, wrong address, adb forward missing). */
    object Unreachable : DeviceState()
    /** Answered, but with an unexpected HTTP error. */
    class Failed(val detail: String) : DeviceState()
}

/** Why the phone cannot capture the screen (same rules as the desktop's 截图状态 card). */
enum class CaptureProblem {
    /** The screen-recording grant went away (reboot, revoked) and nothing else can capture. */
    LOST,
    /** Never granted, and no accessibility / root capture. */
    NONE,
}

/** null when capture works or the app is too old to say (no capture_via; then only capture=false counts). */
fun captureProblem(s: com.google.gson.JsonObject): CaptureProblem? {
    fun bool(k: String) = s.get(k)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean
    val via = s.get("capture_via")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
        ?: return if (bool("capture") == false) CaptureProblem.NONE else null
    if (via.isNotEmpty()) return null
    return if (bool("capture_lost") == true) CaptureProblem.LOST else CaptureProblem.NONE
}

/** The capture problem of a connected device, if any. */
fun DeviceState.capture(): CaptureProblem? = when (this) {
    is DeviceState.Idle -> capture
    is DeviceState.Running -> capture
    else -> null
}

/** One short /status check (the status bar polls this). Never throws. */
fun probe(status: () -> com.google.gson.JsonObject): DeviceState = try {
    val s = status()
    val version = s.get("version")?.takeIf { !it.isJsonNull }?.asString ?: "?"
    val running = s.get("running")?.takeIf { !it.isJsonNull }?.asBoolean == true
    val capture = captureProblem(s)
    if (running) {
        val name = s.get("project")?.takeIf { !it.isJsonNull }?.asString ?: ""
        DeviceState.Running(name, version, capture)
    } else {
        DeviceState.Idle(version, capture)
    }
} catch (e: DeviceHttpException) {
    if (e.isPairing) DeviceState.PairingNeeded else DeviceState.Failed(e.message ?: "HTTP ${e.status}")
} catch (e: Exception) {
    if (isUnreachable(e)) DeviceState.Unreachable else DeviceState.Failed(e.message ?: e.toString())
}

/** Status bar text, e.g. "XScript: 运行中 demo". */
fun statusLabel(state: DeviceState, msg: (String, Array<out Any>) -> String = { k, a -> XScriptBundle.message(k, *a) }): String =
    baseLabel(state, msg) + when (state.capture()) {
        CaptureProblem.LOST -> msg("status.capture.lost", emptyArray())
        CaptureProblem.NONE -> msg("status.capture.none", emptyArray())
        null -> ""
    }

private fun baseLabel(state: DeviceState, msg: (String, Array<out Any>) -> String): String = when (state) {
    DeviceState.Unknown -> msg("status.unknown", emptyArray())
    is DeviceState.Idle -> msg("status.idle", emptyArray())
    is DeviceState.Running -> if (state.project.isEmpty()) msg("status.running", emptyArray()) else msg("status.runningProject", arrayOf(state.project))
    DeviceState.PairingNeeded -> msg("status.pairing", emptyArray())
    DeviceState.Unreachable -> msg("status.offline", emptyArray())
    is DeviceState.Failed -> msg("status.error", emptyArray())
}

/** Tooltip: the address, the app version or the problem, and what a click does. */
fun statusTooltip(state: DeviceState, address: String, msg: (String, Array<out Any>) -> String = { k, a -> XScriptBundle.message(k, *a) }): String =
    when (state.capture()) {
        CaptureProblem.LOST -> msg("status.tip.captureLost", arrayOf(address))
        CaptureProblem.NONE -> msg("status.tip.captureNone", arrayOf(address))
        null -> baseTooltip(state, address, msg)
    }

private fun baseTooltip(state: DeviceState, address: String, msg: (String, Array<out Any>) -> String): String = when (state) {
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
/** A click on a device that cannot capture asks the phone for the screen-recording grant. */
fun clickGrantsCapture(state: DeviceState): Boolean = state.capture() != null

fun clickOpensConnect(state: DeviceState): Boolean =
    state is DeviceState.Unreachable || state is DeviceState.PairingNeeded || state is DeviceState.Failed
