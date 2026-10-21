package com.xscript.pycharm

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent

/** Settings | Tools | XScript: device address and pairing code. */
class XScriptConfigurable : Configurable {
    private val device = JBTextField()
    private val code = JBPasswordField()
    private val evalTimeout = com.intellij.ui.JBIntSpinner(XScriptSettings.DEFAULT_EVAL_TIMEOUT_MS,
        XScriptSettings.MIN_EVAL_TIMEOUT_MS, XScriptSettings.MAX_EVAL_TIMEOUT_MS, 500)
    private var panel: JComponent? = null
    /** Pairing code as last loaded from / saved to the password safe (which must not be touched on the EDT). */
    @Volatile private var savedCode: String = ""

    override fun getDisplayName() = "XScript"

    override fun createComponent(): JComponent {
        reset()
        return FormBuilder.createFormBuilder()
            .addLabeledComponent(XScriptBundle.message("settings.device"), device)
            .addTooltip(XScriptBundle.message("settings.device.hint"))
            .addLabeledComponent(XScriptBundle.message("settings.code"), code)
            .addTooltip(XScriptBundle.message("settings.code.hint"))
            .addLabeledComponent(XScriptBundle.message("settings.evalTimeout"), evalTimeout)
            .addTooltip(XScriptBundle.message("settings.evalTimeout.hint"))
            .addComponentFillVertically(javax.swing.JPanel(), 0)
            .panel.also { panel = it }
    }

    private fun codeText() = String(code.password)

    override fun isModified(): Boolean {
        val s = XScriptSettings.get()
        return device.text.trim() != s.device || evalTimeout.number != s.evalTimeoutMs || normalizeCode(codeText()) != savedCode
    }

    private fun safeTarget(): DeviceTarget? = try { DeviceTarget.parse(device.text) } catch (_: IllegalArgumentException) { null }

    override fun apply() {
        val t = safeTarget() ?: throw ConfigurationException(XScriptBundle.message("settings.device.invalid"))
        val c = codeText()
        if (c.isNotBlank()) validateCode(c)?.let { throw ConfigurationException(it) }
        val s = XScriptSettings.get()
        s.device = device.text
        s.evalTimeoutMs = evalTimeout.number
        savedCode = normalizeCode(c)
        ApplicationManager.getApplication().executeOnPooledThread { s.setPairingCode(c, t) }
    }

    override fun reset() {
        val s = XScriptSettings.get()
        device.text = s.device
        evalTimeout.number = s.evalTimeoutMs
        val target = s.target()
        ApplicationManager.getApplication().executeOnPooledThread {
            val loaded = s.pairingCode(target)
            ApplicationManager.getApplication().invokeLater({
                savedCode = loaded
                code.text = loaded
            }, ModalityState.any())
        }
    }

    override fun disposeUIResources() { panel = null }
}
