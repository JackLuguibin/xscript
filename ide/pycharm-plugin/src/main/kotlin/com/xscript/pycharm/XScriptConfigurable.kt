package com.xscript.pycharm

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
    private var panel: JComponent? = null

    override fun getDisplayName() = "XScript"

    override fun createComponent(): JComponent {
        reset()
        return FormBuilder.createFormBuilder()
            .addLabeledComponent(XScriptBundle.message("settings.device"), device)
            .addTooltip(XScriptBundle.message("settings.device.hint"))
            .addLabeledComponent(XScriptBundle.message("settings.code"), code)
            .addTooltip(XScriptBundle.message("settings.code.hint"))
            .addComponentFillVertically(javax.swing.JPanel(), 0)
            .panel.also { panel = it }
    }

    private fun codeText() = String(code.password)

    override fun isModified(): Boolean {
        val s = XScriptSettings.get()
        return device.text.trim() != s.device || normalizeCode(codeText()) != s.pairingCode(safeTarget() ?: s.target())
    }

    private fun safeTarget(): DeviceTarget? = try { DeviceTarget.parse(device.text) } catch (_: IllegalArgumentException) { null }

    override fun apply() {
        val t = safeTarget() ?: throw ConfigurationException(XScriptBundle.message("settings.device.invalid"))
        val c = codeText()
        if (c.isNotBlank()) validateCode(c)?.let { throw ConfigurationException(it) }
        val s = XScriptSettings.get()
        s.device = device.text
        s.setPairingCode(c, t)
    }

    override fun reset() {
        val s = XScriptSettings.get()
        device.text = s.device
        code.text = s.pairingCode()
    }

    override fun disposeUIResources() { panel = null }
}
