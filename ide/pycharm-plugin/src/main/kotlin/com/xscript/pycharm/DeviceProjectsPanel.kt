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

/**
 * "Device Projects" tab: the phone's projects with Refresh / Run / Stop / Pull / Open Local Copy for the selected one
 * (VS Code's projects view), Run Selection for the current editor, a right-click menu, and double-click / Enter to open the pulled copy.
 */
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

    val openLocalAction: DumbAwareAction = object : OnSelected(XScriptBundle.message("projects.open"), AllIcons.Actions.MenuOpen) {
        override fun perform(row: DeviceProjectRow) = XScriptService.get(project).openLocalCopy(row.name)
    }
    /** Runs the current editor's selection (or caret line) on the device without leaving this tab. */
    val evalAction = object : DumbAwareAction(XScriptBundle.message("projects.eval"), null, AllIcons.Actions.RunToCursor) {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        override fun update(e: AnActionEvent) { e.presentation.isEnabled = editor() != null }
        override fun actionPerformed(e: AnActionEvent) { editor()?.let { EvalSelectionAction.evalIn(project, it) } }
        private fun editor() = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).selectedTextEditor
    }
    val copyNameAction: DumbAwareAction = object : OnSelected(XScriptBundle.message("projects.copyName"), AllIcons.Actions.Copy) {
        override fun perform(row: DeviceProjectRow) =
            com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(java.awt.datatransfer.StringSelection(row.name))
    }

    /** Right-click menu for a row. */
    val popupGroup = DefaultActionGroup(runAction, stopAction, pullAction, openLocalAction).apply {
        addSeparator(); add(evalAction); addSeparator(); add(copyNameAction); add(refreshAction)
    }

    init {
        val group = DefaultActionGroup(refreshAction, runAction, stopAction, pullAction, openLocalAction, evalAction)
        val toolbar = ActionManager.getInstance().createActionToolbar("XScriptDeviceProjects", group, false)
        toolbar.targetComponent = list
        setToolbar(toolbar.component)
        setContent(JBScrollPane(list))
        // the toolbar re-evaluates Run / Stop / Pull on UI activity; a selection change alone is not counted as such
        list.addListSelectionListener { com.intellij.ide.ActivityTracker.getInstance().inc() }
        object : com.intellij.ui.DoubleClickListener() {
            override fun onDoubleClick(event: java.awt.event.MouseEvent): Boolean {
                val i = list.locationToIndex(event.point)
                if (i < 0 || !list.getCellBounds(i, i).contains(event.point)) return false
                list.selectedIndex = i
                openSelected()
                return true
            }
        }.installOn(list)
        list.registerKeyboardAction({ openSelected() }, javax.swing.KeyStroke.getKeyStroke(java.awt.event.KeyEvent.VK_ENTER, 0),
            javax.swing.JComponent.WHEN_FOCUSED)
        list.addMouseListener(object : com.intellij.ui.PopupHandler() {
            override fun invokePopup(comp: java.awt.Component, x: Int, y: Int) {
                val i = list.locationToIndex(java.awt.Point(x, y))
                if (i >= 0 && list.getCellBounds(i, i).contains(x, y)) list.selectedIndex = i
                ActionManager.getInstance().createActionPopupMenu("XScriptDeviceProjectsPopup", popupGroup)
                    .apply { setTargetComponent(list) }.component.show(comp, x, y)
            }
        })
    }

    /** Double-click / Enter: open the pulled copy of the selected project (or offer to pull it). */
    fun openSelected() { selected?.let { XScriptService.get(project).openLocalCopy(it.name) } }

    /** Replaces the rows, keeping the selection by name. EDT. */
    fun setRows(rows: List<DeviceProjectRow>) {
        val keep = selected?.name
        model.replaceAll(rows)
        rows.indexOfFirst { it.name == keep }.takeIf { it >= 0 }?.let { list.selectedIndex = it }
    }

    fun refresh() = XScriptService.get(project).loadDeviceProjects { setRows(it) }
}
