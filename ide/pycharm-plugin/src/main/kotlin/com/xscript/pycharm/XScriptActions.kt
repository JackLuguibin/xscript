package com.xscript.pycharm

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.ui.Messages

/** Uploads the XScript project that contains the current file (or the IDE project) and runs it on the device. */
class UploadAndRunAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val svc = XScriptService.get(project)
        val root = svc.projectRoot(e.getData(CommonDataKeys.VIRTUAL_FILE))
        if (root == null) {
            Messages.showWarningDialog(project, XScriptBundle.message("run.noProject"), "XScript")
            return
        }
        svc.uploadAndRun(root)
    }
}

class StopAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { XScriptService.get(it).stop() } }
}

/** Asks for the device address, saves it and checks the connection (asking for the pairing code if the phone wants one). */
class ConnectAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = XScriptSettings.get()
        val value = Messages.showInputDialog(project, XScriptBundle.message("connect.prompt"), "XScript", null, s.device,
            object : com.intellij.openapi.ui.InputValidator {
                override fun checkInput(v: String?) = try { DeviceTarget.parse(v); true } catch (_: IllegalArgumentException) { false }
                override fun canClose(v: String?) = checkInput(v)
            }) ?: return
        s.device = value
        XScriptService.get(project).testConnection()
    }
}

class OpenSettingsAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        ShowSettingsUtil.getInstance().showSettingsDialog(e.project, XScriptConfigurable::class.java)
    }
}
