package com.xscript.pycharm

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import java.nio.file.Path
import javax.swing.JComponent

/** Tools | XScript | New XScript Project…: creates a project folder from a template inside the open IDE project. */
class NewProjectAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val dialog = NewProjectDialog(project)
        if (!dialog.showAndGet()) return
        val dir = try {
            Templates.create(Path.of(dialog.parent.text.trim()), dialog.name.text.trim(), dialog.template.item)
        } catch (ex: Exception) {
            Messages.showErrorDialog(project, ex.message ?: ex.toString(), "XScript")
            return
        }
        val vdir = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(dir) ?: return
        vdir.refresh(false, true)
        vdir.findChild("__init__.py")?.let { FileEditorManager.getInstance(project).openFile(it, true) }
    }
}

class NewProjectDialog(project: Project) : DialogWrapper(project) {
    val name = JBTextField("my_script")
    val template = ComboBox(Templates.all.toTypedArray()).apply {
        renderer = SimpleListCellRenderer.create("") { "${it.label}  —  ${it.detail}" }
    }
    val parent = TextFieldWithBrowseButton().apply {
        text = project.basePath ?: System.getProperty("user.home")
        // plain FileChooser: addBrowseFolderListener's signatures differ across 242..251 (one is scheduled for removal)
        addActionListener {
            val start = LocalFileSystem.getInstance().findFileByPath(text.trim())
            FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor(), project, start) { text = it.path }
        }
    }

    init {
        title = XScriptBundle.message("new.title")
        init()
    }

    override fun createCenterPanel(): JComponent = FormBuilder.createFormBuilder()
        .addLabeledComponent(XScriptBundle.message("new.name"), name)
        .addLabeledComponent(XScriptBundle.message("new.template"), template)
        .addLabeledComponent(XScriptBundle.message("new.parent"), parent)
        .panel

    override fun getPreferredFocusedComponent() = name

    override fun doValidate(): ValidationInfo? {
        Templates.validateName(name.text.trim())?.let { return ValidationInfo(it, name) }
        if (parent.text.isBlank()) return ValidationInfo(XScriptBundle.message("new.parent"), parent)
        return null
    }
}
