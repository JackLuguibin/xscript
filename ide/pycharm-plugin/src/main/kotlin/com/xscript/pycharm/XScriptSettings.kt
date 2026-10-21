package com.xscript.pycharm

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/** Device address (application level, like the VS Code `xscript.device` setting). The pairing code is not stored here. */
@Service(Service.Level.APP)
@State(name = "XScriptSettings", storages = [Storage("xscript.xml")])
class XScriptSettings : PersistentStateComponent<XScriptSettings.State> {
    class State {
        var device: String = "127.0.0.1:$DEFAULT_PORT"
        var evalTimeoutMs: Int = DEFAULT_EVAL_TIMEOUT_MS
    }

    private var state = State()
    override fun getState(): State = state
    override fun loadState(s: State) { state = s }

    var device: String
        get() = state.device
        set(v) { state.device = v.trim() }

    /** Run Selection on Device timeout, like VS Code's `xscript.evalTimeoutMs`; kept within what the device accepts. */
    var evalTimeoutMs: Int
        get() = clampEvalTimeout(state.evalTimeoutMs)
        set(v) { state.evalTimeoutMs = clampEvalTimeout(v) }

    fun target(): DeviceTarget = DeviceTarget.parse(device)

    /** Pairing code per device address, kept in the IDE's password safe (system keychain where available). */
    fun pairingCode(target: DeviceTarget = target()): String =
        PasswordSafe.instance.getPassword(attributes(target)) ?: ""

    fun setPairingCode(code: String, target: DeviceTarget = target()) {
        PasswordSafe.instance.set(attributes(target), if (code.isBlank()) null else Credentials("xscript", normalizeCode(code)))
    }

    fun client(): DeviceClient = target().let { DeviceClient(it, token = pairingCode(it)) }

    private fun attributes(t: DeviceTarget) = CredentialAttributes(generateServiceName("XScript", "device ${t.host}:${t.port}"), "xscript")

    companion object {
        const val DEFAULT_EVAL_TIMEOUT_MS = 8000
        const val MIN_EVAL_TIMEOUT_MS = 200
        const val MAX_EVAL_TIMEOUT_MS = 15000
        fun clampEvalTimeout(ms: Int) = ms.coerceIn(MIN_EVAL_TIMEOUT_MS, MAX_EVAL_TIMEOUT_MS)
        fun get(): XScriptSettings = ApplicationManager.getApplication().getService(XScriptSettings::class.java)
    }
}
