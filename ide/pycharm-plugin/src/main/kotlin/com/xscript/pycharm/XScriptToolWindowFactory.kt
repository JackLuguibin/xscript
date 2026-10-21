package com.xscript.pycharm

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** The XScript tool window: the device log with run / stop / connect buttons. */
class XScriptToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val console = XScriptService.get(project).console()
        val panel = SimpleToolWindowPanel(false, true)
        val am = ActionManager.getInstance()
        val group = DefaultActionGroup(listOfNotNull(
            am.getAction("XScript.UploadAndRun"), am.getAction("XScript.Stop"),
            am.getAction("XScript.Connect"), am.getAction("XScript.Settings"),
        ))
        val toolbar = am.createActionToolbar("XScriptLog", group, false)
        toolbar.targetComponent = console.component
        panel.toolbar = toolbar.component
        panel.setContent(console.component)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, XScriptBundle.message("toolwindow.log"), false))
    }
}
