package com.xscript.pycharm

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.ui.components.labels.LinkLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * 「连接设备」: an address field and a step-by-step check. OK first checks the address; it closes (and saves) only when
 * the phone answered, or when the user presses it again after a failed check ("仍然保存").
 */
class ConnectDialog(project: Project?, initial: String) : DialogWrapper(project, true) {
    val field = JBTextField(initial, 28)
    private val result = JBLabel()
    private val checkButton = JButton(XScriptBundle.message("check.button"))
    private val help = LinkLabel<Any>(XScriptBundle.message("notify.help"), null) { _, _ -> BrowserUtil.browse(TROUBLESHOOTING_URL) }
    /** The address the shown result is for, and that result. */
    private var checked: Pair<String, List<CheckStep>>? = null
    private var running = false

    init {
        title = XScriptBundle.message("check.title")
        setOKButtonText(XScriptBundle.message("check.ok"))
        help.isVisible = false
        checkButton.addActionListener { check(closeIfOk = false) }
        field.document.addDocumentListener(object : com.intellij.ui.DocumentAdapter() {
            override fun textChanged(e: javax.swing.event.DocumentEvent) { setOKButtonText(XScriptBundle.message("check.ok")) }
        })
        init()
    }

    override fun createCenterPanel(): JComponent {
        val top = JPanel(BorderLayout(JBUI.scale(8), 0))
        top.add(JBLabel(XScriptBundle.message("connect.prompt")), BorderLayout.WEST)
        top.add(field, BorderLayout.CENTER)
        top.add(checkButton, BorderLayout.EAST)
        val hint = JBLabel(XScriptBundle.message("check.hint")).apply { foreground = JBUI.CurrentTheme.ContextHelp.FOREGROUND }
        val south = JPanel(BorderLayout()).apply { add(help, BorderLayout.WEST) }
        val body = JPanel(BorderLayout(0, JBUI.scale(8)))
        body.add(hint, BorderLayout.NORTH)
        body.add(result, BorderLayout.CENTER)
        body.add(south, BorderLayout.SOUTH)
        return JPanel(BorderLayout(0, JBUI.scale(10))).apply {
            add(top, BorderLayout.NORTH)
            add(body, BorderLayout.CENTER)
            preferredSize = JBUI.size(520, 280)
        }
    }

    override fun getPreferredFocusedComponent(): JComponent = field

    override fun doValidate() = try { DeviceTarget.parse(field.text); null } catch (_: IllegalArgumentException) {
        com.intellij.openapi.ui.ValidationInfo(XScriptBundle.message("check.badAddress"), field)
    }

    override fun doOKAction() {
        val value = field.text.trim()
        val last = checked
        // second press after a failed check of the same address: save anyway
        if (last != null && last.first == value) { super.doOKAction(); return }
        check(closeIfOk = true)
    }

    /** Runs the check off the EDT and shows each step; with closeIfOk the dialog closes when the phone can be connected. */
    fun check(closeIfOk: Boolean) {
        if (running) return
        running = true
        val value = field.text.trim()
        checkButton.isEnabled = false
        isOKActionEnabled = false
        result.text = XScriptBundle.message("check.running", value)
        ApplicationManager.getApplication().executeOnPooledThread {
            val steps = runConnectCheck(value, status = { t -> DeviceClient(t, 5000, XScriptSettings.get().pairingCode(t)).status(5000) })
            ApplicationManager.getApplication().invokeLater({
                running = false
                checkButton.isEnabled = true
                isOKActionEnabled = true
                if (isDisposed) return@invokeLater
                result.text = checkHtml(steps)
                help.isVisible = steps.any { it.ok == false }
                if (closeIfOk && canConnect(steps) && field.text.trim() == value) { super.doOKAction(); return@invokeLater }
                checked = value to steps
                if (!canConnect(steps)) setOKButtonText(XScriptBundle.message("check.saveAnyway"))
            }, ModalityState.any())
        }
    }
}
