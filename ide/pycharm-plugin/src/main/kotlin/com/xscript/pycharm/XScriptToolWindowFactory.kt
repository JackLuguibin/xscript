package com.xscript.pycharm

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** The XScript tool window: the device log with run / stop / connect buttons, and the Device Projects list. */
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
        val cf = ContentFactory.getInstance()
        toolWindow.contentManager.addContent(cf.createContent(panel, XScriptBundle.message("toolwindow.log"), false))
        val projects = DeviceProjectsPanel(project)
        toolWindow.contentManager.addContent(cf.createContent(projects, XScriptBundle.message("toolwindow.projects"), false))
        // load the list the first time the tab is shown (not at IDE start: the phone may be off)
        toolWindow.contentManager.addContentManagerListener(object : com.intellij.ui.content.ContentManagerListener {
            private var loaded = false
            override fun selectionChanged(event: com.intellij.ui.content.ContentManagerEvent) {
                if (!loaded && event.content.component === projects && event.operation == com.intellij.ui.content.ContentManagerEvent.ContentOperation.add) {
                    loaded = true
                    projects.refresh()
                }
            }
        })
    }
}
