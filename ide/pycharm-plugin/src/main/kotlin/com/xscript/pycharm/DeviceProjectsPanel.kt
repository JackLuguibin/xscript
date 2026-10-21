package com.xscript.pycharm

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.CollectionListModel
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import javax.swing.JList
import javax.swing.ListSelectionModel

/** "Device Projects" tab: the phone's projects with Refresh / Run / Stop / Pull for the selected one (VS Code's projects view). */
class DeviceProjectsPanel(private val project: Project) : SimpleToolWindowPanel(false, true) {
    val model = CollectionListModel<DeviceProjectRow>()
    val list = JBList(model).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        emptyText.text = XScriptBundle.message("projects.empty")
        cellRenderer = object : ColoredListCellRenderer<DeviceProjectRow>() {
            override fun customizeCellRenderer(list: JList<out DeviceProjectRow>, value: DeviceProjectRow?, index: Int,
                                               selected: Boolean, hasFocus: Boolean) {
                value ?: return
                icon = if (value.running) AllIcons.Actions.Execute else AllIcons.Nodes.Folder
                append(value.name)
                if (value.running) append("  " + XScriptBundle.message("projects.running"), SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
        }
    }

    val selected: DeviceProjectRow? get() = list.selectedValue

    private abstract inner class OnSelected(text: String, icon: javax.swing.Icon) : DumbAwareAction(text, null, icon) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        override fun update(e: AnActionEvent) { e.presentation.isEnabled = enabled(selected) }
        open fun enabled(row: DeviceProjectRow?) = row != null
        override fun actionPerformed(e: AnActionEvent) { selected?.let { perform(it) } }
        abstract fun perform(row: DeviceProjectRow)
    }

    val refreshAction = object : DumbAwareAction(XScriptBundle.message("projects.refresh"), null, AllIcons.Actions.Refresh) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        override fun actionPerformed(e: AnActionEvent) = refresh()
    }
    val runAction: DumbAwareAction = object : OnSelected(XScriptBundle.message("projects.run"), AllIcons.Actions.Execute) {
        override fun perform(row: DeviceProjectRow) = XScriptService.get(project).runOnDevice(row.name) { refresh() }
    }
    val stopAction: DumbAwareAction = object : OnSelected(XScriptBundle.message("projects.stop"), AllIcons.Actions.Suspend) {
        override fun enabled(row: DeviceProjectRow?) = row?.running == true
        override fun perform(row: DeviceProjectRow) = XScriptService.get(project).stopProject(row.name) { refresh() }
    }
    val pullAction: DumbAwareAction = object : OnSelected(XScriptBundle.message("projects.pull"), AllIcons.Actions.Download) {
        override fun perform(row: DeviceProjectRow) = XScriptService.get(project).pullProject(row.name)
    }

    init {
        val group = DefaultActionGroup(refreshAction, runAction, stopAction, pullAction)
        val toolbar = ActionManager.getInstance().createActionToolbar("XScriptDeviceProjects", group, false)
        toolbar.targetComponent = list
        setToolbar(toolbar.component)
        setContent(JBScrollPane(list))
        // the toolbar re-evaluates Run / Stop / Pull on UI activity; a selection change alone is not counted as such
        list.addListSelectionListener { com.intellij.ide.ActivityTracker.getInstance().inc() }
    }

    /** Replaces the rows, keeping the selection by name. EDT. */
    fun setRows(rows: List<DeviceProjectRow>) {
        val keep = selected?.name
        model.replaceAll(rows)
        rows.indexOfFirst { it.name == keep }.takeIf { it >= 0 }?.let { list.selectedIndex = it }
    }

    fun refresh() = XScriptService.get(project).loadDeviceProjects { setRows(it) }
}
